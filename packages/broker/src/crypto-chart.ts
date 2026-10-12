/**
 * 코인 지표용 봉 (market_technical · market: "binance").
 *
 * 공개 klines 라 키가 필요 없다. 감시용 fetchBinanceBars 와 달리 **진행 중인 봉을 남긴다** —
 * 주봉에서 마감 봉만 쓰면 "현재가"가 지난주 종가가 된다. 주식 차트(KIS 일봉)도 장중엔 오늘 봉을 포함한다.
 * 봉 경계는 Binance 기준 UTC 0시 (주봉은 월요일 0시 UTC = 한국 09:00).
 *
 * 현물에 없는 심볼은 USDⓈ-M 선물에서 다시 찾는다.
 * 실측 사고 (2026-10-12): KORUUSDT(미국 주식 기반 TradFi 무기한)를 현물에서만 찾아 "바이낸스에 없는 심볼"이라고 답했다.
 */
import { contractText, futuresMark, futuresRules, type FuturesMark, type FuturesRules } from "./binance/futures.ts";
import type { Bar } from "./indicators.ts";
import { BarsError, fetchKlines, type BinanceVenue } from "./triggers/bars.ts";

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
	/** 봉을 받은 곳 — spot 현물 · futures USDⓈ-M 선물 */
	venue: BinanceVenue;
	/** 호가 자산 (USDT 등). 알 수 없으면 "" */
	quote: string;
	bars: Bar[];
	/** 마지막 봉이 아직 닫히지 않았는가 */
	lastOpen: boolean;
}

/** "eth/usdt", "ETH-USDT" → "ETHUSDT" */
export function normalizeCryptoSymbol(raw: string): string {
	return raw.trim().toUpperCase().replace(/[\s/_.-]/g, "");
}

/**
 * 차트 사이트의 무기한 표기 — "KORUUSDT.P" · "koruusdtp" · "BTCUSDT-PERP" → 심볼 + perp.
 * USDT·USDC 뒤에 붙은 P·PERP 만 떼다 (그런 현물 심볼은 없다).
 */
