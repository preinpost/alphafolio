import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { migrate } from "@alphafolio/ledger";
import {
	applyRangeReport, initialRangeState, rangeCondition, RANGE_FOREVER,
	type Book, type ChildOrder, type ExecReport, type ExecVenue, type Grid,
	type OrderTarget, type RangeTrade, type Settlement, type TriggerSpec, type VenuePlace,
} from "@alphafolio/broker";
import { installFakeD1, type FakeD1 } from "../../../packages/ledger/test/fake-d1.ts";
import { OrderRunner } from "../src/order-runner.ts";
import { OrderTokenGuard } from "../src/order-tokens.ts";
import { TradeStore, type ExecPlan } from "../src/trade-store.ts";
import { TriggerStore } from "../src/triggers.ts";
import { Watcher, type WatchEvent } from "../src/watcher.ts";
import { WatchOps, watchConfirmSecret, type WatchTokenPayload } from "../src/watch-api.ts";

const START = Date.parse("2026-09-28T01:00:00Z");
const STEP = 5 * 60_000;
const TARGET: OrderTarget = { broker: "binance", account: "test-account", accountLabel: "Binance" };
const GRID: Grid = {
	floorQty: (qty) => Math.floor(Number(qty.toPrecision(12)) * 1e6 + 1e-8) / 1e6,
	roundPrice: (price, dir) => (dir === "down" ? Math.floor(price * 100 + 1e-8) : Math.ceil(price * 100 - 1e-8)) / 100,
	stepPrice: (price, dir) => price + dir * 0.01,
	minQty: 0.000001, minNotional: 5, unit: "ETH",
};

class FakeVenue implements ExecVenue {
	label = "fake";
	market: ExecVenue["market"] = "CRYPTO";
	symbol = "ETHUSDT";
	grid = GRID;
	supportsIoc = true;
	idempotent = false;
	bid = 2700;
	ask = 2700;
	placed: VenuePlace[] = [];
	orders = new Map<string, { request: VenuePlace; qty: number; price: number; open: boolean }>();
	fills: number[] = [];
	cost: Settlement = { baseFeeQty: 0, quoteFee: null };
	costError: Error | null = null;
	stale = false;
	onPlace?: () => Promise<void>;
	onBook?: () => Promise<void>;

	async book(): Promise<Book> {
		await this.onBook?.();
		return {
			bids: [{ price: this.bid, volume: 100 }], asks: [{ price: this.ask, volume: 100 }],
			at: this.stale ? clock - 60_000 : clock,
		};
	}
	async place(request: VenuePlace) {
		const id = `order-${this.orders.size}`;
		this.placed.push(request);
		const marketPrice = request.side === "BUY" ? this.ask : this.bid;
		const crosses = request.side === "BUY" ? request.price >= marketPrice : request.price <= marketPrice;
		const qty = crosses ? this.grid.floorQty(request.quantity * (this.fills.shift() ?? 1)) : 0;
		this.orders.set(id, { request, qty, price: marketPrice, open: false });
		await this.onPlace?.();
		return { orderId: id };
	}
	async status(id: string) {
		const order = this.orders.get(id)!;
		return { filledQty: order.qty, avgPrice: order.qty ? order.price : null, open: order.open };
	}
	async cancel(id: string) {
		this.orders.get(id)!.open = false;
	}
	async settlement() {
		if (this.costError) throw this.costError;
		return this.cost;
	}
}

let d1: FakeD1;
let clock: number;
let store: TriggerStore;
let trades: TradeStore;
let venue: FakeVenue;
let runner: OrderRunner;
let ops: WatchOps;
let events: WatchEvent[];
let sellable: number;
let disabled: string | null;

function spec(overrides: Partial<RangeTrade> = {}, target = TARGET, size = { qty: 1 } as { qty: number } | { shares: number } | { amount: number }): TriggerSpec {
	const range: RangeTrade = {
		buyPrice: 2700, sellPrice: 2720, stop: { pct: 5 }, buyCostPct: 0.1, sellCostPct: 0.1,
		state: initialRangeState(), ...overrides,
	};
	const market = target.broker === "binance" ? { venue: "binance" as const, symbol: "ETHUSDT" } : { venue: "krx" as const, symbol: "005930", feed: { provider: target.broker as "kis" | "toss", basis: target.broker === "toss" ? "integrated" as const : "krx" as const } };
	return {
		name: "test range", condition: rangeCondition({ market, interval: "5m" }, range),
		action: { kind: "order", target, range, order: { side: "BUY", size, worstPct: 1, urgency: "immediate", deadlineSec: 30 } },
		limits: { maxFires: null, cooldownSec: 0, expiresAt: RANGE_FOREVER }, conversationId: null,
	};
}

