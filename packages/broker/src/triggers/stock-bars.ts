/**
 * 주식 감시용 봉 (PLAN §40) — 국장·미장 일봉·주봉. 트리거 주인의 증권 키로 조회한다.
 *
 * 출처 순서: KIS → 토스 (둘 다 있으면 KIS — 국장 일봉이 KRX 정규장 기준으로 분명하다).
 *   KIS 국내 기간별시세 100봉/호출 (날짜 구간으로 이어 받기) · KIS 해외 100행/호출 (기준일로 이어 받기) · 토스 200봉/호출 (nextBefore)
 * 주봉은 KIS 주봉을 쓰지 않고 **일봉을 묶는다** — 봉 시각·마감 규칙(market-time)을 한 곳에서 정하려고.
 * 진행 중인 봉(오늘 장중 일봉, 이번 주 주봉)은 뺀다.
 */
import { domesticChart, overseasChart, overseasPriceAuto } from "../kis/api.ts";
import { toDomesticBars, toOverseasBars, toTossBars } from "../normalize.ts";
import type { BrokerAccess } from "../portfolio.ts";
import { NoBrokerConfiguredError } from "../portfolio.ts";
import { tossCandles } from "../toss/api.ts";
import type { Bar } from "../indicators.ts";
import { addDays, barCloseAt, MARKETS, mondayOf, stockDayStart } from "./market-time.ts";
import type { Condition, WatchBar } from "./types.ts";

export const MAX_STOCK_PAGES = 6;

const ymdDash = (d: string): string => (d.includes("-") ? d.slice(0, 10) : `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
const ymdCompact = (d: string): string => d.replace(/-/g, "");

/** 일봉 count 개 이상 (가능한 만큼) — 오래된 순 */
export async function fetchStockDaily(access: BrokerAccess, venue: "krx" | "us", symbol: string, count: number): Promise<{ bars: Bar[]; source: "kis" | "toss" }> {
	const errors: string[] = [];
	const merge = (acc: Map<string, Bar>, list: Bar[]): number => {
		let added = 0;
		for (const b of list) if (!acc.has(b.date)) (acc.set(b.date, b), added++);
		return added;
	};
	const sorted = (acc: Map<string, Bar>) => [...acc.values()].sort((a, b) => a.date.localeCompare(b.date));

	let kis: ReturnType<NonNullable<BrokerAccess["kis"]>> | null = null;
	try {
		kis = access.kis?.() ?? null;
	} catch {
		kis = null;
	}
	if (kis) {
		try {
			const acc = new Map<string, Bar>();
			let to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
			const excd = venue === "us" ? (await overseasPriceAuto(kis, symbol)).excd : null;
			for (let page = 0; page < MAX_STOCK_PAGES && acc.size < count; page++) {
				const list =
					venue === "krx"
						? toDomesticBars(await domesticChart(kis, symbol, "D", { from: ymdCompact(addDays(to, -145)), to: ymdCompact(to) }))
						: toOverseasBars(await overseasChart(kis, symbol, excd as string, "D", { bymd: ymdCompact(to) }));
				if (merge(acc, list) === 0) break;
				to = addDays(ymdDash((list[0] as Bar).date), -1);
			}
			if (acc.size > 0) return { bars: sorted(acc), source: "kis" };
			errors.push("KIS: 봉이 없습니다");
		} catch (err) {
			errors.push(`KIS: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	let toss: ReturnType<NonNullable<BrokerAccess["toss"]>> | null = null;
	try {
		toss = access.toss?.() ?? null;
	} catch {
		toss = null;
	}
	if (toss) {
		try {
			const acc = new Map<string, Bar>();
			let before: string | undefined;
			for (let page = 0; page < MAX_STOCK_PAGES && acc.size < count; page++) {
				const r = await tossCandles(toss, symbol, { interval: "1d", count: 200, ...(before ? { before } : {}) });
				if (merge(acc, toTossBars(r.candles)) === 0 || !r.nextBefore) break;
				before = r.nextBefore;
			}
			if (acc.size > 0) return { bars: sorted(acc), source: "toss" };
			errors.push("토스: 봉이 없습니다");
		} catch (err) {
			errors.push(`토스: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (!kis && !toss) throw new NoBrokerConfiguredError();
	throw new Error(`${symbol} 일봉을 가져오지 못했습니다 — ${errors.join(" / ")}`);
}

/** 일봉 → 감시 봉 (t = 그날 장 시작) */
export function dailyToWatch(venue: "krx" | "us", bars: Bar[]): WatchBar[] {
	return bars.map((b) => ({ t: stockDayStart(venue, ymdDash(b.date)), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
}

/** 일봉 → 주봉 (월~금 묶음, t = 그 주 월요일 장 시작) */
export function weeklyFromDaily(venue: "krx" | "us", bars: Bar[]): WatchBar[] {
	const out: WatchBar[] = [];
	let cur: WatchBar | null = null;
	let key = "";
	for (const b of bars) {
		const mon = mondayOf(ymdDash(b.date));
		if (mon !== key) {
			if (cur) out.push(cur);
			key = mon;
			cur = { t: stockDayStart(venue, mon), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 };
		} else if (cur) {
			cur.high = Math.max(cur.high, b.high);
			cur.low = Math.min(cur.low, b.low);
			cur.close = b.close;
			cur.volume += b.volume ?? 0;
		}
	}
	if (cur) out.push(cur);
	return out;
}

/** 감시 조건의 봉 (일봉·주봉) — 닫힌 봉만, 최근 limit 개 */
export async function fetchStockBars(access: BrokerAccess, c: Condition, limit: number, now: number): Promise<WatchBar[]> {
	const venue = c.market.venue as "krx" | "us";
	if (!(venue in MARKETS)) throw new Error(`주식 시장이 아닙니다: ${venue}`);
	const daysNeeded = c.interval === "1w" ? limit * 5 + 5 : limit + 2;
	const { bars } = await fetchStockDaily(access, venue, c.market.symbol, daysNeeded);
	const watch = c.interval === "1w" ? weeklyFromDaily(venue, bars) : dailyToWatch(venue, bars);
	return watch.filter((b) => barCloseAt(c, b.t) <= now).slice(-limit);
}
