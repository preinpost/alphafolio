import {
  FLAVOR_LINES,
  THINKING_LINES,
  type FlavorLocale,
  type ThinkingState,
} from "../i18n/flavorLines";

/** 채팅에 노출하는 툴 장르. 원문 툴 이름은 UI에 쓰지 않는다. */
export type ToolFlavor =
  | "quote"
  | "chart"
  | "rumor"
  | "tome"
  | "market"
  | "pulse"
  | "vault"
  | "order"
  | "omen"
  | "grimoire";

export type ToolFlavorState = "running" | "done" | "error";

const EXACT: Record<string, ToolFlavor> = {
  kis_domestic_price: "quote",
  kis_overseas_price: "quote",
  broker_price: "quote",
  toss_price: "quote",
  twelve_price: "quote",
  finnhub_price: "quote",
  coingecko_price: "quote",
  binance_price: "quote",

  kis_domestic_chart: "chart",
  kis_overseas_chart: "chart",
  broker_chart: "chart",
  broker_chart_card: "chart",
  toss_chart: "chart",
  twelve_chart: "chart",
  finnhub_chart: "chart",
  coingecko_chart: "chart",
  binance_chart: "chart",
  kis_technical: "chart",

  naver_news_search: "rumor",
  finnhub_news: "rumor",

  kis_research: "tome",
  finnhub_fundamentals: "tome",

  toss_market: "market",
  coingecko_market: "market",
  coingecko_coin: "market",
  twelve_exchange_rate: "market",

  kis_realtime: "pulse",

  toss_balance: "vault",
  binance_account: "vault",

  toss_order: "order",
  toss_orders: "order",
  toss_conditional: "order",
  binance_order: "order",
  binance_orders: "order",
  binance_orderlist: "order",
  binance_market: "market",

  kis_derivatives: "omen",
  binance_futures: "omen",

  twelve_search: "grimoire",
  coingecko_search: "grimoire",
  kis_api: "grimoire",
  kis_list_apis: "grimoire",
};

/** 알려진 툴은 정확 매칭, 그 외는 이름 패턴으로 장르만 추정. */
export function toolFlavor(name: string): ToolFlavor {
  const key = name.trim();
  if (EXACT[key]) return EXACT[key];

  const n = key.toLowerCase();
  if (n.includes("news")) return "rumor";
  if (n.includes("price") || n.includes("quote")) return "quote";
  if (n.includes("chart") || n.includes("technical") || n.includes("candle")) return "chart";
  if (n.includes("research") || n.includes("fundamental") || n.includes("consensus")) return "tome";
  if (n.includes("realtime") || n.includes("live")) return "pulse";
  if (n.includes("balance") || n.includes("account") || n.includes("holding")) return "vault";
  if (n.includes("order") || n.includes("trade")) return "order";
  if (n.includes("derivative") || n.includes("option") || n.includes("future")) return "omen";
  if (n.includes("market") || n.includes("ranking") || n.includes("exchange")) return "market";
  return "grimoire";
}

/** 같은 seed면 같은 문구. 스트리밍 중 깜빡임 방지. */
function pickLine(lines: readonly string[], seed: string): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const index = (hash >>> 0) % lines.length;
  return lines[index] ?? lines[0] ?? "";
}

function localeOrEn(locale: string): FlavorLocale {
  if (locale === "ko" || locale === "en" || locale === "ja" || locale === "zh") return locale;
  return "en";
}

export function pickToolFlavorLine(
  name: string,
  state: ToolFlavorState,
  seed: string,
  locale: string,
): string {
  const catalog = FLAVOR_LINES[localeOrEn(locale)][toolFlavor(name)][state];
  return pickLine(catalog, `${seed}:${state}`);
}

export function pickThinkingLine(state: ThinkingState, seed: string, locale: string): string {
  const catalog = THINKING_LINES[localeOrEn(locale)][state];
  return pickLine(catalog, `${seed}:${state}`);
}