beforeEach(async () => {
	d1 = installFakeD1();
	await migrate(d1.cfg);
	clock = START + STEP + 1_000;
	store = new TriggerStore(() => d1.cfg, () => clock);
	await store.load();
	trades = new TradeStore(() => d1.cfg, () => clock);
	venue = new FakeVenue();
	events = [];
	sellable = 100;
	disabled = null;
	const deliver = async (event: WatchEvent) => { events.push(event); return []; };
	runner = new OrderRunner({
		store, trades, venue: async () => venue, sellable: async () => sellable, deliver,
		disabled: () => disabled, now: () => clock,
		exec: { now: () => clock, sleep: async (ms) => { clock += ms; } },
	});
	ops = new WatchOps({
		store, deliver, channels: () => [], now: () => clock,
		confirm: { secret: watchConfirmSecret("test"), guard: new OrderTokenGuard<WatchTokenPayload>() },
		trading: {
			armProblem: async () => null, stop: (user) => runner.stop(user),
			limits: (user) => trades.limits(user), setLimit: (user, currency, value) => trades.setLimit(user, currency, value),
			recent: (user) => trades.recent(user),
		},
	});
	await trades.setLimit("ms", "USDT", 100_000);
	await trades.setLimit("ms", "KRW", 100_000);
});

afterEach(() => {
	runner.stopRangeRisk();
	d1.restore();
});

async function arm(strategy = spec()) {
	const card = ops.prepare("ms", strategy);
	return (await ops.arm("ms", card.token)).id;
}

function rangeState(id: string) {
	const record = store.get("ms", id)!;
	assert.equal(record.action.kind, "order");
	if (record.action.kind !== "order" || !record.action.range) throw new Error("missing range");
	return record.action.range;
}

async function signal(id: string, close: number, barT = START) {
	clock = Math.max(clock, barT + STEP + 1_000);
	const trigger = store.get("ms", id)!;
	await runner.submit({ trigger, bar: { t: barT, open: close, high: close, low: close, close, volume: 1 }, closeAt: barT + STEP });
}

async function risk(bid: number) {
	clock += 5_000;
	venue.bid = bid;
	venue.ask = bid;
	await runner.tickRangeRisk(() => true);
}

