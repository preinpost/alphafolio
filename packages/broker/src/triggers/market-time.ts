/**
 * 시장 시계 (PLAN §40) — 봉이 **언제 닫히는지**.
 *
 * 코인(Binance): UTC 시계 기준 고정 간격. 주봉은 월요일 00:00 UTC 시작 (epoch 0 은 목요일이라 단순 나눗셈이면 어긋난다).
 * 주식: 장 기준. 일봉 = 그날 정규장, 주봉 = 그 주 월~금 (금요일 정규장 마감에 닫힌다).
 *   - 국장 KRX 09:00–15:30 KST, 미장 09:30–16:00 뉴욕 시간 (서머타임은 Intl 로 — 직접 계산하지 않는다)
 *   - 휴장일은 **봉이 없을 뿐**이라 캘린더 없이도 판정이 틀리지 않는다 (감시기가 헛조회만 막는다)
 *   - 알려진 한계: 국장이 늦게 끝나는 날(수능일 16:30)·미장 조기 폐장(13:00)은 고정 시각으로 본다.
 *     조기 폐장은 늦게 평가할 뿐 틀리지 않고, 수능일은 15:30 봉이 아직 진행 중일 수 있다 → 캘린더 연동은 분봉 단계에서
 *
 * 봉 시각 t 는 봉 시작 — 주식 일봉은 그날 장 시작, 주봉은 그 주 월요일 장 시작 (월요일이 휴장이어도 같은 값).
 */
import type { Condition, Interval, Venue } from "./types.ts";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** 코인 봉 간격 (고정) */
export const CRYPTO_STEP: Readonly<Record<Interval, number>> = {
	"1m": MIN,
	"5m": 5 * MIN,
	"10m": 10 * MIN,
	"15m": 15 * MIN,
	"30m": 30 * MIN,
	"1h": HOUR,
	"2h": 2 * HOUR,
	"4h": 4 * HOUR,
	"1d": DAY,
	"1w": WEEK,
};

/** 1970-01-05 (월) 00:00 UTC — 주봉 기준점 */
const MONDAY_EPOCH = 4 * DAY;

export interface MarketHours {
	tz: string;
	open: string;
	close: string;
	label: string;
}

export const MARKETS: Readonly<Record<Exclude<Venue, "binance">, MarketHours>> = {
	krx: { tz: "Asia/Seoul", open: "09:00", close: "15:30", label: "국장" },
	us: { tz: "America/New_York", open: "09:30", close: "16:00", label: "미장" },
};

export const isStock = (v: Venue): v is "krx" | "us" => v !== "binance";

// ── 시간대 ─────────────────────────────────────────────────────────────

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(t: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
	let f = fmtCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
		fmtCache.set(tz, f);
	}
	const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
	const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday as string);
	return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), wd };
}

/** 그 시각의 현지 날짜 \"YYYY-MM-DD\" 와 요일 (0=일) */
export function localDate(t: number, tz: string): { ymd: string; weekday: number } {
	const p = parts(t, tz);
	return { ymd: `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`, weekday: p.wd };
}

function offsetMs(t: number, tz: string): number {
	const p = parts(t, tz);
	return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(t / MIN) * MIN;
}

/** 현지 날짜·시각 → epoch ms (서머타임 경계는 두 번 맞춰 본다) */
export function zoned(ymd: string, hhmm: string, tz: string): number {
	const [y, mo, d] = ymd.split("-").map(Number) as [number, number, number];
	const [h, mi] = hhmm.split(":").map(Number) as [number, number];
	const guess = Date.UTC(y, mo - 1, d, h, mi);
	let t = guess - offsetMs(guess, tz);
	const again = guess - offsetMs(t, tz);
	if (again !== t) t = again;
	return t;
}

