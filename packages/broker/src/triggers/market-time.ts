/**
 * 시장 시계 (PLAN §40) — 봉이 **언제 닫히는지**.
 *
 * 코인(Binance): UTC 시계 기준 고정 간격. 주봉은 월요일 00:00 UTC 시작 (epoch 0 은 목요일이라 단순 나눗셈이면 어긋난다).
 * 주식: 장 기준. 일봉 = 그날 정규장, 주봉 = 그 주 월~금 (금요일 정규장 마감에 닫힌다).
 *   - 국장 KRX 09:00–15:30 KST, 미장 09:30–16:00 뉴욕 시간 (서머타임은 Intl 로 — 직접 계산하지 않는다)
 *   - 분·시간봉은 **그날 세션 시작부터** 간격만큼 자른다 (TradingView 와 같다). 마지막 봉은 마감에서 잘린다 — 국장 1시간봉 15:00–15:30, 미장 15:30–16:00.
 *     세션: 정규장(기본) 위와 같음 / 확장 국장 08:00–20:00(NXT, 통합 기준만) · 미장 04:00–20:00(프리·애프터)
 *   - 국장 종가 단일가는 마감 시각(15:30)에 봉 하나로 찍힌다 → 정규장 마지막 봉에 넣는다. 랜덤 엔드(최대 30초)가 있어 그 봉은 마감 1분 뒤에 닫힌 것으로 본다
 *   - 장 캘린더(SPECIAL_DAYS): 평소와 다른 날만 — 수능일(국장 10:00–16:30)·새해 첫 거래일(10:00 개장)·미장 조기 폐장(13:00). **해마다 채운다**
 *   - 휴장일은 **봉이 없을 뿐**이라 캘린더에 넣지 않는다 (판정이 틀리지 않고, 감시기가 헛조회만 막는다)
 *
 * 봉 시각 t 는 봉 시작 — 주식 일봉은 그날 장 시작, 주봉은 그 주 월요일 장 시작 (월요일이 휴장이어도 같은 값).
 */
