/**
 * 규칙 · 리스크 (PLAN §40 2단계) — 신호를 체결 의도로 바꾸고, 내도 되는지 본다. **순수 함수** (조회는 호출부가 한다).
 *
 *   규칙   수량(주·금액·보유 %) · 최악 허용가(기준가 ± %) — 가격을 어떻게 낼지는 체결기가 정한다
 *   리스크 정규장 안인가 · 하루 매수 한도 · 매도 가능 수량
 *
 * 금액 주문은 **최악 허용가로** 나눠 내림한다 — 가장 나쁘게 체결돼도 금액을 넘지 않는다.
 */
import type { Market } from "../orders.ts";
import { localClock, localDate, MARKETS, sessionOf } from "./market-time.ts";
import type { CondNode, Condition, Interval, OrderRule, OrderSize, OrderTarget, Position, ProtectLevel, ProtectRule } from "./types.ts";
import { INTERVAL_LABEL } from "./describe.ts";
import { roundPrice } from "./venues/tick.ts";

export const ORDER_DEFAULTS = {
	BUY: { worstPct: 1, urgency: "patient", deadlineSec: 60 },
	SELL: { worstPct: 2, urgency: "immediate", deadlineSec: 30 },
} as const;
export const WORST_PCT_RANGE = [0.1, 10] as const;
export const DEADLINE_RANGE = [10, 600] as const;
/** 국장 종가 단일가(15:20–15:30) 에는 새로 내지 않는다 — IOC 가 안 되고, 체결가를 미리 알 수 없다 */
export const KRX_CLOSING_CALL_MIN = 10;

export function validateOrderRule(r: OrderRule): string[] {
	const e: string[] = [];
	const s = r.size as Partial<Record<"shares" | "amount" | "holdingPct", number>>;
	const kinds = (["shares", "amount", "holdingPct"] as const).filter((k) => s[k] !== undefined);
	if (kinds.length !== 1) e.push("수량은 주(shares)·금액(amount)·보유 %(holdingPct) 중 하나만 정합니다");
	if (s.shares !== undefined && (!Number.isInteger(s.shares) || s.shares < 1 || s.shares > 1_000_000)) e.push("주 수는 1 이상의 정수입니다");
	if (s.amount !== undefined && !(s.amount > 0 && Number.isFinite(s.amount))) e.push("금액은 0보다 커야 합니다");
	if (s.holdingPct !== undefined && !(s.holdingPct > 0 && s.holdingPct <= 100)) e.push("보유 %는 0 초과 100 이하입니다");
	if (s.holdingPct !== undefined && r.side !== "SELL") e.push("보유 %는 매도에만 씁니다");
	if (!(r.worstPct >= WORST_PCT_RANGE[0] && r.worstPct <= WORST_PCT_RANGE[1])) e.push(`최악 허용가는 기준가 ±${WORST_PCT_RANGE[0]}~${WORST_PCT_RANGE[1]}% 입니다`);
	if (!(r.deadlineSec >= DEADLINE_RANGE[0] && r.deadlineSec <= DEADLINE_RANGE[1])) e.push(`체결 제한 시간은 ${DEADLINE_RANGE[0]}~${DEADLINE_RANGE[1]}초입니다`);
	return e;
}

export function sizeText(size: OrderSize, currency: "KRW" | "USD"): string {
	if ("shares" in size) return `${size.shares.toLocaleString("en-US")}주`;
	if ("amount" in size) return currency === "KRW" ? `${Math.round(size.amount).toLocaleString("en-US")}원어치` : `$${size.amount.toLocaleString("en-US")}어치`;
	return `매도 가능 수량의 ${size.holdingPct}%`;
}

export interface Plan {
	quantity: number;
	worstPrice: number;
	/** 가장 나쁘게 체결됐을 때 금액 (수량 × 최악 허용가) */
	maxAmount: number;
}

/** 기준가·매도 가능 수량으로 수량과 최악 허용가를 정한다. 낼 수 없으면 이유 */
export function planOrder(rule: OrderRule, ctx: { market: Market; ref: number; sellable?: number }): Plan | { error: string } {
	if (!(ctx.ref > 0)) return { error: "기준가를 알 수 없습니다 (호가·종가 없음)" };
	const buy = rule.side === "BUY";
	const worst = roundPrice(ctx.market, ctx.ref * (1 + ((buy ? 1 : -1) * rule.worstPct) / 100), buy ? "down" : "up");
	if (!(worst > 0)) return { error: "최악 허용가가 0 이하입니다" };
	let qty: number;
	const s = rule.size;
	if ("shares" in s) qty = s.shares;
	else if ("amount" in s) qty = Math.floor(s.amount / worst);
	else qty = Math.floor(((ctx.sellable ?? 0) * s.holdingPct) / 100 + 1e-9);
	if (!buy) {
		if (ctx.sellable === undefined) return { error: "매도 가능 수량을 확인하지 못했습니다" };
		if (ctx.sellable <= 0) return { error: "매도 가능 수량이 없습니다" };
		qty = Math.min(qty, ctx.sellable);
	}
	if (qty < 1) return { error: "amount" in s ? `금액이 1주 최악 허용가(${worst})보다 작습니다` : "주문할 수량이 1주보다 작습니다" };
	return { quantity: qty, worstPrice: worst, maxAmount: qty * worst };
}

