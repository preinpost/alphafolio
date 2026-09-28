/**
 * watch_alert 자동 매매 준비 (PLAN §40 2단계) — 주문 동작이 서명 대상(스펙)에 그대로 담기는가, 준비 단계에서 막을 것을 막는가.
 *
 * 지켜야 할 것:
 *   - 주문 계좌가 둘이면 고르지 않는다 (사용자에게 묻게 한다)
 *   - 코인·자동 매매 꺼짐·계좌 없음은 준비하지 않는다
 *   - 자동 매매는 최대 횟수가 필수 (기본 1)
 *   - 매수 한도가 없으면 카드에 "지금은 켤 수 없다" 경고
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWatchTools, type WatchConfirmCard } from "../src/triggers/tool.ts";
import type { Condition, OrderTarget, TriggerSpec, WatchBar } from "../src/triggers/types.ts";

const D = 86_400_000;
const T0 = Date.parse("2026-05-01T00:00:00Z");
const bars = (n: number): WatchBar[] => Array.from({ length: n }, (_, i) => ({ t: T0 + i * D, open: 70_000, high: 71_000, low: 69_000, close: 70_000, volume: 100 }));
const KIS: OrderTarget = { broker: "kis", account: "aaa", accountLabel: "한국투자 ****78-01" };
const TOSS: OrderTarget = { broker: "toss", account: "7", accountLabel: "토스 ****1234" };

function setup(o: { targets?: OrderTarget[]; limits?: Record<"KRW" | "USD", number | null>; off?: string | null; position?: { sellable: number; avgPrice: number | null } } = {}) {
	const prepared: TriggerSpec[] = [];
	const [tool] = createWatchTools({
		prepareWatch: (s) => (prepared.push(s), { token: "tok", expiresAt: 99 }),
		listWatches: async () => [],
		pauseWatch: async () => {
			throw new Error("no");
		},
		channels: () => ["telegram"],
		fetchBars: async (_c: Condition, limit: number) => bars(300).slice(-limit),
		feeds: () => ({ kis: true, toss: true }),
		orderTargets: async () => o.targets ?? [KIS],
		tradeLimits: async () => o.limits ?? { KRW: 10_000_000, USD: null },
		autoTradeOff: () => o.off ?? null,
		position: async () => o.position ?? { sellable: 10, avgPrice: 71_200 },
		now: () => Date.parse("2026-09-28T01:00:00Z"),
	});
	const run = async (p: Record<string, unknown>) => (await tool!.execute("id", p as never, undefined, undefined, undefined as never)) as { content: Array<{ text: string }>; details: WatchConfirmCard };
	return { run, prepared };
}

const base = { action: "prepare", symbol: "005930", interval: "1d", all: [{ left: "close", op: ">", right: 72_000 }] };

describe("watch_alert 자동 매매", () => {
	it("매수 — 스펙에 계좌·규칙(기본값)이 담기고 횟수는 기본 1", async () => {
		const { run, prepared } = setup();
		const r = await run({ ...base, order: { side: "BUY", amount: 5_000_000 } });
		const a = prepared[0]!.action;
		assert.equal(a.kind, "order");
		assert.deepEqual(a.kind === "order" && a.target, KIS);
		assert.deepEqual(a.kind === "order" && a.order, { side: "BUY", size: { amount: 5_000_000 }, worstPct: 1, urgency: "patient", deadlineSec: 60 });
		assert.equal(prepared[0]!.limits.maxFires, 1);
		assert.equal(r.details.order?.size, "5,000,000원어치");
		assert.equal(r.details.order?.dailyLimit, "10,000,000원");
		assert.match(r.details.order?.estimate ?? "", /약 70주/); // 5,000,000 / 70,700
		assert.match(r.content[0]!.text, /확인 없이 주문이 나간다/);
	});

	it("매도 기본값 — 즉시·2%·30초, 한도 없음", async () => {
		const { run, prepared } = setup();
		const r = await run({ ...base, order: { side: "SELL", holdingPct: 100 }, maxFires: 2 });
		const a = prepared[0]!.action;
		assert.deepEqual(a.kind === "order" && a.order, { side: "SELL", size: { holdingPct: 100 }, worstPct: 2, urgency: "immediate", deadlineSec: 30 });
		assert.equal(prepared[0]!.limits.maxFires, 2);
		assert.equal(r.details.order?.dailyLimit, null);
		assert.match(r.details.order?.worst ?? "", /−2%/);
	});

	it("계좌가 둘이면 고르지 않고 묻게 한다, 고르면 그 계좌", async () => {
		const { run, prepared } = setup({ targets: [KIS, TOSS] });
		await assert.rejects(run({ ...base, order: { side: "BUY", shares: 1 } }), /사용자에게 물어보세요: kis = 한국투자 \*\*\*\*78-01 · toss = 토스 \*\*\*\*1234/);
		await run({ ...base, order: { side: "BUY", shares: 1, broker: "toss" } });
		const a = prepared[0]!.action;
		assert.deepEqual(a.kind === "order" && a.target, TOSS);
	});

	it("막는 것 — 코인·꺼짐·계좌 없음·수량 둘·범위", async () => {
		await assert.rejects(setup().run({ action: "prepare", symbol: "ETHUSDT", interval: "1h", all: [{ left: "close", op: ">", right: 1 }], order: { side: "BUY", shares: 1 } }), /코인 자동 매매/);
		await assert.rejects(setup({ off: "서버에서 자동 매매를 껐습니다" }).run({ ...base, order: { side: "BUY", shares: 1 } }), /껐습니다/);
		await assert.rejects(setup({ targets: [] }).run({ ...base, order: { side: "BUY", shares: 1 } }), /주문할 증권 계좌가 없습니다/);
		await assert.rejects(setup().run({ ...base, order: { side: "BUY", shares: 1, amount: 100 } }), /하나만/);
		await assert.rejects(setup().run({ ...base, order: { side: "BUY" } }), /수량이 필요합니다/);
		await assert.rejects(setup().run({ ...base, order: { side: "BUY", shares: 1, worstPct: 30 } }), /최악 허용가/);
		await assert.rejects(setup().run({ ...base, order: { side: "BUY", holdingPct: 50 } }), /매도에만/);
	});

	it("매수 한도가 없거나 주문 금액이 한도보다 크면 경고", async () => {
		const r = await setup({ limits: { KRW: null, USD: null } }).run({ ...base, order: { side: "BUY", shares: 1 } });
		assert.ok(r.details.warnings.some((w) => /하루 매수 한도\(KRW\)가 없어 지금은 켤 수 없습니다/.test(w)));
		const r2 = await setup({ limits: { KRW: 1_000_000, USD: null } }).run({ ...base, order: { side: "BUY", amount: 3_000_000 } });
		assert.ok(r2.details.warnings.some((w) => /한도 1,000,000원 보다 커서/.test(w)));
	});

	it("알림만이면 order 가 없다", async () => {
		const { run, prepared } = setup();
		const r = await run(base);
		assert.deepEqual(prepared[0]!.action, { kind: "notify" });
		assert.equal(r.details.order, null);
	});
});

describe("연계주문 — 매수 후 보호 · 보유 종목 보호", () => {
	it("매수 order.protect — 스펙에 보호 규칙, 카드에 '체결 후 자동'", async () => {
		const { run, prepared } = setup();
		const r = await run({ ...base, order: { side: "BUY", shares: 10, protect: { stopPct: 5, takePct: 10 } } });
		const a = prepared[0]!.action;
		assert.deepEqual(a.kind === "order" && a.protect, { stop: { pct: 5 }, take: { pct: 10 }, interval: "1m" });
		assert.match(r.details.order?.protect ?? "", /체결 후 자동: 손절 평단 −5% · 익절 평단 \+10% \(1분봉 종가\)/);
		await assert.rejects(setup().run({ ...base, order: { side: "SELL", shares: 1, protect: { stopPct: 5 } } }), /매수에만/);
		await assert.rejects(setup().run({ ...base, order: { side: "BUY", shares: 1, protect: {} } }), /하나는 정해야/);
		await assert.rejects(setup().run({ ...base, order: { side: "BUY", shares: 1, protect: { stopPct: 5, stopPrice: 60_000 } } }), /하나만/);
	});

	it("action=protect — 평단·매도 가능 수량으로 한 트리거 (while_true, 횟수 없음)", async () => {
		const { run, prepared } = setup({ position: { sellable: 7, avgPrice: 71_200 } });
		const r = await run({ action: "protect", symbol: "005930", protect: { stopPct: 5, takePct: 10, interval: "5m" } });
		const s = prepared[0]!;
		assert.equal(s.condition.fire, "while_true");
		assert.equal(s.condition.interval, "5m");
		assert.deepEqual(s.condition.all, [{ any: [{ left: "close", op: "<", right: 67_600 }, { left: "close", op: ">", right: 78_400 }] }]);
		assert.equal(s.limits.maxFires, null);
		const a = s.action;
		assert.ok(a.kind === "order");
		assert.deepEqual(a.position, { shares: 7, avgPrice: 71_200, stopPrice: 67_600, takePrice: 78_400, parentId: null });
		assert.deepEqual(a.order, { side: "SELL", size: { shares: 7 }, worstPct: 2, urgency: "immediate", deadlineSec: 30 });
		assert.equal(r.details.order?.size, "7주 (매도 가능 7주)");
		assert.match(r.details.order?.protect ?? "", /손절 < 67,600/);
		assert.match(r.content[0]!.text, /확인 없이 판다/);
	});

	it("action=protect — 지금 이미 손절가 아래면 경고, 수량·평단 문제는 준비하지 않는다", async () => {
		const r = await setup({ position: { sellable: 7, avgPrice: 80_000 } }).run({ action: "protect", symbol: "005930", protect: { stopPct: 5 } });
		assert.ok(r.details.warnings.some((w) => /이미 손절가 아래/.test(w)));
		await assert.rejects(setup({ position: { sellable: 0, avgPrice: 1 } }).run({ action: "protect", symbol: "005930", protect: { stopPct: 5 } }), /매도 가능 수량이 없습니다/);
		await assert.rejects(setup().run({ action: "protect", symbol: "005930", shares: 11, protect: { stopPct: 5 } }), /매도 가능 수량\(10주\)보다 많습니다/);
		await assert.rejects(setup({ position: { sellable: 5, avgPrice: null } }).run({ action: "protect", symbol: "005930", protect: { stopPct: 5 } }), /평단을 몰라/);
		const ok = await setup({ position: { sellable: 5, avgPrice: null } }).run({ action: "protect", symbol: "005930", protect: { stopPrice: 60_000 } });
		assert.equal(ok.details.order?.estimate, null);
		await assert.rejects(setup({ targets: [KIS, TOSS] }).run({ action: "protect", symbol: "005930", protect: { stopPct: 5 } }), /어느 증권사에 가진 종목인지/);
		await assert.rejects(setup().run({ action: "protect", symbol: "ETHUSDT", protect: { stopPct: 5 } }), /코인/);
	});
});
