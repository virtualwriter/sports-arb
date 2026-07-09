import type { Candidate, GammaEvent, MarketQuote } from "./monotonic-arb-core.js";
import type { AdapterMode, MarketType, SportGender, SportId } from "./types.js";

export type SportAdapter = {
  sportId: SportId;
  displayName: string;
  adapterVersion: string;
  mode: AdapterMode;
  gammaTags: string[];
  slugPatterns: RegExp[];
  defaultGender: SportGender;
  middleWidthUnit: "goals" | "runs" | "points" | "games" | "strokes" | "rounds" | "unknown";
  classifyMarket: (quote: MarketQuote) => MarketType;
  lineFamily: (candidate: Candidate) => string;
};

function slugMatches(adapter: SportAdapter, slug: string): boolean {
  return adapter.slugPatterns.some((pattern) => pattern.test(slug));
}

function lowerText(...values: Array<string | undefined | null>): string {
  return values.filter(Boolean).join(" ").toLowerCase();
}

function basicMarketClassifier(quote: MarketQuote): MarketType {
  const text = lowerText(quote.question, quote.description, quote.ladderKey);
  if (text.includes("team-total")) return "team_total";
  if (text.includes("spread")) return "spread";
  if (text.includes("total")) return "game_total";
  if (text.includes("match")) return "match_total";
  return "unknown";
}

function soccerMarketClassifier(quote: MarketQuote): MarketType {
  const text = lowerText(quote.question, quote.description, quote.ladderKey);
  if (text.includes("team-total")) return "team_total";
  if (text.includes("spread")) return "spread";
  if (text.includes("total")) return "match_total";
  return "unknown";
}

function tennisMarketClassifier(quote: MarketQuote): MarketType {
  const text = lowerText(quote.question, quote.description, quote.ladderKey);
  if (text.includes(":total:match") || /\bmatch\s+o\/u\b/i.test(quote.question)) return "match_total";
  return basicMarketClassifier(quote);
}

function lineFamily(candidate: Candidate): string {
  return `${candidate.broad.strike}-${candidate.narrow.strike}`;
}

export const SPORT_ADAPTERS: SportAdapter[] = [
  {
    sportId: "MLB",
    displayName: "MLB",
    adapterVersion: "mlb-v1",
    mode: "live_enabled",
    gammaTags: ["mlb", "baseball"],
    slugPatterns: [/^mlb-/i, /major-league-baseball/i],
    defaultGender: "men",
    middleWidthUnit: "runs",
    classifyMarket: basicMarketClassifier,
    lineFamily,
  },
  {
    sportId: "SOCCER",
    displayName: "Soccer",
    adapterVersion: "soccer-v1",
    mode: "live_enabled",
    gammaTags: ["soccer", "mls", "fifa", "uefa", "uel", "europa-conference-league"],
    slugPatterns: [/^mls-/i, /^fifwc-/i, /^uel-/i, /^col-[a-z0-9]+-[a-z0-9]+-\d{4}/i, /soccer/i, /world-cup/i, /fifa/i, /uefa/i],
    defaultGender: "unknown",
    middleWidthUnit: "goals",
    classifyMarket: soccerMarketClassifier,
    lineFamily,
  },
  {
    // Fight rounds totals ("O/U 2.5 Rounds") — shadow only until a
    // statistically significant backtest shape emerges.
    sportId: "UFC",
    displayName: "UFC",
    adapterVersion: "ufc-v1",
    mode: "shadow_only",
    gammaTags: ["ufc"],
    slugPatterns: [/^ufc-/i],
    defaultGender: "unknown",
    middleWidthUnit: "rounds",
    classifyMarket: (quote) => (/\bO\/U\s+[0-9]+(?:\.5)?\s+Rounds\b/i.test(quote.question) ? "game_total" : "unknown"),
    lineFamily,
  },
  {
    sportId: "COLLEGE_BASEBALL",
    displayName: "College Baseball",
    adapterVersion: "college-baseball-v1",
    mode: "shadow_only",
    gammaTags: ["college-baseball", "ncaa-baseball", "baseball"],
    slugPatterns: [/college-baseball/i, /ncaa-baseball/i],
    defaultGender: "men",
    middleWidthUnit: "runs",
    classifyMarket: basicMarketClassifier,
    lineFamily,
  },
  {
    sportId: "TENNIS",
    displayName: "Tennis",
    adapterVersion: "tennis-v1",
    mode: "shadow_only",
    gammaTags: ["tennis", "atp", "itf"],
    slugPatterns: [/tennis/i, /^atp-/i, /^itf-/i],
    defaultGender: "unknown",
    middleWidthUnit: "games",
    classifyMarket: tennisMarketClassifier,
    lineFamily,
  },
  {
    sportId: "WOMENS_TENNIS",
    displayName: "Women's Tennis",
    adapterVersion: "womens-tennis-v1",
    mode: "shadow_only",
    gammaTags: ["wta", "women-tennis", "womens-tennis"],
    slugPatterns: [/^wta-/i, /womens?-tennis/i],
    defaultGender: "women",
    middleWidthUnit: "games",
    classifyMarket: tennisMarketClassifier,
    lineFamily,
  },
  {
    sportId: "GOLF",
    displayName: "Golf",
    adapterVersion: "golf-v1",
    mode: "discovery_only",
    gammaTags: ["golf", "pga"],
    slugPatterns: [/golf/i, /^pga-/i],
    defaultGender: "unknown",
    middleWidthUnit: "strokes",
    classifyMarket: basicMarketClassifier,
    lineFamily,
  },
  {
    sportId: "NCAAF",
    displayName: "College Football",
    adapterVersion: "ncaaf-v1",
    mode: "shadow_only",
    gammaTags: ["college-football", "ncaaf", "ncaa-football"],
    slugPatterns: [/college-football/i, /^ncaaf-/i, /ncaa-football/i],
    defaultGender: "men",
    middleWidthUnit: "points",
    classifyMarket: basicMarketClassifier,
    lineFamily,
  },
  {
    sportId: "NFL",
    displayName: "NFL",
    adapterVersion: "nfl-v1",
    mode: "shadow_only",
    gammaTags: ["nfl", "football"],
    slugPatterns: [/^nfl-/i, /super-bowl/i],
    defaultGender: "men",
    middleWidthUnit: "points",
    classifyMarket: basicMarketClassifier,
    lineFamily,
  },
  {
    sportId: "WNBA",
    displayName: "WNBA",
    adapterVersion: "wnba-v1",
    mode: "shadow_only",
    gammaTags: ["wnba", "basketball"],
    slugPatterns: [/^wnba-/i],
    defaultGender: "women",
    middleWidthUnit: "points",
    classifyMarket: basicMarketClassifier,
    lineFamily,
  },
];

export function adapterForSlug(slug: string): SportAdapter | null {
  return SPORT_ADAPTERS.find((adapter) => slugMatches(adapter, slug)) ?? null;
}

export function adapterForEvent(event: Pick<GammaEvent, "slug" | "title">): SportAdapter | null {
  const slug = event.slug ?? "";
  return adapterForSlug(slug)
    ?? SPORT_ADAPTERS.find((adapter) => lowerText(event.title).includes(adapter.displayName.toLowerCase()))
    ?? null;
}

export function adapterForCandidate(candidate: Candidate): SportAdapter | null {
  return adapterForSlug(candidate.eventSlug);
}

export function enabledDiscoveryAdapters(): SportAdapter[] {
  return SPORT_ADAPTERS.filter((adapter) => adapter.mode !== "discovery_only" || process.env.SPORTS_ARB_INCLUDE_DISCOVERY_ONLY === "1");
}
