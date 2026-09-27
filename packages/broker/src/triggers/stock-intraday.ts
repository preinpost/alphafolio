/**
 * 주식 분·시간봉 (PLAN §40 ②③). 트리거 주인의 증권 키로 원본 분봉을 받아 **장 기준으로 묶는다** (market-time.stockBucket).
 *
 * 원본 (실데이터로 확인한 것 — spike/12-watch-intraday.ts):
 *   KIS 미장  해외주식분봉(HHDFS76950200). 분 간격(NMIN)을 바로 주고, 프리·애프터(뉴욕 04:00–20:00)까지 들어 있다. 봉 시각은 현지 기준 봉 시작이다.
 *             한 번에 120개씩 받는다. KEYB(현지 YYYYMMDDHHMMSS, 그 시각 포함)로 과거로 이어 받으며 약 1개월치가 있다.
 *             간격: 30분 이하면 그 간격 그대로, 1시간 이상은 30분봉을 묶는다 (정규장 1시간봉이 09:30 에 시작해서 60분봉으로는 못 만든다)
 *   KIS 국장  주식일별분봉(FHKST03010230). 1분봉만 주고, 한 번에 120개씩, 날짜·시각(그 시각 포함)으로 이어 받는다. 1년치가 있고 **실전 키만** 된다.
 *             J(KRX)는 09:00–15:30, UN(통합)은 08:00–20:00. 봉 시각은 봉 시작이다. 15:20–15:30 은 비어 있고, 종가 단일가는 15:30 봉 하나로 온다.
 *             J 로 전날까지 이어 받으면 장 뒤(18:00–20:00) 봉이 섞여 오므로, 하루를 넘길 때는 전날 마감 시각부터 다시 묻는다.
 *   토스      1분봉 200개/호출 (nextBefore). 봉 시각이 **봉 끝**이라 1분 당긴다. 국장은 통합 시세다.
 *
 * 캐시: 닫힌 원본 봉은 바뀌지 않으므로 출처·종목별로 들고 있다가 **새로 생긴 부분만** 받는다 (5분봉 감시는 평소 한 번 호출).
 * 처음(재기동 뒤 포함)에만 예열에 필요한 만큼 이어 받는다 (최대 MAX_INTRADAY_PAGES번). 시세라 사용자끼리 나눠 써도 된다.
 */
import { domesticMinuteChart, overseasMinuteChart, overseasPriceAuto } from "../kis/api.ts";
import type { KisContext, KisResponse } from "../kis/client.ts";
import type { BrokerAccess } from "../portfolio.ts";
import { NoBrokerConfiguredError } from "../portfolio.ts";
import { tossCandles } from "../toss/api.ts";
import type { TossContext } from "../toss/client.ts";
import { addDays, CRYPTO_STEP, localClock, MARKETS, MIN, sessionOf, settledAt, stockBucket, zoned } from "./market-time.ts";
import type { Condition, WatchBar } from "./types.ts";

/** 한 번 조회에 이어 받는 최대 횟수 — 처음(예열)만 많고, 평소는 캐시와 겹치는 첫 쪽 하나 */
export const MAX_INTRADAY_PAGES = 100;
/** 캐시 — 출처·종목 수, 하나당 원본 봉 수 (국장 통합 1분봉 약 16거래일) */
const CACHE_KEYS = 64;
const CACHE_BARS = 12_000;

interface Page {
	bars: WatchBar[];
	/** 이 쪽보다 과거를 받는 커서 — 없으면 끝 */
	next: string | null;
}

export interface MinuteSource {
	key: string;
	/** 원본 봉 길이 (ms) */
	gap: number;
	/** cursor 가 없으면 최신부터 */
	page(cursor: string | null): Promise<Page>;
}

interface Entry {
	/** 닫힌 원본 봉 (오래된 순) */
	bars: WatchBar[];
	/** bars[0] 보다 과거를 받는 커서. 없으면 더 없다 */
	older: string | null;
	/** 캐시 상한 때문에 앞을 잘라 냈다 — 더 필요해지면 처음부터 받는다 */
	truncated: boolean;
}

const cache = new Map<string, Entry>();
/** 테스트용 */
export function clearIntradayCache(): void {
	cache.clear();
}

const sortBars = (m: Map<number, WatchBar>): WatchBar[] => [...m.values()].sort((a, b) => a.t - b.t);
const oldestOf = (bars: WatchBar[]): number => bars.reduce((m, b) => Math.min(m, b.t), Number.POSITIVE_INFINITY);

/**
 * 원본 봉 모으기 — ① 최신부터 캐시의 마지막 봉과 겹칠 때까지 (캐시가 없으면 충분할 때까지) ② 그래도 모자라면 가장 오래된 봉 앞으로.
 * 캐시에는 now 기준 닫힌 봉만 둔다 (진행 중인 봉은 다음에 다시 받는다).
 */