describe("박스권 반복매매 실행", () => {
	it("중복 봉·보유 중 추가 매수를 막고 매도 완료 후 다음 봉에서만 재매수한다", async () => {
		const id = await arm();
		await signal(id, 2700);
		assert.equal(rangeState(id).state.phase, "holding");
		const summary = ops.list("ms")[0]!.range!;
		assert.equal(summary.buyEstimated, true);
		assert.equal(summary.pnlEstimated, false, "현재 매수 비용 추정을 과거 실현손익에 섞지 않는다");
		await signal(id, 2700);
		await signal(id, 2690, START + STEP);
		assert.equal(venue.placed.length, 1);
		venue.bid = venue.ask = 2720;
		await signal(id, 2720, START + STEP * 2);
		assert.equal(rangeState(id).state.phase, "buying");
		assert.equal(rangeState(id).state.cycles, 1);
		venue.bid = venue.ask = 2700;
		await signal(id, 2700, START + STEP * 2);
		assert.equal(venue.placed.length, 2);
		await signal(id, 2700, START + STEP * 3);
		assert.deepEqual(venue.placed.map((order) => order.side), ["BUY", "SELL", "BUY"]);
		assert.equal(store.get("ms", id)!.state, "armed");
	});

	it("비용 포함 −5% 로스컷은 봉 마감 전에 손절하고 이후 재매수·재개를 차단한다", async () => {
		const id = await arm();
		await signal(id, 2700);
		assert.equal(rangeState(id).state.cost, 2702.7);
		await risk(2568); // 단순 가격 하락은 5% 미만이지만 양방향 비용 포함 손실은 5% 초과
		assert.equal(rangeState(id).state.phase, "stopped");
		assert.equal(store.get("ms", id)!.state, "off");
		venue.bid = venue.ask = 2700;
		await signal(id, 2700, START + STEP);
		await risk(2700);
		assert.equal(venue.placed.length, 2);
		assert.equal((await trades.recent("ms"))[0]!.plan.rangeLeg, "stop");
	});

	it("고정 가격 손절을 우선하고 부분 체결 뒤 가격이 회복해도 잔량을 계속 판다", async () => {
		const id = await arm(spec({ stop: { price: 2650 } }));
		await signal(id, 2700);
		venue.fills = [0.4, 0, 0];
		await risk(2650);
		assert.equal(rangeState(id).state.phase, "liquidating");
		assert.ok(Math.abs(rangeState(id).state.qty - 0.6) < 1e-8);
		await risk(2800);
		assert.equal(rangeState(id).state.phase, "stopped");
		assert.deepEqual(venue.placed.map((order) => order.side), ["BUY", "SELL", "SELL", "SELL", "SELL"]);
	});

	it("봉 마감 후 호가가 변해도 매수 상한·정상 매도 하한을 넘지 않는다", async () => {
		const id = await arm();
		venue.bid = 2700;
		venue.ask = 2701;
		await signal(id, 2700);
		assert.equal(rangeState(id).state.qty, 0);
		assert.ok(venue.placed.every((order) => order.price <= 2700));
		venue.bid = venue.ask = 2700;
		await signal(id, 2700, START + STEP);
		venue.bid = 2719;
		venue.ask = 2720;
		await signal(id, 2720, START + STEP * 2);
		assert.equal(rangeState(id).state.qty, 1);
		assert.ok(venue.placed.filter((order) => order.side === "SELL").every((order) => order.price >= 2720));
	});

	it("전략 수량만 매도하며 원래 계좌에 있던 99 ETH를 매도하지 않는다", async () => {
		const id = await arm();
		await signal(id, 2700);
		await risk(2500);
		assert.equal(venue.placed[1]!.quantity, 1);
	});

	it("매수 비용 포함 예산과 하루 한도를 적용한다", async () => {
		await trades.setLimit("ms", "USDT", 1000);
		const id = await arm(spec({}, TARGET, { amount: 1000 }));
		await signal(id, 2700);
		const spent = await trades.spentToday("ms", "USDT", "2026-09-28");
		assert.ok(spent > 0 && spent <= 1000);
		venue.bid = venue.ask = 2720;
		await signal(id, 2720, START + STEP);
		venue.bid = venue.ask = 2700;
		await signal(id, 2700, START + STEP * 2);
		assert.equal(venue.placed.length, 2);
		assert.match(store.get("ms", id)!.lastError!, /한도/);
	});

	it("실제 기준 자산 수수료를 순수량에서 차감하고 실제 금액 비용을 우선한다", async () => {
		venue.cost = { baseFeeQty: 0.001, quoteFee: 0 };
		const id = await arm();
		await signal(id, 2700);
		assert.equal(rangeState(id).state.qty, 0.999);
		assert.equal(rangeState(id).state.cost, 2700);
		assert.equal(rangeState(id).state.buyEstimated, false);
		venue.cost = { baseFeeQty: 0, quoteFee: 2 };
		await risk(2500);
		assert.equal(venue.placed[1]!.quantity, 0.999);
		assert.equal(rangeState(id).state.realizedPnl, 2497.5 - 2 - 2700);
	});

	it("최소 주문 단위 미만 잔량은 매도된 것으로 꾸미지 않고 별도 보유로 남긴다", async () => {
		venue.cost = { baseFeeQty: 0.0000003, quoteFee: 0 };
		const id = await arm();
		await signal(id, 2700);
		venue.cost = { baseFeeQty: 0, quoteFee: 0 };
		await risk(2500);
		assert.equal(rangeState(id).state.phase, "stopped");
		assert.ok(rangeState(id).state.dustQty > 0);
		assert.ok(rangeState(id).state.dustCost > 0);
		assert.match(events.at(-1)!.message.lines!.join(" "), /별도 보유/);
	});

	it("손절할 보유분 전체가 최소 단위 미만이면 매도했다고 기록하지 않고 잔량으로 남긴다", async () => {
		venue.grid = { ...GRID, minQty: 1 };
		venue.cost = { baseFeeQty: 0.001, quoteFee: 0 };
		const id = await arm();
		await signal(id, 2700);
		await risk(2500);
		const state = rangeState(id).state;
		assert.equal(state.phase, "stopped");
		assert.equal(state.dustQty, 0.999);
		assert.equal(state.dustCost, 2700);
		assert.equal(state.realizedPnl, 0);
		assert.equal(venue.placed.length, 1, "실제 매도 주문은 보내지 않았다");
		assert.match(events.at(-1)!.message.lines!.join(" "), /매도하지 못한 잔량/);
	});

	for (const broker of ["kis", "toss"] as const) {
		it(`${broker} 주식도 같은 상태 전이를 사용하며 장 밖에서는 손절 주문을 내지 않는다`, async () => {
			const target = { ...TARGET, broker };
			venue.market = "KR";
			venue.grid = { ...GRID, floorQty: Math.floor, minQty: 1, minNotional: 0, unit: "주" };
			const id = await arm(spec({}, target, { shares: 1 }));
			await signal(id, 2700);
			clock = Date.parse("2026-09-28T09:00:00Z"); // KST 18:00
			await risk(2500);
			assert.equal(venue.placed.length, 1);
			clock = Date.parse("2026-09-29T01:00:00Z");
			await risk(2500);
			assert.equal(rangeState(id).state.phase, "stopped");
		});

		it(`${broker} 미국 주식은 미국 정규장과 USD 비용 기준으로 처리한다`, async () => {
			const usOpen = Date.parse("2026-09-28T14:00:00Z");
			clock = usOpen + 1000;
			venue.market = "US";
			venue.grid = { ...GRID, floorQty: Math.floor, minQty: 1, minNotional: 0, unit: "주" };
			await trades.setLimit("ms", "USD", 100_000);
			const strategy = spec({}, { ...TARGET, broker }, { shares: 1 });
			strategy.condition = {
				...strategy.condition,
				market: { venue: "us", symbol: "AAPL", feed: { provider: broker } },
			};
			const id = await arm(strategy);
			await signal(id, 2700, usOpen);
			await risk(2500);
			assert.equal(rangeState(id).state.phase, "stopped");
			assert.equal((await trades.recent("ms"))[0]!.currency, "USD");
		});
	}
});