export function parseCryptoSymbol(raw: string): { symbol: string; perp: boolean } {
	const s = normalizeCryptoSymbol(raw);
	const m = /^(.+(?:USDT|USDC))(?:PERP|P)$/.exec(s);
	return m ? { symbol: m[1] as string, perp: true } : { symbol: s, perp: false };
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

/**
 * venue 를 정하면 그곳만. 비우면 현물 → (없는 심볼이면) 선물 순서 — 둘 다 있는 ETHUSDT 는 현물이다.
 * "KORUUSDT.P" 처럼 무기한 표기가 붙으면 선물이 기본.
 */
export async function fetchCryptoChart(
	rawSymbol: string,
	period: CryptoPeriod,
	opts: { fetch?: FetchLike; now?: number; venue?: BinanceVenue } = {},
): Promise<CryptoChart> {
	const { symbol, perp } = parseCryptoSymbol(rawSymbol);
	const get = (venue: BinanceVenue) =>
		fetchKlines(symbol, KLINE_INTERVAL[period], CHART_BARS, { venue, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
	let venue: BinanceVenue = opts.venue ?? (perp ? "futures" : "spot");
	let raw;
	try {
		raw = await get(venue);
	} catch (err) {
		if (opts.venue || venue === "futures" || !(err instanceof BarsError && err.unknownSymbol)) throw err;
		venue = "futures";
		raw = await get(venue).catch((e: unknown) => {
			throw e instanceof BarsError && e.unknownSymbol ? new BarsError(`Binance 현물·선물 어디에도 없는 종목입니다: ${symbol}`, true) : e;
		});
	}
	const now = opts.now ?? Date.now();
	const last = raw.at(-1);
	return {
		symbol,
		venue,
		quote: quoteAsset(symbol),
		bars: raw.map((b) => ({ date: ymd(b.t), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
		lastOpen: last !== undefined && closesAt(last.t, period) > now,
	};
}

/** 봉 사이 종가가 이 배수 넘게 뛰면 가격 단위가 바뀐 것으로 본다 (하루 -80% · +400%) */
const REBASE_RATIO = 5;

/**
 * 가격 단위가 바뀐 마지막 지점 뒤의 봉만 — TradFi 선물은 주식 분할 등이 있어도 지난 봉을 고치지 않는다.
 * 바뀐 봉은 옛 단위로 열려 새 단위로 닫혀서(고가·저가가 섞인다) 그 봉까지 버린다. 코인에는 쓰지 않는다 (진짜 -80% 도 있다).
 */
export function cutAtRebase(bars: Bar[]): { bars: Bar[]; date: string | null } {
	for (let i = bars.length - 1; i > 0; i--) {
		const r = (bars[i] as Bar).close / (bars[i - 1] as Bar).close;
		if (r > REBASE_RATIO || r < 1 / REBASE_RATIO) return { bars: bars.slice(i + 1), date: (bars[i] as Bar).date };
	}
	return { bars, date: null };
}

export interface CryptoAnalysisChart extends CryptoChart {
	/** 선물이면 종목 규칙·표시가격 (각각 조회 실패면 null) */
	futures: { rules: FuturesRules | null; mark: FuturesMark | null } | null;
	/** 출처·계약·표시가격·펀딩비·단위 변경 — 한 항목씩 (지표 카드 note · 타점 notes) */
	notes: string[];
}

/**
 * 지표·타점 툴 공용 — 봉 + 선물이면 계약 종류·표시가격·펀딩비, TradFi 는 가격 단위가 바뀐 봉 뒤만.
 * 선물 부가 정보는 공개 조회라 키가 필요 없고, 실패해도 봉은 돌려준다 (해당 항목만 빠진다).
 */
export async function fetchCryptoAnalysisChart(symbol: string, period: CryptoPeriod, venue?: BinanceVenue): Promise<CryptoAnalysisChart> {
	const chart = await fetchCryptoChart(symbol, period, venue ? { venue } : {}).catch((err: unknown) => {
		// "ETH" 처럼 코인 이름만 온 경우 — 모델이 심볼을 고쳐 다시 부르게 한다
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(quoteAsset(parseCryptoSymbol(symbol).symbol) ? msg : `${msg} — Binance 심볼은 호가 자산까지 붙인다 (ETHUSDT)`);
	});
	if (chart.venue !== "futures") return { ...chart, futures: null, notes: ["Binance 현물 기준"] };
	const [rules, mark] = await Promise.all([futuresRules(chart.symbol).catch(() => null), futuresMark(chart.symbol).catch(() => null)]);
	const notes = [`Binance USDⓈ-M 선물 기준${rules ? ` (${contractText(rules)})` : ""}`];
	if (mark) notes.push(...markLines(mark, chart.quote));
	let bars = chart.bars;
	// TradFi 는 분할 등으로 가격 단위가 바뀌어도 지난 봉을 고치지 않는다 (실측: KORUUSDT 2026-07-15 497 → 21)
	if (rules?.contractType === "TRADIFI_PERPETUAL") {
		const cut = cutAtRebase(bars);
		if (cut.date) {
			bars = cut.bars;
			notes.push(`${cut.date} 봉에서 가격 단위가 바뀌어(분할·계약 변경 추정, Binance 는 지난 봉을 고치지 않는다) 그 뒤 ${bars.length}봉만 썼다`);
		}
	}
	return { ...chart, bars, futures: { rules, mark }, notes };
}

/** 선물 표시가격(익절·손절 기준)·펀딩비 */
function markLines(mark: FuturesMark, quote: string): string[] {
	const rate = Number(mark.fundingRate) * 100;
	const next =
		mark.nextFundingTime > 0
			? ` (다음 ${new Date(mark.nextFundingTime).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false })} KST)`
			: "";
	return [`표시가격 ${coinPrice(Number(mark.markPrice), quote)}`, `펀딩비 ${rate >= 0 ? "+" : ""}${rate.toFixed(4)}%${next}`];
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
