/**
 * watch_alert 자동 매매 준비 (PLAN §40 2단계) — 주문 동작이 서명 대상(스펙)에 그대로 담기는가, 준비 단계에서 막을 것을 막는가.
 *
 * 지켜야 할 것:
 *   - 주문 계좌가 둘이면 고르지 않는다 (사용자에게 묻게 한다)
 *   - 자동 매매 꺼짐·계좌 없음은 준비하지 않는다. 코인은 Binance 계정으로만, USDT 마켓만, 코인 수량(qty)·USDT 금액으로
 *   - 자동 매매는 최대 횟수가 필수 (기본 1)
 *   - 매수 한도가 없으면 카드에 "지금은 켤 수 없다" 경고
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWatchTools, type WatchConfirmCard } from "../src/triggers/tool.ts";
import type { Condition, OrderTarget, TriggerSpec, WatchBar } from "../src/triggers/types.ts";
import { cryptoGrid } from "../src/triggers/venues/binance.ts";
import { equityGrid } from "../src/triggers/venues/binance-stock.ts";
import { parseEquityRules } from "../src/binance/stocks.ts";
import type { SymbolRules } from "../src/binance/trade.ts";

const D = 86_400_000;
const T0 = Date.parse("2026-05-01T00:00:00Z");
const bars = (n: number): WatchBar[] => Array.from({ length: n }, (_, i) => ({ t: T0 + i * D, open: 70_000, high: 71_000, low: 69_000, close: 70_000, volume: 100 }));
const KIS: OrderTarget = { broker: "kis", account: "aaa", accountLabel: "한국투자 ****78-01" };
const TOSS: OrderTarget = { broker: "toss", account: "7", accountLabel: "토스 ****1234" };
const BINANCE: OrderTarget = { broker: "binance", account: "f00dcafe0000", accountLabel: "Binance 현물 (키 f00dca)" };
/** ETHUSDT 규칙 요약 — tick 0.01, step 0.0001, 최소 5 USDT */
/** AAPLBUSDT (bStock) 실측 규칙 — tick 0.01, step 0.001, 최소 5 USDT */
const AAPLB_RULES = (): SymbolRules => ({ ...ETH_RULES, symbol: "AAPLBUSDT", base: "AAPLB", stepSize: "0.00100000", minQty: "0.00100000" });
const ETH_RULES: SymbolRules = {
	symbol: "ETHUSDT", status: "TRADING", base: "ETH", quote: "USDT", orderTypes: ["LIMIT", "MARKET"], spot: true,
	tickSize: "0.01000000", minPrice: "0.01", maxPrice: "1000000", stepSize: "0.00010000", minQty: "0.00010000", maxQty: "9000",
	marketStepSize: "0.0001", marketMinQty: "0.0001", marketMaxQty: "9000", minNotional: "5.00000000", notionalAppliesToMarket: true,
};

function setup(o: { targets?: OrderTarget[]; limits?: Partial<Record<"KRW" | "USD" | "USDT", number | null>>; off?: string | null; position?: { sellable: number; avgPrice: number | null } } = {}) {
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
		// 네트워크 없이 — ETHUSDT 만 있다
		cryptoRules: async (symbol) => (symbol === "ETHUSDT" ? cryptoGrid(ETH_RULES) : null),
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

	it("막는 것 — 코인에 주식 계좌만·꺼짐·계좌 없음·수량 둘·범위", async () => {
		// 코인은 Binance 계정으로만 — 주식 계좌만 있으면 준비하지 않는다
		await assert.rejects(setup().run({ action: "prepare", symbol: "ETHUSDT", interval: "1h", all: [{ left: "close", op: ">", right: 1 }], order: { side: "BUY", qty: 1 } }), /Binance 계정이 없습니다/);
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
		await assert.rejects(setup().run({ action: "protect", symbol: "ETHUSDT", protect: { stopPct: 5 } }), /Binance 계정이 없습니다/);
	});
});