export async function collectMinutes(src: MinuteSource, enough: (bars: WatchBar[]) => boolean, now: number): Promise<WatchBar[]> {
	let entry = cache.get(src.key);
	if (entry?.truncated && !enough(entry.bars)) entry = undefined;
	const last = entry?.bars.at(-1)?.t;
	const fresh = new Map<number, WatchBar>();
	let pages = 0;
	let cursor: string | null = null;
	let prevOldest = Number.POSITIVE_INFINITY;
	let overlapped = false;
	while (pages < MAX_INTRADAY_PAGES) {
		const p = await src.page(cursor);
		pages++;
		for (const b of p.bars) fresh.set(b.t, b);
		const oldest = oldestOf(p.bars);
		cursor = p.bars.length && oldest < prevOldest ? p.next : null; // 앞으로 못 가면(같은 쪽을 또 주면) 끝
		prevOldest = oldest;
		if (last !== undefined && oldest <= last) {
			overlapped = true;
			break;
		}
		if (!cursor || (last === undefined && enough(sortBars(fresh)))) break;
	}

	let bars: WatchBar[];
	let older: string | null;
	let truncated = false;
	if (entry && overlapped) {
		const merged = new Map(entry.bars.map((b) => [b.t, b]));
		for (const [t, b] of fresh) merged.set(t, b);
		bars = sortBars(merged);
		older = entry.older;
		truncated = entry.truncated;
	} else {
		// 캐시가 없거나, 너무 오래돼 이어지지 않는다 (빈 구간이 생기므로 버린다)
		bars = sortBars(fresh);
		older = cursor;
	}

	while (older && bars.length && !enough(bars) && pages < MAX_INTRADAY_PAGES) {
		const p = await src.page(older);
		pages++;
		const first = (bars[0] as WatchBar).t;
		const add = p.bars.filter((b) => b.t < first);
		bars = [...add.sort((a, b) => a.t - b.t), ...bars];
		older = add.length ? p.next : null;
	}

	let keep = bars.filter((b) => b.t + src.gap <= now);
	if (keep.length > CACHE_BARS) {
		keep = keep.slice(-CACHE_BARS);
		older = null;
		truncated = true;
	}
	cache.delete(src.key);
	cache.set(src.key, { bars: keep, older, truncated });
	while (cache.size > CACHE_KEYS) cache.delete(cache.keys().next().value as string);
	return bars;
}