describe("정지·오류·권한", () => {
	it("일시정지는 보유분과 손절 감시를 모두 보존·중단하며 재개 때 현재 가격을 다시 본다", async () => {
		const id = await arm();
		await signal(id, 2700);
		await ops.pause("ms", id, "agent");
		await risk(2500);
		assert.equal(venue.placed.length, 1);
		assert.equal(rangeState(id).state.qty, 1);
		await assert.rejects(ops.remove("ms", id, "app"), /보유분/);
		await assert.rejects(ops.resume("ms", id, "agent"), /앱 화면/);
		await ops.resume("ms", id, "app");
		await risk(2500);
		assert.equal(rangeState(id).state.phase, "stopped");
	});

	it("호가 조회 도중 정지하면 주문하지 않고, 체결 중 정지해도 포지션 기록은 남긴다", async () => {
		const id = await arm();
		venue.onBook = async () => { venue.onBook = undefined; await ops.pause("ms", id, "app"); };
		await signal(id, 2700);
		assert.equal(venue.placed.length, 0);
		await ops.resume("ms", id, "app");
		venue.onPlace = async () => { await ops.pause("ms", id, "app"); };
		await signal(id, 2700, START + STEP);
		assert.equal(store.get("ms", id)!.state, "paused");
		assert.equal(rangeState(id).state.qty, 1);
	});

	it("순수량·잔고가 불명확하면 재매수와 재개를 차단한다", async () => {
		const id = await arm();
		await signal(id, 2700);
		sellable = 0.5;
		await risk(2500);
		assert.equal(store.get("ms", id)!.state, "paused");
		assert.equal(rangeState(id).state.phase, "blocked");
		assert.equal(venue.placed.length, 1);
		await assert.rejects(ops.resume("ms", id, "app"), /확인/);
	});

	it("호가 장애는 한 번 알리고 정상 조회가 돌아오면 오류를 해소한다", async () => {
		const id = await arm();
		await signal(id, 2700);
		venue.stale = true;
		await risk(2500);
		await risk(2500);
		assert.equal(events.filter((event) => event.kind === "error").length, 1);
		assert.equal(venue.placed.length, 1);
		venue.stale = false;
		await risk(2700);
		assert.equal(store.get("ms", id)!.lastError, null);
	});

	it("체결 수수료 조회 실패 시 순수량을 추측해 매도하지 않는다", async () => {
		venue.costError = new Error("fees unavailable");
		const id = await arm();
		await signal(id, 2700);
		assert.equal(rangeState(id).state.phase, "blocked");
		await risk(2500);
		assert.equal(venue.placed.length, 1);
		assert.match(store.get("ms", id)!.lastError!, /순수량/);
	});

	it("오래된 호가·비활성 사용자·자동매매 비활성·늦은 신호로 주문하지 않는다", async () => {
		const id = await arm();
		venue.stale = true;
		await signal(id, 2700);
		assert.equal(venue.placed.length, 0);
		venue.stale = false;
		disabled = "disabled";
		await signal(id, 2700);
		disabled = null;
		clock += STEP * 2;
		await signal(id, 2700);
		assert.equal(venue.placed.length, 0);
		await signal(id, 2700, START + STEP * 2);
		venue.bid = venue.ask = 2500;
		await runner.tickRangeRisk(() => false);
		assert.equal(venue.placed.length, 1);
	});

	it("손절가를 이미 이탈한 박스권에 새로 진입하지 않는다", async () => {
		const id = await arm(spec({ stop: { price: 2650 } }));
		venue.bid = venue.ask = 2600;
		await signal(id, 2600);
		assert.equal(venue.placed.length, 0);
	});
});