describe("코인 자동 매매 (Binance 현물 USDT 마켓)", () => {
	// 코인 봉 — 종가 2,600 USDT
	const coinBars = (n: number): WatchBar[] => Array.from({ length: n }, (_, i) => ({ t: T0 + i * 3_600_000, open: 2600, high: 2610, low: 2590, close: 2600, volume: 100 }));
	function coin(o: Parameters<typeof setup>[0] = {}) {
		const prepared: TriggerSpec[] = [];
		const [tool] = createWatchTools({
			prepareWatch: (s) => (prepared.push(s), { token: "tok", expiresAt: 99 }),
			listWatches: async () => [],
			pauseWatch: async () => {
				throw new Error("no");
			},
			channels: () => ["telegram"],
			fetchBars: async (_c: Condition, limit: number) => coinBars(1000).slice(-limit),
			orderTargets: async () => o.targets ?? [KIS, TOSS, BINANCE],
			tradeLimits: async () => o.limits ?? { KRW: 10_000_000, USD: null, USDT: 1000 },
			autoTradeOff: () => o.off ?? null,
			position: async () => o.position ?? { sellable: 0.53217, avgPrice: null },
			cryptoRules: async (symbol) => (symbol === "ETHUSDT" ? cryptoGrid(ETH_RULES) : symbol === "AAPLBUSDT" ? cryptoGrid(AAPLB_RULES()) : null),
			bStock: async (symbol) => (symbol === "AAPLBUSDT" ? { symbol, ticker: "AAPL", token: "AAPLB" } : null),
			binanceHint: async (raw) => (/(USDT|USDC|BTC|ETH)$/.test(raw) ? null : `Binance 심볼은 쌍 전체로 주세요 — ${raw} 후보: ${raw}BUSDT (bStock) · ${raw}USDT (코인)`),
			now: () => Date.parse("2026-09-28T01:00:00Z"),
		});
		const run = async (p: Record<string, unknown>) => (await tool!.execute("id", p as never, undefined, undefined, undefined as never)) as { content: Array<{ text: string }>; details: WatchConfirmCard };
		return { run, prepared };
	}
	const cbase = { action: "prepare", symbol: "ETHUSDT", interval: "1h", all: [{ left: "close", op: ">", right: 2700 }] };

	it("금액(USDT) 매수 — 계좌는 Binance 로 (주식 계좌가 둘이어도 묻지 않는다), 한도는 USDT", async () => {
		const { run, prepared } = coin();
		const r = await run({ ...cbase, order: { side: "BUY", amount: 500 } });
		const a = prepared[0]!.action;
		assert.ok(a.kind === "order");
		assert.deepEqual(a.target, BINANCE);
		assert.deepEqual(a.order, { side: "BUY", size: { amount: 500 }, worstPct: 1, urgency: "patient", deadlineSec: 60 });
		assert.equal(r.details.order?.size, "500 USDT어치");
		assert.equal(r.details.order?.dailyLimit, "1,000 USDT");
		// 2,600 × 1.01 = 2,626 → 500 / 2,626 = 0.19040… → 0.1904 ETH (수량 단위 0.0001 내림)
		assert.match(r.details.order?.estimate ?? "", /약 0\.1904 ETH/);
		assert.equal(r.details.feed, null);
		assert.ok(r.details.warnings.some((w) => /24시간/.test(w)));
	});

	it("코인 수량(qty)은 수량 단위로 내림, shares 는 코인에 쓰지 않는다", async () => {
		const { run, prepared } = coin();
		const r = await run({ ...cbase, order: { side: "SELL", qty: 0.123456 } });
		const a = prepared[0]!.action;
		assert.deepEqual(a.kind === "order" && a.order.size, { qty: 0.1234 });
		assert.equal(r.details.order?.size, "0.1234 ETH");
		await assert.rejects(coin().run({ ...cbase, order: { side: "BUY", shares: 1 } }), /qty\(코인 수량\)/);
		await assert.rejects(coin().run({ ...cbase, order: { side: "BUY", qty: 0.00001 } }), /최소 수량/);
		await assert.rejects(setup().run({ ...base, order: { side: "BUY", qty: 1 } }), /주식은 qty 대신 shares/);
	});

	it("USDT 마켓이 아니거나 규칙을 못 찾으면 준비하지 않는다", async () => {
		await assert.rejects(coin().run({ ...cbase, symbol: "ETHBTC", market: "binance", order: { side: "BUY", qty: 1 } }), /USDT 마켓만/);
		await assert.rejects(coin().run({ ...cbase, symbol: "FOOUSDT", order: { side: "BUY", qty: 1 } }), /종목 규칙을 찾지 못했습니다/);
		await assert.rejects(coin({ targets: [KIS] }).run({ ...cbase, order: { side: "BUY", qty: 1 } }), /Binance 계정이 없습니다/);
	});

	it("USDT 한도가 없으면 경고 (켤 수 없다), 최소 주문금액 미만이면 추정에 이유", async () => {
		const r = await coin({ limits: { KRW: 1, USD: 1, USDT: null } }).run({ ...cbase, order: { side: "BUY", amount: 500 } });
		assert.ok(r.details.warnings.some((w) => /하루 매수 한도\(USDT\)가 없어/.test(w)));
		const small = await coin().run({ ...cbase, order: { side: "BUY", amount: 3 } });
		assert.match(small.details.order?.estimate ?? "", /최소 주문금액/);
	});

	it("가진 코인 보호 — free 잔고(수량 단위 내림), 가격으로만 (Binance 는 평단이 없다)", async () => {
		const { run, prepared } = coin();
		const r = await run({ action: "protect", symbol: "ETHUSDT", protect: { stopPrice: 2400, takePrice: 3000 } });
		const a = prepared[0]!.action;
		assert.ok(a.kind === "order");
		assert.deepEqual(a.target, BINANCE);
		assert.deepEqual(a.order.size, { qty: 0.5321 });
		assert.deepEqual(a.position, { shares: 0.5321, avgPrice: 0, stopPrice: 2400, takePrice: 3000, parentId: null });
		assert.equal(prepared[0]!.condition.market.feed, undefined);
		assert.equal(r.details.order?.size, "0.5321 ETH (매도 가능 0.53217 ETH)");
		assert.ok(r.details.warnings.some((w) => /24시간/.test(w)));
		await assert.rejects(coin().run({ action: "protect", symbol: "ETHUSDT", protect: { stopPct: 5 } }), /평단을 주지 않아/);
		await assert.rejects(coin().run({ action: "protect", symbol: "ETHUSDT", qty: 1, protect: { stopPrice: 2400 } }), /매도 가능 수량/);
		await assert.rejects(coin().run({ action: "protect", symbol: "ETHUSDT", shares: 1, protect: { stopPrice: 2400 } }), /qty\(코인 수량\)/);
	});

	it("bStock(AAPLBUSDT) 주문은 bStock: true 없이는 거절 — 실제 주식 쪽을 알려 준다 (알림만이면 된다)", async () => {
		const p = { action: "prepare", symbol: "AAPLBUSDT", interval: "1h", all: [{ left: "close", op: ">", right: 2700 }] };
		await assert.rejects(coin().run({ ...p, order: { side: "BUY", amount: 100 } }), /AAPL 주식이 아니라 bStock.*market: 'us' \+ order\.broker: 'binance_stock'/);
		await assert.rejects(coin().run({ action: "protect", symbol: "AAPLBUSDT", protect: { stopPrice: 300 } }), /bStock: true/);
		const alert = await coin().run(p);
		assert.equal(alert.details.venue, "Binance bStock · AAPL");
	});

	it("bStock(AAPLBUSDT) — bStock: true 면 코인과 같은 길, 배지·경고, 토큰 수량", async () => {
		const { run, prepared } = coin({ position: { sellable: 1.2345, avgPrice: null } });
		const r = await run({ action: "prepare", symbol: "AAPLBUSDT", bStock: true, interval: "1h", all: [{ left: "close", op: ">", right: 2700 }], order: { side: "BUY", amount: 100 } });
		const a = prepared[0]!.action;
		assert.ok(a.kind === "order");
		assert.deepEqual(a.target, BINANCE);
		assert.equal(prepared[0]!.condition.market.venue, "binance");
		assert.equal(r.details.venue, "Binance bStock · AAPL");
		// 2,600 × 1.01 = 2,626 → 100 / 2,626 = 0.03808 → 0.038 AAPLB (수량 단위 0.001)
		assert.match(r.details.order?.estimate ?? "", /약 0\.038 AAPLB/);
		assert.ok(r.details.warnings.some((w) => /토큰화 증권/.test(w)));
		assert.ok(r.details.warnings.some((w) => /bStock 도 코인처럼 24시간/.test(w)));
		const p = await run({ action: "protect", symbol: "AAPLBUSDT", bStock: true, protect: { stopPrice: 300 } });
		assert.equal(p.details.order?.size, "1.234 AAPLB (매도 가능 1.2345 AAPLB)");
		assert.ok(p.details.warnings.some((w) => /나스닥 AAPL 시세가 아닙니다/.test(w)));
	});

	it("쌍이 아닌 Binance 티커는 고르지 않고 후보를 알린다 (알림만이어도)", async () => {
		await assert.rejects(coin().run({ action: "prepare", market: "binance", symbol: "STX", interval: "1h", all: [{ left: "close", op: ">", right: 1 }] }), /STXBUSDT \(bStock\) · STXUSDT \(코인\)/);
		await assert.rejects(coin().run({ action: "protect", market: "binance", symbol: "AAPL", protect: { stopPrice: 300 } }), /쌍 전체로/);
	});
});