import type { Condition, Interval, StockFeed, Venue } from "./types.ts";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** 봉 간격 (고정 길이) — 코인은 그대로, 주식 분·시간봉은 세션 안에서 이 길이로 자른다 */
export const CRYPTO_STEP: Readonly<Record<Interval, number>> = {
	"1m": MIN,
	"3m": 3 * MIN,
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

/** 분·시간봉인가 (일봉·주봉이 아닌가) */
export const isIntraday = (i: Interval): boolean => i !== "1d" && i !== "1w";

/** 1970-01-05 (월) 00:00 UTC — 주봉 기준점 */
const MONDAY_EPOCH = 4 * DAY;

export interface MarketHours {
	tz: string;
	open: string;
	close: string;
	/** 확장 세션 (국장 NXT 프리~애프터, 미장 프리~애프터) */
	extOpen: string;
	extClose: string;
	label: string;
}

export const MARKETS: Readonly<Record<Exclude<Venue, "binance">, MarketHours>> = {
	krx: { tz: "Asia/Seoul", open: "09:00", close: "15:30", extOpen: "08:00", extClose: "20:00", label: "국장" },
	us: { tz: "America/New_York", open: "09:30", close: "16:00", extOpen: "04:00", extClose: "20:00", label: "미장" },
};

/** 평소와 다른 날 (현지 날짜) — 정규장 시작·마감, 확장 세션 마감 */
export interface SpecialDay {
	open?: string;
	close?: string;
	extClose?: string;
	note: string;
}

/**
 * 장 캘린더 — 휴장일은 넣지 않는다 (봉이 안 올 뿐). 해마다 채운다:
 * 국장은 거래소 공지(수능일 1시간 늦게 열고 늦게 닫음, 새해 첫날 10시 개장), 미장은 NYSE 조기 폐장(정규장 13:00, 애프터 17:00).
 */
export const SPECIAL_DAYS: Readonly<Record<Exclude<Venue, "binance">, Readonly<Record<string, SpecialDay>>>> = {
	krx: {
		"2026-11-19": { open: "10:00", close: "16:30", note: "수능" },
		"2027-01-04": { open: "10:00", note: "새해 첫 거래일" },
	},
	us: {
		"2026-11-27": { close: "13:00", extClose: "17:00", note: "추수감사절 다음 날" },
		"2026-12-24": { close: "13:00", extClose: "17:00", note: "크리스마스 이브" },
		"2027-11-26": { close: "13:00", extClose: "17:00", note: "추수감사절 다음 날" },
	},
};

export const isStock = (v: Venue): v is "krx" | "us" => v !== "binance";

/** 국장 KRX+NXT 통합 시세는 NXT 애프터가 끝나는 20:00 에 일봉이 닫힌다 (종가 = 20시 체결가) */
export const KRX_INTEGRATED_CLOSE = "20:00";

/** 이 조건의 일봉이 그날 닫히는 현지 시각 — 국장 통합 기준이면 20:00, 그 외 정규장 마감 (조기 폐장·수능일 반영) */
export function closeOf(c: Pick<Condition, "market">, ymd: string): string {
	const v = c.market.venue as "krx" | "us";
	if (v === "krx" && c.market.feed?.basis === "integrated") return KRX_INTEGRATED_CLOSE;
	return SPECIAL_DAYS[v][ymd]?.close ?? MARKETS[v].close;
}

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

/** 그 시각의 현지 날짜·시각 — "YYYY-MM-DD", "HH:MM" (증권사 분봉 이어 받기 키) */
export function localClock(t: number, tz: string): { ymd: string; hm: string } {
	const p = parts(t, tz);
	const two = (n: number) => String(n).padStart(2, "0");
	return { ymd: `${p.y}-${two(p.mo)}-${two(p.d)}`, hm: `${two(p.h)}:${two(p.mi)}` };
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

type Ctx = Pick<Condition, "market" | "interval" | "session">;
const tzOf = (c: Pick<Condition, "market">): string => MARKETS[c.market.venue as "krx" | "us"].tz;
const isWeekend = (ymd: string): boolean => [0, 6].includes(weekdayOf(ymd));
/** 주말·휴장을 건너 거슬러 볼 최대 일수 (설·추석 연휴 + 주말) */
const MAX_SCAN_DAYS = 14;

/** 주식 일봉 시작 (그날 장 시작) */
export function stockDayStart(venue: "krx" | "us", ymd: string): number {
	const m = MARKETS[venue];
	return zoned(ymd, m.open, m.tz);
}

/** 그날 주식 세션 (epoch) — 분·시간봉을 자르는 시작과 마감. 장 캘린더를 반영한다 */
export function sessionOf(c: Pick<Condition, "market" | "session">, ymd: string): { open: number; close: number } {
	const v = c.market.venue as "krx" | "us";
	const m = MARKETS[v];
	const sp = SPECIAL_DAYS[v][ymd];
	if (c.session === "extended") return { open: zoned(ymd, m.extOpen, m.tz), close: zoned(ymd, sp?.extClose ?? m.extClose, m.tz) };
	return { open: zoned(ymd, sp?.open ?? m.open, m.tz), close: zoned(ymd, sp?.close ?? m.close, m.tz) };
}

/** 국장 정규장은 종가 단일가가 마감 시각에 봉 하나로 찍힌다 (확장 세션은 그 시각이 세션 안이라 따로 다루지 않는다) */
const hasClosingAuction = (c: Pick<Condition, "market" | "session">): boolean => c.market.venue === "krx" && c.session !== "extended";
/** 종가 단일가 랜덤 엔드(최대 30초) + 집계 여유 — 정규장 마지막 봉은 마감 이만큼 뒤에 닫힌 것으로 본다 */
export const AUCTION_SETTLE = MIN;

/** 원본 봉(1분봉 등) 시각 → 그 봉이 들어갈 분·시간봉의 시작. 세션 밖이면 null. 국장 종가 단일가(마감 시각)는 마지막 봉으로 */
export function stockBucket(c: Ctx, t: number): number | null {
	const s = sessionOf(c, localDate(t, tzOf(c)).ymd);
	if (t < s.open) return null;
	let at = t;
	if (at >= s.close) {
		if (!(at === s.close && hasClosingAuction(c))) return null;
		at = s.close - 1;
	}
	const step = CRYPTO_STEP[c.interval];
	return s.open + Math.floor((at - s.open) / step) * step;
}

/** 봉 시작 → 닫히는 시각 */
export function barCloseAt(c: Ctx, t: number): number {
	const v = c.market.venue;
	if (!isStock(v)) return t + CRYPTO_STEP[c.interval];
	const m = MARKETS[v];
	const ymd = localDate(t, m.tz).ymd;
	if (c.interval === "1w") {
		const fri = addDays(mondayOf(ymd), 4);
		return zoned(fri, closeOf(c, fri), m.tz);
	}
	if (c.interval === "1d") return zoned(ymd, closeOf(c, ymd), m.tz);
	return Math.min(t + CRYPTO_STEP[c.interval], sessionOf(c, ymd).close);
}

/** 봉이 닫혀 **값이 확정되는** 시각 — 국장 정규장 마지막 분·시간봉만 종가 단일가를 기다린다. 나머지는 barCloseAt 과 같다 */
export function settledAt(c: Ctx, t: number): number {
	const close = barCloseAt(c, t);
	if (!isStock(c.market.venue) || !isIntraday(c.interval) || !hasClosingAuction(c)) return close;
	return close === sessionOf(c, localDate(t, tzOf(c)).ymd).close ? close + AUCTION_SETTLE : close;
}

/** 코인 봉 시작 (UTC 시계, 주봉은 월요일 기준) */
export function cryptoBarStart(t: number, interval: Interval): number {
	const step = CRYPTO_STEP[interval];
	if (interval === "1w") return Math.floor((t - MONDAY_EPOCH) / WEEK) * WEEK + MONDAY_EPOCH;
	return Math.floor(t / step) * step;
}

/** 주식 분·시간봉 — now 까지 값이 확정된 마지막 봉 */
function lastSettledIntraday(c: Ctx, now: number): number {
	const step = CRYPTO_STEP[c.interval];
	let ymd = localDate(now, tzOf(c)).ymd;
	for (let k = 0; k < MAX_SCAN_DAYS; k++, ymd = addDays(ymd, -1)) {
		if (isWeekend(ymd)) continue;
		const s = sessionOf(c, ymd);
		if (now < s.open) continue;
		const last = Math.floor((s.close - 1 - s.open) / step); // 그날 마지막 봉 번호 (마감에서 잘린 봉)
		const i = now >= settledAt(c, s.open + last * step) ? last : Math.min(Math.floor((now - s.open) / step) - 1, last - 1);
		if (i >= 0) return s.open + i * step;
	}
	return sessionOf(c, ymd).open;
}

/**
 * now 기준 마지막으로 **닫힌** 봉의 시작. 주식은 휴장일을 모르므로 평일 기준 \"닫혔어야 할\" 봉이다 —
 * 그날이 휴장이면 그 봉은 오지 않고, 감시기는 헛조회를 막는다. 분·시간봉은 값이 확정된 봉(settledAt)까지.
 */
export function lastClosedStart(c: Ctx, now: number): number {
	const v = c.market.venue;
	if (!isStock(v)) return cryptoBarStart(now, c.interval) - CRYPTO_STEP[c.interval];
	if (isIntraday(c.interval)) return lastSettledIntraday(c, now);
	const m = MARKETS[v];
	let ymd = localDate(now, m.tz).ymd;
	if (c.interval === "1w") {
		let mon = mondayOf(ymd);
		if (now < zoned(addDays(mon, 4), closeOf(c, addDays(mon, 4)), m.tz)) mon = addDays(mon, -7);
		return zoned(mon, m.open, m.tz);
	}
	// 오늘 장이 아직 안 끝났으면 어제, 주말이면 금요일로
	if (now < zoned(ymd, closeOf(c, ymd), m.tz)) ymd = addDays(ymd, -1);
	while (isWeekend(ymd)) ymd = addDays(ymd, -1);
	return zoned(ymd, m.open, m.tz);
}

/** 다음에 닫힐 봉의 마감 시각 (목록의 \"다음 평가\") */
export function nextCloseAt(c: Ctx, now: number): number {
	const v = c.market.venue;
	if (!isStock(v)) return cryptoBarStart(now, c.interval) + CRYPTO_STEP[c.interval];
	const m = MARKETS[v];
	let ymd = localDate(now, m.tz).ymd;
	if (isIntraday(c.interval)) {
		const step = CRYPTO_STEP[c.interval];
		for (let k = 0; k < MAX_SCAN_DAYS; k++, ymd = addDays(ymd, 1)) {
			if (isWeekend(ymd)) continue;
			const s = sessionOf(c, ymd);
			if (now < s.open) return Math.min(s.open + step, s.close);
			if (now < s.close) return Math.min(s.open + (Math.floor((now - s.open) / step) + 1) * step, s.close);
		}
		return now + step;
	}
	if (c.interval === "1w") {
		const fri = addDays(mondayOf(ymd), 4);
		const close = zoned(fri, closeOf(c, fri), m.tz);
		return now < close ? close : zoned(addDays(fri, 7), closeOf(c, addDays(fri, 7)), m.tz);
	}
	if (now >= zoned(ymd, closeOf(c, ymd), m.tz)) ymd = addDays(ymd, 1);
	while (isWeekend(ymd)) ymd = addDays(ymd, 1);
	return zoned(ymd, closeOf(c, ymd), m.tz);
}

/** 발동이 이만큼 넘게 늦으면 \"늦은 알림\" (재기동으로 놓친 것) */
export function lateAfter(c: Pick<Condition, "market" | "interval">): number {
	if (!isStock(c.market.venue) || isIntraday(c.interval)) return CRYPTO_STEP[c.interval];
	return c.interval === "1w" ? 2 * DAY : 12 * HOUR;
}

/**
 * 봉 마감 뒤 이만큼 기다렸다 평가 — 거래소·증권사가 마감 봉을 확정하는 시간.
 * 코인 3초 · 주식 분·시간봉 20초(증권사 분봉 반영) · 주식 일봉·주봉 10분(동시호가·체결 집계 여유)
 */
export function evalDelay(c: Pick<Condition, "market" | "interval">): number {
	if (!isStock(c.market.venue)) return 3_000;
	return isIntraday(c.interval) ? 20_000 : 10 * MIN;
}

// ── 주식 시세 출처 ──────────────────────────────────────────────────────

export const FEED_LABEL = (venue: "krx" | "us", f: StockFeed): string =>
	venue === "krx"
		? f.basis === "integrated"
			? `KRX+NXT 통합 · ${f.provider === "kis" ? "한국투자" : "토스"} (20:00 마감)`
			: "KRX 정규장 · 한국투자 (15:30 마감)"
		: f.provider === "kis"
			? "한국투자"
			: "토스";

/** 고정 출처 검증 — 국장 KRX 정규장만은 KIS 로만 받을 수 있다 (토스 캔들은 통합뿐) */
export function feedErrors(venue: "krx" | "us", f: StockFeed): string[] {
	if (f.provider !== "kis" && f.provider !== "toss") return ["출처는 kis · toss 입니다"];
	if (venue === "us") return f.basis ? ["미장은 기준(basis) 이 없습니다"] : [];
	if (f.basis !== "krx" && f.basis !== "integrated") return ["국장 기준은 krx(정규장만) · integrated(KRX+NXT 통합) 입니다"];
	if (f.provider === "toss" && f.basis === "krx") return ["토스 시세는 KRX+NXT 통합뿐입니다 — KRX 정규장 기준은 한국투자 키가 필요합니다"];
	return [];
}