describe("기동 복구", () => {
	async function interrupted(id: string, applied = false) {
		const executionId = "x-recovery";
		const plan: ExecPlan = { side: "BUY", quantity: 1, worstPrice: 2700, urgency: "immediate", deadlineMs: 30_000, nonce: executionId, target: TARGET, symbol: "ETHUSDT", ref: 2700, maxAmount: 2702.7, rangeLeg: "normal" };
		await trades.begin({ id: executionId, triggerId: id, member: "ms", barT: START, currency: "USDT", day: "2026-09-28", plan });
		const child: ChildOrder = { n: 0, clientId: "recover-0", orderId: "done", ref: null, price: 2700, quantity: 1, ioc: true, state: "done", filledQty: 1, avgPrice: 2700, reason: null, settlement: { baseFeeQty: 0, quoteFee: 2.7 } };
		await trades.saveChildren(executionId, [child]);
		const report: ExecReport = { status: "filled", filledQty: 1, avgPrice: 2700, arrivalPrice: 2700, slippageBps: 0, children: [child], reason: null };
		const record = store.get("ms", id)!;
		if (record.action.kind !== "order") throw new Error("expected order");
		const range = applied ? applyRangeReport(rangeState(id), executionId, "BUY", report, START) : { ...rangeState(id), state: { ...rangeState(id).state, pendingExecId: executionId } };
		await store.setAction(id, { ...record.action, range });
	}

	it("완료 기록 전 재시작해도 체결·비용을 한 번만 반영하고 새 주문은 내지 않는다", async () => {
		const id = await arm();
		await interrupted(id);
		await store.load();
		await runner.recover();
		assert.equal(rangeState(id).state.qty, 1);
		assert.equal(rangeState(id).state.cost, 2702.7);
		assert.equal(store.get("ms", id)!.fires, 1);
		assert.equal(venue.placed.length, 0);
		assert.equal((await trades.running()).length, 0);
		await runner.recover();
		assert.equal(rangeState(id).state.qty, 1);
	});

	it("반복매매 복구 저장에 실패하면 성공으로 처리하지 않고 감시 시작을 막는다", async () => {
		const id = await arm();
		await interrupted(id);
		const setAction = store.setAction.bind(store);
		store.setAction = async () => { throw new Error("database unavailable"); };
		await assert.rejects(runner.recover(), /복구하지 못해/);
		assert.equal((await trades.running()).length, 1);
		assert.equal(venue.placed.length, 0);
		store.setAction = setAction;
		await runner.recover();
		assert.equal(rangeState(id).state.qty, 1);
	});

	it("포지션 반영 직후 완료 기록 전에 죽어도 비용·수량·횟수를 중복 반영하지 않는다", async () => {
		const id = await arm();
		await interrupted(id, true);
		await runner.recover();
		assert.equal(rangeState(id).state.qty, 1);
		assert.equal(rangeState(id).state.cost, 2702.7);
		assert.equal(store.get("ms", id)!.fires, 1);
		assert.equal(venue.placed.length, 0);
	});
});

describe("봉 마감 감시 연결", () => {
	it("하단 조건이 계속 참이어도 추가 매수하지 않으며 신규 봉만 주문한다", async () => {
		const id = await arm();
		const closes = [2700, 2690, 2690];
		const watcher = new Watcher({
			store, deliver: async () => [], isActive: () => true, now: () => clock,
			fetchBars: async (_user, _condition, limit, at) => closes.map((close, index) => ({ t: START + index * STEP, open: close, high: close, low: close, close, volume: 1 })).filter((bar) => bar.t + STEP <= at).slice(-limit),
			onOrder: (trigger, bar, closeAt) => { void runner.submit({ trigger, bar, closeAt }); },
		});
		clock = START + STEP * 2 + 1_000;
		await watcher.tick();
		await runner.idle("ms");
		clock += STEP;
		await watcher.tick();
		await runner.idle("ms");
		assert.equal(venue.placed.length, 1);
		assert.equal(rangeState(id).state.phase, "holding");
	});
});
