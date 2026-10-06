import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyRangeReport, initialRangeState, rangeFillCost, rangeStopHit, rangeValuation,
	validateRange, type RangeTrade,
} from "../src/triggers/range.ts";
import { binanceSettlement } from "../src/triggers/venues/binance.ts";
import type { ExecReport } from "../src/triggers/executor.ts";
import type { Settlement } from "../src/triggers/venues/types.ts";
import type { TriggerSpec } from "../src/triggers/types.ts";
import { createRangeTools } from "../src/triggers/range-tool.ts";
import type { WatchToolDeps } from "../src/triggers/tool.ts";

const range = (overrides: Partial<RangeTrade> = {}): RangeTrade => ({
	buyPrice: 2700,
	sellPrice: 2720,
	stop: { pct: 5 },
	buyCostPct: 0.1,
	sellCostPct: 0.1,
	state: initialRangeState(),
	...overrides,
});

function report(qty: number, avg: number, settlement?: Settlement): ExecReport {
	return {
		status: "filled", filledQty: qty, avgPrice: avg, arrivalPrice: avg, slippageBps: 0, reason: null,
		children: [{
			n: 0, clientId: "x-0", orderId: "123", ref: null, price: avg,
			quantity: qty, ioc: true, state: "done", filledQty: qty, avgPrice: avg,
			reason: null, ...(settlement ? { settlement } : {}),
		}],
	};
}