/** 원본 봉(오래된 순) → 장 기준 분·시간봉. 세션 밖 봉은 버린다 */
export function bucketStock(c: Pick<Condition, "market" | "interval" | "session">, src: WatchBar[]): WatchBar[] {
	const out: WatchBar[] = [];
	for (const b of src) {
		const t = stockBucket(c, b.t);
		if (t === null) continue;
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

// ── 출처 ────────────────────────────────────────────────────────────────

const num = (v: unknown): number => {
	const n = Number(String(v ?? "").replace(/,/g, ""));
	return Number.isFinite(n) ? n : 0;
};
const rows = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
const dash = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const hm = (hms: string): string => `${hms.slice(0, 2)}:${hms.slice(2, 4)}`;
const compact = (ymd: string, hhmm: string): string => `${ymd.replace(/-/g, "")}${hhmm.replace(":", "")}00`;
const valid = (b: WatchBar): boolean => Number.isFinite(b.t) && b.close > 0;

/** 미장 원본 간격 (분) — 30분 이하는 그대로, 그 이상은 30분봉을 묶는다 */
export function usSourceGap(c: Pick<Condition, "interval">): number {
	return Math.min(CRYPTO_STEP[c.interval] / MIN, 30);
}

export function kisOverseasSource(kis: KisContext, symbol: string, excd: string, nmin: number): MinuteSource {
	const tz = MARKETS.us.tz;
	return {
		key: `kis:us:${symbol}:${excd}:${nmin}`,
		gap: nmin * MIN,
		async page(cursor) {
			const r: KisResponse = await overseasMinuteChart(kis, symbol, excd, nmin, cursor ?? undefined);
			const bars = rows(r.output2)
				.map((x) => ({ t: zoned(dash(String(x.xymd)), hm(String(x.xhms)), tz), open: num(x.open), high: num(x.high), low: num(x.low), close: num(x.last), volume: num(x.evol) }))
				.filter(valid);
			if (!bars.length) return { bars, next: null };
			const k = localClock(oldestOf(bars) - MIN, tz);
			return { bars, next: compact(k.ymd, k.hm) };
		},
	};
}

/**
 * KIS 국내 1분봉. 커서 = "YYYYMMDD HHMMSS" (그 시각 포함 과거로). 하루 범위는 시장 코드에 따라 J 정규장(종가 단일가 포함) · UN 08:00–20:00.
 * 그날 시작까지 받았으면 전 평일 마감 시각부터 — 휴장일이면 KIS 가 알아서 그 전 거래일로 이어 준다.
 */
export function kisDomesticSource(kis: KisContext, symbol: string, market: "J" | "UN", now: number): MinuteSource {
	const tz = MARKETS.krx.tz;
	const day = (ymd: string) => {
		const s = sessionOf({ market: { venue: "krx", symbol } }, ymd);
		return market === "UN" ? { open: "08:00", close: "20:00" } : { open: localClock(s.open, tz).hm, close: localClock(s.close, tz).hm };
	};
	const prevWeekday = (ymd: string): string => {
		let d = addDays(ymd, -1);
		while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, -1);
		return d;
	};
	const at = (ymd: string, hhmm: string): string => `${ymd.replace(/-/g, "")} ${hhmm.replace(":", "")}00`;
	return {
		key: `kis:krx:${symbol}:${market}`,
		gap: MIN,
		async page(cursor) {
			const today = localClock(now, tz).ymd;
			const [date, hour] = (cursor ?? at(today, day(today).close)).split(" ") as [string, string];
			const r = await domesticMinuteChart(kis, symbol, { date, hour, market });
			const bars = rows(r.output2)
				.map((x) => ({
					t: zoned(dash(String(x.stck_bsop_date)), hm(String(x.stck_cntg_hour)), tz),
					open: num(x.stck_oprc),
					high: num(x.stck_hgpr),
					low: num(x.stck_lwpr),
					close: num(x.stck_prpr),
					volume: num(x.cntg_vol),
				}))
				.filter(valid);
			if (!bars.length) return { bars, next: null };
			const oldest = localClock(oldestOf(bars), tz);
			if (oldest.hm <= day(oldest.ymd).open) {
				const prev = prevWeekday(oldest.ymd);
				return { bars, next: at(prev, day(prev).close) };
			}
			const k = localClock(oldestOf(bars) - MIN, tz);
			return { bars, next: at(k.ymd, k.hm) };
		},
	};
}

export function tossMinuteSource(toss: TossContext, venue: "krx" | "us", symbol: string): MinuteSource {
	return {
		key: `toss:${venue}:${symbol}`,
		gap: MIN,
		async page(cursor) {
			const r = await tossCandles(toss, symbol, { interval: "1m", count: 200, ...(cursor ? { before: cursor } : {}) });
			// 토스 1분봉 timestamp 는 봉 끝 — [timestamp − 1분, timestamp) 구간
			const bars = (r.candles ?? [])
				.map((x) => ({ t: Date.parse(x.timestamp) - MIN, open: num(x.openPrice), high: num(x.highPrice), low: num(x.lowPrice), close: num(x.closePrice), volume: num(x.volume) }))
				.filter(valid);
			return { bars, next: bars.length ? r.nextBefore : null };
		},
	};
}

/** 미장 거래소 코드 — 종목마다 한 번만 찾는다 (NAS→NYS→AMS 현재가 조회) */
const excdCache = new Map<string, string>();
async function excdOf(kis: KisContext, symbol: string): Promise<string> {
	const hit = excdCache.get(symbol);
	if (hit) return hit;
	const { excd } = await overseasPriceAuto(kis, symbol);
	excdCache.set(symbol, excd);
	return excd;
}

function make<T>(f: (() => T) | undefined): T | null {
	try {
		return f?.() ?? null;
	} catch {
		return null;
	}
}

/** 감시 조건의 분·시간봉 — 값이 확정된 봉(settledAt ≤ now)만, 최근 limit 개 */
export async function fetchStockIntraday(access: BrokerAccess, c: Condition, limit: number, now: number): Promise<WatchBar[]> {
	const venue = c.market.venue as "krx" | "us";
	const { symbol, feed } = c.market;
	const settled = (src: WatchBar[]) => bucketStock(c, src).filter((b) => settledAt(c, b.t) <= now);
	// 하나 더 — 이어 받다 멈춘 자리의 맨 앞 봉은 원본이 덜 들어와 있을 수 있다 (잘라 낸다)
	const enough = (src: WatchBar[]) => settled(src).length > limit;
	const allow = (p: "kis" | "toss") => !feed || feed.provider === p;
	const errors: string[] = [];

	const kis = allow("kis") ? make(access.kis) : null;
	if (kis) {
		try {
			if (kis.creds.env === "paper") throw new Error("분봉 감시는 한국투자 실전 키가 필요합니다 (모의투자 키로는 과거 분봉을 받을 수 없습니다)");
			const src =
				venue === "krx"
					? kisDomesticSource(kis, symbol, feed?.basis === "integrated" ? "UN" : "J", now)
					: kisOverseasSource(kis, symbol, await excdOf(kis, symbol), usSourceGap(c));
			return settled(await collectMinutes(src, enough, now)).slice(-limit);
		} catch (err) {
			errors.push(`KIS: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const toss = allow("toss") ? make(access.toss) : null;
	if (toss) {
		try {
			return settled(await collectMinutes(tossMinuteSource(toss, venue, symbol), enough, now)).slice(-limit);
		} catch (err) {
			errors.push(`토스: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (!kis && !toss) {
		if (feed) throw new Error(`이 감시는 ${feed.provider === "kis" ? "한국투자" : "토스"} 시세로 만들었는데 그 키가 없습니다 — 설정 → 연결 → 증권에 다시 넣거나, 감시를 새로 만들어 주세요`);
		throw new NoBrokerConfiguredError();
	}
	throw new Error(`${symbol} 분봉을 가져오지 못했습니다 — ${errors.join(" / ")}`);
}
