/**
 * 감시용 봉 조회 (PLAN §40) — 시장별로 나눠 부른다. **닫힌 봉만** 돌려준다 (봉 마감 판정의 전제).
 *
 *   binance  공개 klines (키 없음). 10분봉은 Binance 에 없어 5분봉 두 개를 묶는다
 *   krx · us 트리거 주인의 증권 키로 일봉 → 일봉·주봉 (stock-bars.ts)
 */
import type { BrokerAccess } from "../portfolio.ts";
import { barCloseAt, CRYPTO_STEP, cryptoBarStart, isStock } from "./market-time.ts";
import { fetchStockBars } from "./stock-bars.ts";
import type { Condition, Interval, WatchBar } from "./types.ts";

const BINANCE = "https://api.binance.com";
const TIMEOUT_MS = 10_000;
export const MAX_BARS = 1000;

export class BarsError extends Error {}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** Binance 가 직접 주지 않는 간격 → 묶을 원본 간격 */
const BINANCE_SOURCE: Partial<Record<Interval, { from: Interval; n: number }>> = { "10m": { from: "5m", n: 2 } };

/** 같은 상위 봉에 속하는 봉끼리 묶는다 (코인 — UTC 시계 경계) */
export function aggregate(bars: WatchBar[], interval: Interval): WatchBar[] {
	const out: WatchBar[] = [];
	for (const b of bars) {
		const t = cryptoBarStart(b.t, interval);
		const last = out.at(-1);
		if (last && last.t === t) {
			last.high = Math.max(last.high, b.high);
			last.low = Math.min(last.low, b.low);
			last.close = b.close;
			last.volume += b.volume;
		} else out.push({ ...b, t });
	}
	return out;
}

export async function fetchBinanceBars(symbol: string, interval: Interval, limit: number, opts: { fetch?: FetchLike; now?: number } = {}): Promise<WatchBar[]> {
	const f = opts.fetch ?? (fetch as FetchLike);
	const src = BINANCE_SOURCE[interval];
	const apiInterval = src?.from ?? interval;
	// 묶을 때는 원본을 n 배 + 경계 한 봉 더
	const n = Math.min(Math.max((src ? limit * src.n + src.n : limit), 1), MAX_BARS);
	const url = `${BINANCE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${apiInterval}&limit=${n}`;
	let res: Response;
	try {
		res = await f(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
	} catch (err) {
		throw new BarsError(`Binance 봉 조회 실패: ${err instanceof Error ? err.message : String(err)}`);
	}
	const body = (await res.json().catch(() => null)) as unknown;
	if (!res.ok || !Array.isArray(body)) {
		const msg = (body as { msg?: string } | null)?.msg;
		throw new BarsError(res.status === 400 && msg?.includes("symbol") ? `Binance 에 없는 종목입니다: ${symbol}` : `Binance 봉 조회 실패 (HTTP ${res.status})${msg ? `: ${msg}` : ""}`);
	}
	const now = opts.now ?? Date.now();
	// [openTime, open, high, low, close, volume, closeTime, ...] — 가격은 문자열
	let bars = (body as unknown[][]).map((k) => ({ t: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }));
	bars = bars.filter((b) => Number.isFinite(b.t) && Number.isFinite(b.close));
	if (src) {
		// 앞쪽의 잘린 묶음(원본 봉이 n 개가 안 되는 첫 봉)은 버린다
		const first = bars[0];
		const agg = aggregate(bars, interval);
		if (first && cryptoBarStart(first.t, interval) !== first.t) agg.shift();
		bars = agg;
	}
	return bars.filter((b) => b.t + CRYPTO_STEP[interval] <= now).slice(-limit);
}

export interface WatchBarsOptions {
	now?: number;
	/** 주식 — 트리거 주인의 증권 키 */
	access?: BrokerAccess;
	fetch?: FetchLike;
}

/** 조건의 시장·간격에 맞는 닫힌 봉 (오래된 순, 최근 limit 개) */
export async function fetchWatchBars(c: Condition, limit: number, opts: WatchBarsOptions = {}): Promise<WatchBar[]> {
	const now = opts.now ?? Date.now();
	if (!isStock(c.market.venue)) return fetchBinanceBars(c.market.symbol, c.interval, limit, { now, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
	if (!opts.access) throw new BarsError("주식 감시에는 증권 키가 필요합니다 (설정 → 연결 → 증권)");
	try {
		return (await fetchStockBars(opts.access, c, limit, now)).filter((b) => barCloseAt(c, b.t) <= now);
	} catch (err) {
		throw new BarsError(err instanceof Error ? err.message : String(err));
	}
}