/** 정규장 안인가 — 아니면 이유. 휴장일은 따로 보지 않는다 (봉이 안 와서 신호도 없다) */
export function sessionProblem(venue: "krx" | "us", now: number): string | null {
	const m = MARKETS[venue];
	const d = localDate(now, m.tz);
	if (d.weekday === 0 || d.weekday === 6) return `${m.label} 휴장(주말)`;
	const s = sessionOf({ market: { venue, symbol: "" } }, d.ymd);
	const clock = localClock(now, m.tz).hm;
	if (now < s.open || now >= s.close) return `${m.label} 정규장 밖 (현지 ${clock})`;
	if (venue === "krx" && now >= s.close - KRX_CLOSING_CALL_MIN * 60_000) return "국장 종가 단일가 시간 (15:20 뒤) — 새 주문을 내지 않습니다";
	return null;
}

/** 하루 매수 한도 — 한도가 없으면 매수하지 않는다 */
export function dailyLimitProblem(maxAmount: number, spentToday: number, limit: number | null, currency: "KRW" | "USD"): string | null {
	const f = (v: number) => (currency === "KRW" ? `${Math.round(v).toLocaleString("en-US")}원` : `$${v.toFixed(2)}`);
	if (limit === null || !(limit > 0)) return `하루 매수 한도(${currency})가 없습니다 — 설정 → 감시 → 자동 매매 한도`;
	if (spentToday + maxAmount > limit + 1e-9) return `하루 매수 한도 초과 — 오늘 ${f(spentToday)} + 이번 최대 ${f(maxAmount)} > 한도 ${f(limit)}`;
	return null;
}

/** 하루 한도를 세는 날 — 시장 현지 날짜 */
export function tradingDay(venue: "krx" | "us", now: number): string {
	return localDate(now, MARKETS[venue].tz).ymd;
}

export const currencyOf = (venue: "krx" | "us"): "KRW" | "USD" => (venue === "krx" ? "KRW" : "USD");

/** 주문 동작 한 줄 — "매수 5,000,000원어치 · 한국투자 ****-01 · 최악 +1% · 기다리며 60초" */
export function orderText(a: { target: OrderTarget; order: OrderRule; protect?: ProtectRule; position?: Position }, venue: "krx" | "us"): string {
	const r = a.order;
	const how = r.urgency === "patient" ? `기다리며 ${r.deadlineSec}초` : `즉시 (${r.deadlineSec}초 안)`;
	const base = `${r.side === "BUY" ? "매수" : "매도"} ${sizeText(r.size, currencyOf(venue))} · ${a.target.accountLabel} · 최악 ${r.side === "BUY" ? "+" : "−"}${r.worstPct}% · ${how}`;
	if (a.position) return `보호 ${a.position.shares}주 (평단 ${a.position.avgPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}) · ${a.target.accountLabel}`;
	if (a.protect) return `${base} → 체결 후 ${protectRuleText(a.protect)}`;
	return base;
}

// ── 보호 (연계주문, PLAN §40 2-C) ──

export const PROTECT_STOP_PCT = [0.5, 50] as const;
export const PROTECT_TAKE_PCT = [0.5, 500] as const;
/** 보호 매도는 손절이 먼저다 — 즉시, 최악 −2%, 30초 */
export const PROTECT_SELL: Omit<OrderRule, "size"> = { side: "SELL", worstPct: 2, urgency: "immediate", deadlineSec: 30 };
/** 보호 트리거는 포지션이 남아 있는 동안 — 부모 만료 + 30일 (또는 보유 종목 보호는 켤 때 + 90일) */
export const PROTECT_EXTRA_DAYS = 30;

