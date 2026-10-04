/**
 * 코인 지표용 봉 (market_technical · market: "binance").
 *
 * 공개 klines 라 키가 필요 없다. 감시용 fetchBinanceBars 와 달리 **진행 중인 봉을 남긴다** —
 * 주봉에서 마감 봉만 쓰면 "현재가"가 지난주 종가가 된다. 주식 차트(KIS 일봉)도 장중엔 오늘 봉을 포함한다.
 * 봉 경계는 Binance 기준 UTC 0시 (주봉은 월요일 0시 UTC = 한국 09:00).
 */
import type { Bar } from "./indicators.ts";
import { fetchKlines } from "./triggers/bars.ts";

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export type CryptoPeriod = "D" | "W" | "M";

const KLINE_INTERVAL: Record<CryptoPeriod, string> = { D: "1d", W: "1w", M: "1M" };
const STEP_MS: Record<"D" | "W", number> = { D: 86_400_000, W: 7 * 86_400_000 };

/** MA60·MACD(26+9)·ATR(14) 가 모두 나오고 남는 양 — 한 페이지(최대 1,000) 안이다 */
const CHART_BARS = 200;

/** 길이가 긴 것부터 — FDUSD 를 USD 로, USDT 를 DT 로 자르지 않게 */
const QUOTES = ["FDUSD", "USDT", "USDC", "TUSD", "BUSD", "BTC", "ETH", "BNB", "EUR", "TRY", "BRL", "JPY"];

export interface CryptoChart {
	symbol: string;
	/** 호가 자산 (USDT 등). 알 수 없으면 "" */
	quote: string;
	bars: Bar[];
	/** 마지막 봉이 아직 닫히지 않았는가 */
	lastOpen: boolean;
}

/** "eth/usdt", "ETH-USDT" → "ETHUSDT" */
export function normalizeCryptoSymbol(raw: string): string {
	return raw.trim().toUpperCase().replace(/[\s/_-]/g, "");
}

export function quoteAsset(symbol: string): string {
	return QUOTES.find((q) => symbol.endsWith(q) && symbol.length > q.length) ?? "";
}

/** 봉 시작 시각(UTC) → YYYYMMDD. 지표 Bar 계약이 날짜 문자열이다. */
function ymd(t: number): string {
	return new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
}

function closesAt(t: number, period: CryptoPeriod): number {
	if (period !== "M") return t + STEP_MS[period];
	const d = new Date(t);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export async function fetchCryptoChart(
	rawSymbol: string,
	period: CryptoPeriod,
	opts: { fetch?: FetchLike; now?: number } = {},
): Promise<CryptoChart> {
	const symbol = normalizeCryptoSymbol(rawSymbol);
	const raw = await fetchKlines(symbol, KLINE_INTERVAL[period], CHART_BARS, opts.fetch ? { fetch: opts.fetch } : {});
	const now = opts.now ?? Date.now();
	const last = raw.at(-1);
	return {
		symbol,
		quote: quoteAsset(symbol),
		bars: raw.map((b) => ({ date: ymd(b.t), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
		lastOpen: last !== undefined && closesAt(last.t, period) > now,
	};
}

/**
 * 코인 가격 표기 — 1 이상은 소수 둘째 자리, 그 아래는 유효숫자 4자리.
 * usd() 처럼 둘째 자리에서 자르면 저가 코인의 ATR 이 0 으로 보인다.
 */
export function coinPrice(n: number, quote: string): string {
	const abs = Math.abs(n);
	const body =
		abs >= 1 || abs === 0
			? n.toLocaleString("en-US", { maximumFractionDigits: 2 })
			: n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
	return quote ? `${body} ${quote}` : body;
}
