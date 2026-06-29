export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

export type DeepSeekResult = {
  text: string;
  model: string;
  calledAt: string;
};

// Generic LLM client that prefers DeepSeek when DEEPSEEK_API_KEY is set,
// otherwise falls back to Anthropic. The function name is retained for
// backward compatibility with callers that pre-date the multi-provider split.
export async function requestDeepSeek(messages: LlmMessage[], options: { maxTokens?: number; temperature?: number } = {}): Promise<DeepSeekResult> {
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (deepseekKey) return callDeepSeek(deepseekKey, messages, options);
  if (anthropicKey) return callAnthropic(anthropicKey, messages, options);
  throw new Error("Missing LLM credentials: set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY");
}

async function callDeepSeek(apiKey: string, messages: LlmMessage[], options: { maxTokens?: number; temperature?: number }): Promise<DeepSeekResult> {
  const model = process.env.LLM_MODEL ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SPORTS_ARB_LLM_TIMEOUT_MS ?? 90_000));
  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: options.maxTokens ?? Number(process.env.SPORTS_ARB_LLM_MAX_TOKENS ?? 1800),
        temperature: options.temperature ?? 0.2,
        stream: false,
      }),
    });
    if (!response.ok) throw new Error(`DeepSeek API ${response.status}: ${await response.text()}`);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return { text: data.choices?.[0]?.message?.content?.trim() ?? "", model, calledAt: new Date().toISOString() };
  } finally {
    clearTimeout(timeout);
  }
}

async function callAnthropic(apiKey: string, messages: LlmMessage[], options: { maxTokens?: number; temperature?: number }): Promise<DeepSeekResult> {
  const model = process.env.LLM_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest";
  // Anthropic separates a top-level system prompt from the user/assistant turn
  // sequence, so we coalesce all "system" messages into the system field.
  const systemParts: string[] = [];
  const conversation: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    if (m.role === "system") systemParts.push(m.content);
    else conversation.push({ role: m.role, content: m.content });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SPORTS_ARB_LLM_TIMEOUT_MS ?? 90_000));
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        system: systemParts.join("\n\n") || undefined,
        messages: conversation,
        max_tokens: options.maxTokens ?? Number(process.env.SPORTS_ARB_LLM_MAX_TOKENS ?? 1800),
        temperature: options.temperature ?? 0.2,
      }),
    });
    if (!response.ok) throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
    const data = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    const text = (data.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    return { text, model, calledAt: new Date().toISOString() };
  } finally {
    clearTimeout(timeout);
  }
}
