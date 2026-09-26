/**
 * 감시용 봉 조회 (PLAN §40). 1단계는 Binance 현물 klines (공개 API, 키 없음, 24시간).
 *
 * **닫힌 봉만** 돌려준다 — 마지막 봉이 아직 진행 중이면 뺀다 (봉 마감 판정의 전제).
 */
import { INTERVAL_MS, type Interval, type WatchBar } from "./types.ts";

const BINANCE = "https://api.binance.com";
const TIMEOUT_MS = 10_000;
export const MAX_BARS = 1000;

export class BarsError extends Error {}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export async function fetchBinanceBars(
	symbol: string,
	interval: Interval,
	limit: number,
	opts: { fetch?: FetchLike; now?: number } = {},
): Promise<WatchBar[]> {
	const f = opts.fetch ?? (fetch as FetchLike);
	const n = Math.min(Math.max(limit, 1), MAX_BARS);
	const url = `${BINANCE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${n}`;
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
	const step = INTERVAL_MS[interval];
	// [openTime, open, high, low, close, volume, closeTime, ...] — 가격은 문자열
	return (body as unknown[][])
		.map((k) => ({ t: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }))
		.filter((b) => Number.isFinite(b.t) && Number.isFinite(b.close) && b.t + step <= now);
}

/** t 가 속한 봉의 시작 (UTC 기준 — Binance 봉 경계와 같다. 일봉은 UTC 00:00 = KST 09:00) */
export function barStart(t: number, interval: Interval): number {
	const step = INTERVAL_MS[interval];
	return Math.floor(t / step) * step;
}

/** 지금 기준 마지막으로 **닫힌** 봉의 시작 */
export function lastClosedBarStart(now: number, interval: Interval): number {
	return barStart(now, interval) - INTERVAL_MS[interval];
}