const closeTo = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`);

describe("비용 포함 반복매매 회계", () => {
	it("매수 1,000 + 0.1% 원가와 예상 매도 비용을 모두 포함해 −5%를 계산한다", () => {
		const bought = applyRangeReport(range(), "buy", "BUY", report(1000 / 2700, 2700), 1);
		closeTo(bought.state.cost, 1001);
		const stopPrice = 1001 * 0.95 / (bought.state.qty * 0.999);
		closeTo(rangeValuation(bought, stopPrice)!.pnlPct, -5);
		assert.equal(rangeStopHit(bought, stopPrice + 0.01), false);
		assert.equal(rangeStopHit(bought, stopPrice), true);
		assert.ok(stopPrice > 2565, "비용을 포함하면 단순 가격 −5%보다 먼저 손절한다");
	});

	it("확인된 실제 비용이 설정 비용률보다 우선하며 실제 0원 비용도 존중한다", () => {
		const actual = rangeFillCost(report(1, 2700, { baseFeeQty: 0, quoteFee: 7 }), "BUY", 10);
		assert.deepEqual(actual, { qty: 1, amount: 2707, estimated: false });
		assert.deepEqual(rangeFillCost(report(1, 2700, { baseFeeQty: 0, quoteFee: 0 }), "BUY", 10), { qty: 1, amount: 2700, estimated: false });
	});

	it("기준 자산 수수료는 순수량에서 차감하고 금액 원가에 중복 가산하지 않는다", () => {
		const fill = rangeFillCost(report(1, 2700, { baseFeeQty: 0.001, quoteFee: 0 }), "BUY", 0.1);
		assert.deepEqual(fill, { qty: 0.999, amount: 2700, estimated: false });
		const mixed = rangeFillCost(report(1, 2700, { baseFeeQty: 0.001, quoteFee: null }), "BUY", 0.2);
		closeTo(mixed.amount, 2702.7);
		assert.equal(mixed.estimated, true);
	});

	it("부분 매도 원가를 비례 배분하고 정상 매도 완료 후에만 재매수한다", () => {
		let r = applyRangeReport(range(), "buy", "BUY", report(1, 2700), 1);
		r = applyRangeReport(r, "partial-sell", "SELL", report(0.4, 2720), 2);
		closeTo(r.state.qty, 0.6);
		closeTo(r.state.cost, 1621.62);
		closeTo(r.state.realizedPnl, 1088 * 0.999 - 2702.7 * 0.4);
		assert.equal(r.state.phase, "holding");
		r = applyRangeReport(r, "rest", "SELL", report(0.6, 2720), 3);
		assert.equal(r.state.phase, "buying");
		assert.equal(r.state.cycles, 1);
		closeTo(r.state.realizedPnl, 2720 * 0.999 - 2702.7);
		assert.equal(r.state.pnlEstimated, true);
	});

	it("로스컷을 확정하면 부분 매도 뒤에도 유지하며 매도 완료 후 stopped가 된다", () => {
		let r = applyRangeReport(range(), "buy", "BUY", report(1, 2700), 1);
		r.state.phase = "liquidating";
		r = applyRangeReport(r, "stop-1", "SELL", report(0.4, 2500), -100);
		assert.equal(r.state.phase, "liquidating");
		r = applyRangeReport(r, "stop-2", "SELL", report(0.6, 2800), -200);
		assert.equal(r.state.phase, "stopped");
		assert.equal(r.state.lastTradeBarT, 1);
	});

	it("고정 가격은 수수료와 별개로 정확한 경계에서 판정한다", () => {
		const r = applyRangeReport(range({ stop: { price: 2650 } }), "buy", "BUY", report(1, 2700), 1);
		assert.equal(rangeStopHit(r, 2650.01), false);
		assert.equal(rangeStopHit(r, 2650), true);
	});

	it("중복 보고를 반영하지 않고 결과 모름은 blocked로 전환한다", () => {
		const fill = report(1, 2700);
		const r = applyRangeReport(range(), "buy", "BUY", fill, 1);
		assert.deepEqual(applyRangeReport(r, "buy", "BUY", fill, 1), r);
		assert.equal(r.state.executions, 1);
		assert.equal(applyRangeReport(range(), "unknown", "BUY", { ...fill, status: "unknown" }, 1).state.phase, "blocked");
	});

	it("유효하지 않은 범위·비용·손절을 거절한다", () => {
		for (const patch of [
			{ sellPrice: 2700 }, { buyPrice: NaN }, { buyCostPct: NaN }, { sellCostPct: -1 },
			{ stop: { pct: 0 } }, { stop: { pct: 100 } }, { stop: { price: 2701 } },
			{ stop: { price: 2650, pct: 5 } },
		]) assert.ok(validateRange(range(patch)).length, JSON.stringify(patch));
		assert.deepEqual(validateRange(range({ buyCostPct: 0, sellCostPct: 0 })), []);
	});
});

describe("Binance 체결 수수료", () => {
	const assets = { base: "ETH", quote: "USDT" };
	it("기준·호가 자산 비용을 구분하고 체결 전량을 확인한다", () => {
		assert.deepEqual(binanceSettlement([
			{ qty: "0.4", commission: "0.0004", commissionAsset: "ETH" },
			{ qty: "0.6", commission: "1.62", commissionAsset: "USDT" },
		], 1, assets), { baseFeeQty: 0.0004, quoteFee: 1.62 });
		assert.throws(() => binanceSettlement([{ qty: "0.4", commission: "0", commissionAsset: "ETH" }], 1, assets), /전량/);
	});
	it("일부 체결만 외부 자산 비용이면 확인된 비용을 보존하고 나머지만 추정한다", () => {
		const settlement = binanceSettlement([
			{ qty: "0.4", quoteQty: "1080", commission: "20", commissionAsset: "USDT" },
			{ qty: "0.6", quoteQty: "1620", commission: "0.003", commissionAsset: "BNB" },
		], 1, assets);
		assert.deepEqual(settlement, { baseFeeQty: 0, quoteFee: null, knownQuoteFee: 20, unpricedQuoteAmount: 1620 });
		const fill = rangeFillCost(report(1, 2700, settlement), "BUY", 0.1);
		closeTo(fill.amount, 2700 + 20 + 1.62);
		assert.equal(fill.estimated, true);
	});
	it("외부 자산 비용은 환산을 꾸며내지 않고 금액 추정으로 표시한다", () => {
		assert.deepEqual(binanceSettlement([{ qty: "1", commission: "0.003", commissionAsset: "BNB" }], 1, assets), { baseFeeQty: 0, quoteFee: null });
		assert.throws(() => binanceSettlement([{ qty: "1", commission: "NaN", commissionAsset: "BNB" }], 1, assets), /올바르지/);
	});
});

describe("range_trade 준비", () => {
	function toolFixture() {
		const prepared: TriggerSpec[] = [];
		const deps: WatchToolDeps = {
			prepareWatch: (spec) => { prepared.push(spec); return { token: "signed", expiresAt: Date.now() + 600_000 }; },
			listWatches: async () => [], pauseWatch: async () => { throw new Error("not used"); }, channels: () => [],
			orderTargets: async () => [{ broker: "binance", account: "abc", accountLabel: "Binance" }],
			bStockStatus: async () => "coin",
			cryptoRules: async () => ({ floorQty: (q) => q, roundPrice: (p) => p, stepPrice: (p) => p, minQty: 0.001, minNotional: 5, unit: "ETH" }),
			fetchBars: async () => [{ t: 0, open: 2700, high: 2700, low: 2700, close: 2700, volume: 1 }],
			tradeLimits: async () => ({ USDT: 10_000 }),
		};
		const tool = createRangeTools(deps)[0]!;
		const args = { action: "prepare" as const, symbol: "ETH/USDT", interval: "5m" as const, buyPrice: 2700, sellPrice: 2720, amount: 1000, stopPct: 5, buyCostPct: 0.1, sellCostPct: 0.1 };
		return { deps, prepared, tool, args };
	}
	it("사용자 확인 카드만 발급하고 무기한 상태·가격 범위·비용을 모두 서명한다", async () => {
		const { tool, args, prepared } = toolFixture();
		const result = await tool.execute("test", args, undefined, undefined, undefined as never);
		const spec = prepared[0]!;
		assert.equal(spec.condition.interval, "5m");
		assert.equal(spec.condition.market.symbol, "ETHUSDT");
		assert.equal(spec.condition.fire, "while_true");
		assert.equal(spec.limits.maxFires, null);
		assert.match(spec.limits.expiresAt, /^9999/);
		assert.equal(spec.action.kind, "order");
		if (spec.action.kind === "order") assert.equal(spec.action.range?.state.phase, "buying");
		assert.equal(result.details.kind, "watch-confirm-card");
		assert.match(result.content[0]!.text, /아직 켜지지/);
	});
	it("비용률 미확인·두 손절 동시 지정·규모 중복이면 카드도 발급하지 않는다", async () => {
		const { tool, args, prepared } = toolFixture();
		for (const patch of [{ buyCostPct: undefined }, { sellCostPct: undefined }, { stopPrice: 2650 }, { qty: 0.1 }, { interval: undefined }]) {
			await assert.rejects(tool.execute("test", { ...args, ...patch }, undefined, undefined, undefined as never));
		}
		assert.equal(prepared.length, 0);
	});
	it("bStock·조회 실패 종목과 시장에 맞지 않는 계좌는 거절한다", async () => {
		const fixture = toolFixture();
		fixture.deps.bStockStatus = async () => "unknown";
		await assert.rejects(fixture.tool.execute("test", fixture.args, undefined, undefined, undefined as never), /확인된 현물/);
		fixture.deps.bStockStatus = async () => "coin";
		await assert.rejects(fixture.tool.execute("test", { ...fixture.args, broker: "kis" }, undefined, undefined, undefined as never), /계좌/);
	});
});
