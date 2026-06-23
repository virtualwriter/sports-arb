export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

export type DeepSeekResult = {
  text: string;
  model: string;
  calledAt: string;
};

export async function requestDeepSeek(messages: LlmMessage[], options: { maxTokens?: number; temperature?: number } = {}): Promise<DeepSeekResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");
  const model = process.env.LLM_MODEL ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SPORTS_ARB_LLM_TIMEOUT_MS ?? 90_000));
  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
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
    return {
      text: data.choices?.[0]?.message?.content?.trim() ?? "",
      model,
      calledAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}
