/**
 * 규칙 · 리스크 (PLAN §40 2단계) — 수량·최악 허용가, 정규장, 하루 매수 한도.
 *
 * 지켜야 할 것:
 *   - 금액 주문은 최악 허용가로 나눠 내림 — 가장 나쁘게 체결돼도 금액을 넘지 않는다
 *   - 매도는 매도 가능 수량을 넘지 않는다, 모르면 내지 않는다
 *   - 정규장 밖·국장 종가 단일가·주말엔 내지 않는다
 *   - 한도가 없으면 매수하지 않는다
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dailyLimitProblem, planOrder, protectCondition, protectLeg, protectPrices, protectText, sessionProblem, sizeText, tradingDay, validateOrderRule, validateProtect } from "../src/triggers/rule.ts";
import { fireIndices } from "../src/triggers/condition.ts";
import type { OrderRule } from "../src/triggers/types.ts";

const rule = (o: Partial<OrderRule> = {}): OrderRule => ({ side: "BUY", size: { shares: 10 }, worstPct: 1, urgency: "patient", deadlineSec: 60, ...o });
const kst = (s: string) => Date.parse(`${s}+09:00`);

describe("규칙", () => {
	it("매수 최악 허용가 = 기준가 +% 를 호가 단위로 내림", () => {
		assert.deepEqual(planOrder(rule(), { market: "KR", ref: 71_050 }), { quantity: 10, worstPrice: 71_700, maxAmount: 717_000 });
		const us = planOrder(rule({ worstPct: 0.5 }), { market: "US", ref: 190.13 });
		assert.ok(!("error" in us));
		assert.equal(us.worstPrice, 191.08); // 191.08065 → 내림
	});

	it("금액 주문은 최악 허용가로 나눠 내림 — 금액을 넘지 않는다", () => {
		const p = planOrder(rule({ size: { amount: 5_000_000 } }), { market: "KR", ref: 71_000 });
		assert.ok(!("error" in p));
		assert.equal(p.worstPrice, 71_700);
		assert.equal(p.quantity, 69);
		assert.ok(p.maxAmount <= 5_000_000);
		const small = planOrder(rule({ size: { amount: 50_000 } }), { market: "KR", ref: 71_000 });
		assert.match((small as { error: string }).error, /1주 최악 허용가/);
	});

	it("매도 — 기준가 −% 를 올림, 매도 가능 수량으로 자른다", () => {
		const p = planOrder(rule({ side: "SELL", worstPct: 2, size: { shares: 50 } }), { market: "KR", ref: 71_050, sellable: 30 });
		assert.deepEqual(p, { quantity: 30, worstPrice: 69_700, maxAmount: 30 * 69_700 });
		assert.deepEqual(planOrder(rule({ side: "SELL", size: { holdingPct: 50 } }), { market: "KR", ref: 71_000, sellable: 7 }), { quantity: 3, worstPrice: 70_300, maxAmount: 210_900 });
		assert.equal((planOrder(rule({ side: "SELL", size: { holdingPct: 100 } }), { market: "KR", ref: 71_000, sellable: 7 }) as { quantity: number }).quantity, 7);
		assert.match((planOrder(rule({ side: "SELL" }), { market: "KR", ref: 71_000, sellable: 0 }) as { error: string }).error, /매도 가능 수량이 없습니다/);
		assert.match((planOrder(rule({ side: "SELL" }), { market: "KR", ref: 71_000 }) as { error: string }).error, /확인하지 못했습니다/);
		assert.match((planOrder(rule({ side: "SELL", size: { holdingPct: 10 } }), { market: "KR", ref: 71_000, sellable: 5 }) as { error: string }).error, /1주보다 작습니다/);
	});

	it("기준가가 없으면 내지 않는다", () => {
		assert.match((planOrder(rule(), { market: "KR", ref: 0 }) as { error: string }).error, /기준가/);
	});

	it("검증 — 수량 하나만, 범위", () => {
		assert.deepEqual(validateOrderRule(rule()), []);
		assert.equal(validateOrderRule(rule({ size: { shares: 1.5 } })).length, 1);
		assert.equal(validateOrderRule(rule({ size: { shares: 1, amount: 5 } as never })).length, 1);
		assert.equal(validateOrderRule(rule({ size: { holdingPct: 50 } })).length, 1); // 매수에 보유 %
		assert.equal(validateOrderRule(rule({ worstPct: 20 })).length, 1);
		assert.equal(validateOrderRule(rule({ deadlineSec: 5 })).length, 1);
	});

	it("수량 문구", () => {
		assert.equal(sizeText({ amount: 5_000_000 }, "KRW"), "5,000,000원어치");
		assert.equal(sizeText({ amount: 1500 }, "USD"), "$1,500어치");
		assert.equal(sizeText({ shares: 3 }, "KRW"), "3주");
		assert.equal(sizeText({ holdingPct: 50 }, "KRW"), "매도 가능 수량의 50%");
	});
});

describe("리스크", () => {
	it("국장 정규장 — 09:00 부터, 종가 단일가(15:20) 전까지", () => {
		assert.match(sessionProblem("krx", kst("2026-09-28T08:59:00"))!, /정규장 밖/);
		assert.equal(sessionProblem("krx", kst("2026-09-28T09:00:00")), null);
		assert.equal(sessionProblem("krx", kst("2026-09-28T15:19:59")), null);
		assert.match(sessionProblem("krx", kst("2026-09-28T15:20:00"))!, /종가 단일가/);
		assert.match(sessionProblem("krx", kst("2026-09-28T15:30:00"))!, /정규장 밖/);
		assert.match(sessionProblem("krx", kst("2026-09-27T10:00:00"))!, /주말/);
		// 수능일 10:00–16:30
		assert.match(sessionProblem("krx", kst("2026-11-19T09:30:00"))!, /정규장 밖/);
		assert.equal(sessionProblem("krx", kst("2026-11-19T16:00:00")), null);
	});

	it("미장 정규장 — 뉴욕 09:30–16:00 (서머타임), 조기 폐장", () => {
		assert.match(sessionProblem("us", Date.parse("2026-09-28T13:29:00Z"))!, /정규장 밖/); // 09:29 EDT
		assert.equal(sessionProblem("us", Date.parse("2026-09-28T13:30:00Z")), null);
		assert.equal(sessionProblem("us", Date.parse("2026-09-28T19:59:00Z")), null);
		assert.match(sessionProblem("us", Date.parse("2026-09-28T20:00:00Z"))!, /정규장 밖/);
		assert.match(sessionProblem("us", Date.parse("2026-11-27T18:30:00Z"))!, /정규장 밖/); // 13:30 EST, 조기 폐장
		// 뉴욕 금요일 밤 = 한국 토요일 아침 — 현지 요일로 본다
		assert.equal(sessionProblem("us", Date.parse("2026-10-02T15:00:00Z")), null);
		assert.equal(tradingDay("us", Date.parse("2026-10-03T00:30:00Z")), "2026-10-02");
	});

	it("하루 매수 한도 — 없으면 매수 안 함, 넘으면 거절", () => {
		assert.match(dailyLimitProblem(100, 0, null, "KRW")!, /한도\(KRW\)가 없습니다/);
		assert.equal(dailyLimitProblem(4_000_000, 5_000_000, 10_000_000, "KRW"), null);
		assert.match(dailyLimitProblem(5_000_001, 5_000_000, 10_000_000, "KRW")!, /한도 초과/);
		assert.match(dailyLimitProblem(600, 500, 1000, "USD")!, /\$500\.00/);
	});
});

describe("보호 (연계주문)", () => {
	it("평단으로 손절(내림)·익절(올림), 고정가, 손절 < 익절", () => {
		assert.deepEqual(protectPrices({ stop: { pct: 5 }, take: { pct: 10 } }, 71_200, "KR"), { stopPrice: 67_600, takePrice: 78_400, problems: [] });
		assert.deepEqual(protectPrices({ stop: { price: 180 } }, 190.1, "US"), { stopPrice: 180, takePrice: null, problems: [] });
		assert.equal(protectPrices({ stop: { price: 80_000 }, take: { price: 75_000 } }, 71_000, "KR").problems.length, 1);
		assert.deepEqual(validateProtect({ interval: "1m" }), ["손절·익절 중 하나는 정해야 합니다"]);
		assert.equal(validateProtect({ stop: { pct: 60 }, interval: "1m" }).length, 1);
		assert.equal(validateProtect({ take: { price: -1 }, interval: "1m" }).length, 1);
	});

	it("조건 — 한쪽이면 절 하나, 둘이면 OR. 참인 봉마다 (while_true)", () => {
		const market = { venue: "krx" as const, symbol: "005930", feed: { provider: "kis" as const, basis: "krx" as const } };
		const one = protectCondition({ market }, "1m", { stopPrice: 67_600, takePrice: null });
		assert.deepEqual(one.all, [{ left: "close", op: "<", right: 67_600 }]);
		assert.equal(one.fire, "while_true");
		const both = protectCondition({ market }, "5m", { stopPrice: 67_600, takePrice: 78_400 });
		assert.deepEqual(both.all, [{ any: [{ left: "close", op: "<", right: 67_600 }, { left: "close", op: ">", right: 78_400 }] }]);
		assert.equal(protectLeg({ stopPrice: 67_600, takePrice: 78_400 }, 67_500), "stop");
		assert.equal(protectLeg({ stopPrice: 67_600, takePrice: 78_400 }, 78_500), "take");
		assert.equal(protectLeg({ stopPrice: 67_600, takePrice: 78_400 }, 70_000), null);
		assert.match(protectText({ stopPrice: 67_600, takePrice: 78_400, avgPrice: 71_200 }, "1m"), /손절 < 67,600 \(평단 −5.1%\) · 익절 > 78,400 \(평단 \+10.1%\) · 1분봉 종가/);
	});

	it("while_true 는 참인 봉마다, on_enter 는 처음만", () => {
		const bars = [100, 90, 80, 95, 85].map((c, i) => ({ t: i * 60_000, open: c, high: c, low: c, close: c, volume: 1 }));
		const c = { market: { venue: "binance" as const, symbol: "X" }, interval: "1m" as const, when: "bar_close" as const, all: [{ left: "close" as const, op: "<" as const, right: 92 }], confirmBars: 1 };
		assert.deepEqual(fireIndices({ ...c, fire: "on_enter" }, bars), [1, 4]);
		assert.deepEqual(fireIndices({ ...c, fire: "while_true" }, bars), [1, 2, 4]);
	});
});

describe("남은 장 시간", () => {
	it("국장은 종가 단일가 전까지, 미장은 마감까지", async () => {
		const { sessionRemainingMs } = await import("../src/triggers/rule.ts");
		assert.equal(sessionRemainingMs("krx", Date.parse("2026-09-28T15:19:30+09:00")), 30_000);
		assert.equal(sessionRemainingMs("krx", Date.parse("2026-09-28T15:25:00+09:00")), 0);
		assert.equal(sessionRemainingMs("us", Date.parse("2026-09-28T19:59:00Z")), 60_000);
	});
});