export function validateProtect(p: ProtectRule): string[] {
	const e: string[] = [];
	if (!p.stop && !p.take) e.push("손절·익절 중 하나는 정해야 합니다");
	const chk = (l: ProtectLevel | undefined, what: string, range: readonly [number, number]) => {
		if (!l) return;
		if ("pct" in l && !(l.pct >= range[0] && l.pct <= range[1])) e.push(`${what}은 평단 대비 ${range[0]}~${range[1]}% 입니다`);
		if ("price" in l && !(l.price > 0 && Number.isFinite(l.price))) e.push(`${what} 가격은 0보다 커야 합니다`);
	};
	chk(p.stop, "손절", PROTECT_STOP_PCT);
	chk(p.take, "익절", PROTECT_TAKE_PCT);
	return e;
}

/** 평단으로 손절·익절 가격 — 손절은 호가 단위 내림, 익절은 올림 (조건은 종가 < 손절가 · 종가 > 익절가) */
export function protectPrices(p: Pick<ProtectRule, "stop" | "take">, avg: number, market: Market): { stopPrice: number | null; takePrice: number | null; problems: string[] } {
	const stopPrice = p.stop ? ("price" in p.stop ? p.stop.price : roundPrice(market, avg * (1 - p.stop.pct / 100), "down")) : null;
	const takePrice = p.take ? ("price" in p.take ? p.take.price : roundPrice(market, avg * (1 + p.take.pct / 100), "up")) : null;
	const problems: string[] = [];
	if (stopPrice !== null && takePrice !== null && !(stopPrice < takePrice)) problems.push("손절가가 익절가보다 낮아야 합니다");
	return { stopPrice, takePrice, problems };
}

/** 보호 트리거의 조건 — 종가 < 손절가 또는 종가 > 익절가, 참인 봉마다 (잔량을 다시 판다) */
export function protectCondition(base: Pick<Condition, "market">, interval: Interval, pos: Pick<Position, "stopPrice" | "takePrice">): Condition {
	const legs: CondNode[] = [
		...(pos.stopPrice !== null ? [{ left: "close" as const, op: "<" as const, right: pos.stopPrice }] : []),
		...(pos.takePrice !== null ? [{ left: "close" as const, op: ">" as const, right: pos.takePrice }] : []),
	];
	return {
		market: base.market,
		interval,
		when: "bar_close",
		all: legs.length === 1 ? legs : [{ any: legs }],
		confirmBars: 1,
		fire: "while_true",
	};
}

/** 이 봉 종가가 손절인가 익절인가 */
export function protectLeg(pos: Pick<Position, "stopPrice" | "takePrice">, close: number): "stop" | "take" | null {
	if (pos.stopPrice !== null && close < pos.stopPrice) return "stop";
	if (pos.takePrice !== null && close > pos.takePrice) return "take";
	return null;
}

/** "손절 < 67,600 (평단 −5%) · 익절 > 78,400 (+10%) · 1분봉 종가" */
export function protectText(p: { stopPrice: number | null; takePrice: number | null; avgPrice?: number }, interval: Interval): string {
	const f = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
	const pct = (v: number) => (p.avgPrice ? ` (평단 ${v >= p.avgPrice ? "+" : "−"}${Math.abs(Math.round(((v - p.avgPrice) / p.avgPrice) * 1000) / 10)}%)` : "");
	const bits = [...(p.stopPrice !== null ? [`손절 < ${f(p.stopPrice)}${pct(p.stopPrice)}`] : []), ...(p.takePrice !== null ? [`익절 > ${f(p.takePrice)}${pct(p.takePrice)}`] : [])];
	return `${bits.join(" · ")} · ${INTERVAL_LABEL[interval] ?? interval} 종가`;
}

/** 매수 카드의 "체결 후 자동" 한 줄 — 가격은 평단이 정해진 뒤라 % 로 */
export function protectRuleText(p: ProtectRule): string {
	const lv = (l: ProtectLevel, sign: string) => ("pct" in l ? `평단 ${sign}${l.pct}%` : l.price.toLocaleString("en-US"));
	const bits = [...(p.stop ? [`손절 ${lv(p.stop, "−")}`] : []), ...(p.take ? [`익절 ${lv(p.take, "+")}`] : [])];
	return `${bits.join(" · ")} (${INTERVAL_LABEL[p.interval] ?? p.interval} 종가)`;
}

/** 새 주문을 낼 수 있는 남은 시간 (ms) — 국장은 종가 단일가 전까지. 체결 제한 시간을 여기에 맞춘다 */
export function sessionRemainingMs(venue: "krx" | "us", now: number): number {
	const m = MARKETS[venue];
	const s = sessionOf({ market: { venue, symbol: "" } }, localDate(now, m.tz).ymd);
	const end = venue === "krx" ? s.close - KRX_CLOSING_CALL_MIN * 60_000 : s.close;
	return Math.max(0, end - now);
}