/** 날짜 더하기 (달력, 현지 날짜 문자열) */
export function addDays(ymd: string, n: number): string {
	const [y, mo, d] = ymd.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

function weekdayOf(ymd: string): number {
	const [y, mo, d] = ymd.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/** 그 주 월요일 */
export function mondayOf(ymd: string): string {
	const wd = weekdayOf(ymd);
	return addDays(ymd, wd === 0 ? -6 : 1 - wd);
}

// ── 봉 시각 ────────────────────────────────────────────────────────────

/** 주식 일봉 시작 (그날 장 시작) */
export function stockDayStart(venue: "krx" | "us", ymd: string): number {
	const m = MARKETS[venue];
	return zoned(ymd, m.open, m.tz);
}

/** 봉 시작 → 닫히는 시각 */
export function barCloseAt(c: Pick<Condition, "market" | "interval">, t: number): number {
	const v = c.market.venue;
	if (!isStock(v)) return t + CRYPTO_STEP[c.interval];
	const m = MARKETS[v];
	const ymd = localDate(t, m.tz).ymd;
	if (c.interval === "1w") return zoned(addDays(mondayOf(ymd), 4), m.close, m.tz);
	return zoned(ymd, m.close, m.tz);
}

/** 코인 봉 시작 (UTC 시계, 주봉은 월요일 기준) */
export function cryptoBarStart(t: number, interval: Interval): number {
	const step = CRYPTO_STEP[interval];
	if (interval === "1w") return Math.floor((t - MONDAY_EPOCH) / WEEK) * WEEK + MONDAY_EPOCH;
	return Math.floor(t / step) * step;
}

/**
 * now 기준 마지막으로 **닫힌** 봉의 시작. 주식은 휴장일을 모르므로 평일 기준 \"닫혔어야 할\" 봉이다 —
 * 그날이 휴장이면 그 봉은 오지 않고, 감시기는 헛조회를 막는다.
 */
export function lastClosedStart(c: Pick<Condition, "market" | "interval">, now: number): number {
	const v = c.market.venue;
	if (!isStock(v)) return cryptoBarStart(now, c.interval) - CRYPTO_STEP[c.interval];
	const m = MARKETS[v];
	let ymd = localDate(now, m.tz).ymd;
	if (c.interval === "1w") {
		let mon = mondayOf(ymd);
		if (now < zoned(addDays(mon, 4), m.close, m.tz)) mon = addDays(mon, -7);
		return zoned(mon, m.open, m.tz);
	}
	// 오늘 장이 아직 안 끝났으면 어제, 주말이면 금요일로
	if (now < zoned(ymd, m.close, m.tz)) ymd = addDays(ymd, -1);
	while ([0, 6].includes(weekdayOf(ymd))) ymd = addDays(ymd, -1);
	return zoned(ymd, m.open, m.tz);
}

/** 다음에 닫힐 봉의 마감 시각 (목록의 \"다음 평가\") */
export function nextCloseAt(c: Pick<Condition, "market" | "interval">, now: number): number {
	const v = c.market.venue;
	if (!isStock(v)) return cryptoBarStart(now, c.interval) + CRYPTO_STEP[c.interval];
	const m = MARKETS[v];
	let ymd = localDate(now, m.tz).ymd;
	if (c.interval === "1w") {
		const fri = addDays(mondayOf(ymd), 4);
		const close = zoned(fri, m.close, m.tz);
		return now < close ? close : zoned(addDays(fri, 7), m.close, m.tz);
	}
	if (now >= zoned(ymd, m.close, m.tz)) ymd = addDays(ymd, 1);
	while ([0, 6].includes(weekdayOf(ymd))) ymd = addDays(ymd, 1);
	return zoned(ymd, m.close, m.tz);
}

/** 발동이 이만큼 넘게 늦으면 \"늦은 알림\" (재기동으로 놓친 것) */
export function lateAfter(c: Pick<Condition, "market" | "interval">): number {
	if (!isStock(c.market.venue)) return CRYPTO_STEP[c.interval];
	return c.interval === "1w" ? 2 * DAY : 12 * HOUR;
}

/** 봉 마감 뒤 이만큼 기다렸다 평가 — 거래소가 마감 봉을 확정하는 시간 (주식은 동시호가·체결 집계 여유) */
export function evalDelay(c: Pick<Condition, "market">): number {
	return isStock(c.market.venue) ? 10 * MIN : 3_000;
}