describe("Binance 미국 주식 직접 거래 (broker: binance_stock)", () => {
	const BSTOCK: OrderTarget = { broker: "binance_stock", account: "5t0c4a1b2c3d", accountLabel: "Binance 미국 주식 (키 5t0c4a)" };
	const usBars = (n: number): WatchBar[] => Array.from({ length: n }, (_, i) => ({ t: T0 + i * D, open: 330, high: 335, low: 325, close: 332.5, volume: 100 }));
	function us(o: { targets?: OrderTarget[]; position?: { sellable: number; avgPrice: number | null } } = {}) {
		const prepared: TriggerSpec[] = [];
		const [tool] = createWatchTools({
			prepareWatch: (s) => (prepared.push(s), { token: "tok", expiresAt: 99 }),
			listWatches: async () => [],
			pauseWatch: async () => {
				throw new Error("no");
			},
			channels: () => ["telegram"],
			fetchBars: async (_c: Condition, limit: number) => usBars(300).slice(-limit),
			feeds: () => ({ kis: true, toss: false }),
			orderTargets: async () => o.targets ?? [KIS, BINANCE, BSTOCK],
			tradeLimits: async () => ({ KRW: null, USD: 1000, USDT: null }),
			position: async () => o.position ?? { sellable: 0.75, avgPrice: 300 },
			equityGrid: async (symbol) => (symbol === "AAPL" ? equityGrid(parseEquityRules({ symbols: [{ symbol: "AAPL", tradability: "BUY_SELL", fractionable: true, stepSize: "0.000000001", minNotional: "5" }] })!) : null),
			now: () => Date.parse("2026-09-28T01:00:00Z"),
		});
		const run = async (p: Record<string, unknown>) => (await tool!.execute("id", p as never, undefined, undefined, undefined as never)) as { content: Array<{ text: string }>; details: WatchConfirmCard };
		return { run, prepared };
	}
	const ubase = { action: "prepare", symbol: "AAPL", market: "us", interval: "1d", all: [{ left: "close", op: ">", right: 340 }] };

	it("미장 계좌가 여럿이면 묻는다 (Binance 현물 계정은 미장 후보가 아니다)", async () => {
		await assert.rejects(us().run({ ...ubase, order: { side: "BUY", amount: 100 } }), /kis = 한국투자 \*\*\*\*78-01 · binance_stock = Binance 미국 주식/);
	});

	it("금액 매수 — 소수점 주식 추정, 조건 봉은 증권 키 시세, 한도는 USD", async () => {
		const { run, prepared } = us();
		const r = await run({ ...ubase, order: { side: "BUY", amount: 100, broker: "binance_stock" } });
		const s = prepared[0]!;
		assert.ok(s.action.kind === "order");
		assert.deepEqual(s.action.target, BSTOCK);
		assert.deepEqual(s.condition.market.feed, { provider: "kis" });
		// 332.5 × 1.01 = 335.825 → 335.82 (0.01 내림), 100 / 335.82 = 0.297778571 주
		assert.match(r.details.order?.estimate ?? "", /약 0\.297779주|약 0\.297778주/);
		assert.equal(r.details.order?.dailyLimit, "$1,000");
		assert.ok(r.details.warnings.some((w) => /Nest Trading/.test(w)));
		assert.ok(r.details.warnings.some((w) => /tokenize=false/.test(w)));
		await assert.rejects(us().run({ ...ubase, symbol: "ZZZZ", order: { side: "BUY", amount: 100, broker: "binance_stock" } }), /거래할 수 없는 미국 주식/);
	});

	it("가진 주식 보호 — 체결 내역 추정 수량(소수점)·평단으로 %", async () => {
		const { run, prepared } = us({ targets: [BSTOCK] });
		const r = await run({ action: "protect", symbol: "AAPL", market: "us", protect: { stopPct: 5 } });
		const a = prepared[0]!.action;
		assert.ok(a.kind === "order");
		assert.deepEqual(a.position, { shares: 0.75, avgPrice: 300, stopPrice: 285, takePrice: null, parentId: null });
		assert.equal(r.details.order?.size, "0.75주 (매도 가능 0.75주)");
		assert.ok(r.details.warnings.some((w) => /체결 내역으로 추정/.test(w)));
	});
});

