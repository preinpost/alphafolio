/**
 * 자동 매매 (PLAN §40 2단계) — 감시기 → 주문 실행기 → 체결기 → 기록·알림. 실제 SQL(인메모리 SQLite) + 가짜 거래소.
 *
 * 핵심: ① 켜진 주문 트리거의 제때 신호만 주문한다 (늦은 신호·장 밖·한도 초과는 알림만)
 * ② 같은 봉으로 두 번 주문하지 않는다 ③ 발동 횟수는 체결·결과 모름일 때만 센다
 * ④ 결과를 모르면 트리거를 일시정지한다 ⑤ 비상 정지는 진행 중인 체결을 멈춘다
 * ⑥ 기동 복구는 새 주문을 내지 않는다 (걸린 주문 취소, 보내는 중이던 것은 결과 모름)
 * ⑦ 주문 트리거 켜기는 한도·계좌 확인을 통과해야 하고, 실패해도 카드를 다시 쓸 수 있다
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { migrate } from "@alphafolio/ledger";
import { cryptoGrid, VenueUnknown, type Book, type ExecVenue, type Grid, type OrderTarget, type TriggerSpec, type VenueMarket, type VenueOrderState, type VenuePlace, type WatchBar } from "@alphafolio/broker";
import { installFakeD1, type FakeD1 } from "../../../packages/ledger/test/fake-d1.ts";
import { OrderTokenGuard } from "../src/order-tokens.ts";
import { OrderRunner } from "../src/order-runner.ts";
import { TradeStore } from "../src/trade-store.ts";
import { TriggerStore } from "../src/triggers.ts";
import { Watcher, type WatchEvent } from "../src/watcher.ts";
import { watchConfirmSecret, WatchOps, type WatchTokenPayload } from "../src/watch-api.ts";

const MIN = 60_000;
/** 2026-09-28 (월) 10:00 KST */
const OPEN_10 = Date.parse("2026-09-28T10:00:00+09:00");
const TARGET: OrderTarget = { broker: "kis", account: "abc123def456", accountLabel: "한국투자 ****78-01" };

class FakeVenue implements ExecVenue {
	label = "가짜 국장";
	market: VenueMarket = "KR";
	grid?: Grid;
	symbol = "005930";
	supportsIoc = false;
	idempotent = false;
	ob: Book = { bids: [{ price: 70_900, volume: 100 }], asks: [{ price: 71_000, volume: 100 }], at: 0 };
	orders = new Map<string, { o: VenuePlace; filled: number; open: boolean }>();
	placed: VenuePlace[] = [];
	cancels: string[] = [];
	placeError: Error | null = null;
	/** 걸어 두기만 하고 체결하지 않는다 */
	passive = false;
	adopted: string[] = [];
	private n = 0;
	async book() {
		return structuredClone(this.ob);
	}
	async place(o: VenuePlace) {
		this.placed.push(o);
		if (this.placeError) throw this.placeError;
		const id = `K${++this.n}`;
		const cross = !this.passive && (o.side === "BUY" ? o.price >= this.ob.asks[0]!.price : o.price <= this.ob.bids[0]!.price);
		this.orders.set(id, { o, filled: cross ? o.quantity : 0, open: !cross });
		return { orderId: id, ref: "91252|20260928" };
	}
	async cancel(id: string) {
		this.cancels.push(id);
		const x = this.orders.get(id);
		if (x) x.open = false;
	}
	async status(id: string): Promise<VenueOrderState> {
		const x = this.orders.get(id);
		if (!x) return { filledQty: 0, avgPrice: null, open: true };
		return { filledQty: x.filled, avgPrice: x.filled ? x.o.price : null, open: x.open };
	}
	adopt(o: { orderId: string }) {
		this.adopted.push(o.orderId);
	}
}

let d1: FakeD1;
let clock: number;
let store: TriggerStore;
let trades: TradeStore;
let venue: FakeVenue;
let sellable: number;
let delivered: WatchEvent[];
let runner: OrderRunner;
let ops: WatchOps;
let armProblem: string | null;
let disabled: string | null;

const buySpec = (over: Partial<TriggerSpec> = {}): TriggerSpec => ({
	name: "삼성 돌파 매수",
	condition: { market: { venue: "krx", symbol: "005930", feed: { provider: "kis", basis: "krx" } }, interval: "1m", when: "bar_close", all: [{ left: "close", op: ">", right: 71_000 }], confirmBars: 1, fire: "on_enter" },
	action: { kind: "order", target: TARGET, order: { side: "BUY", size: { amount: 1_000_000 }, worstPct: 1, urgency: "immediate", deadlineSec: 30 } },
	limits: { maxFires: 1, cooldownSec: 0, expiresAt: new Date(OPEN_10 + 30 * 86_400_000).toISOString() },
	conversationId: "conv-9",
	...over,
});

beforeEach(async () => {
	d1 = installFakeD1();
	await migrate(d1.cfg);
	clock = OPEN_10;
	store = new TriggerStore(() => d1.cfg, () => clock);
	await store.load();
	trades = new TradeStore(() => d1.cfg, () => clock);
	venue = new FakeVenue();
	sellable = 0;
	delivered = [];
	armProblem = null;
	disabled = null;
	const deliver = async (ev: WatchEvent) => (delivered.push(ev), []);
	runner = new OrderRunner({
		store,
		trades,
		venue: async () => venue,
		sellable: async () => sellable,
		deliver,
		disabled: () => disabled,
		now: () => clock,
		exec: { now: () => clock, sleep: async (ms) => void (clock += ms) },
	});
	ops = new WatchOps({
		store,
		confirm: { secret: watchConfirmSecret("s"), guard: new OrderTokenGuard<WatchTokenPayload>() },
		deliver,
		channels: () => [],
		now: () => clock,
		trading: {
			armProblem: async () => armProblem,
			stop: (u) => runner.stop(u),
			limits: (u) => trades.limits(u),
			setLimit: (u, c, v) => trades.setLimit(u, c, v),
			recent: (u) => trades.recent(u),
		},
	});
	await trades.setLimit("ms", "KRW", 5_000_000);
});
afterEach(() => d1.restore());

async function arm(s = buySpec()): Promise<string> {
	const { token } = ops.prepare("ms", s);
	return (await ops.arm("ms", token)).id;
}
const bar = (t: number, close = 71_100): WatchBar => ({ t, open: close, high: close, low: close, close, volume: 1 });
async function signal(id: string, t = OPEN_10 - MIN, close?: number): Promise<void> {
	const tr = store.get("ms", id)!;
	await runner.submit({ trigger: tr, bar: bar(t, close), closeAt: t + MIN });
}
const last = () => delivered.at(-1)!;

describe("주문", () => {
	it("매수 — 금액을 최악 허용가로 나눠 내림, 체결 기록·발동 1회·소진·알림", async () => {
		const id = await arm();
		await signal(id);
		// 중간가 70,950 × 1.01 = 71,659 → 71,600 (100원 단위 내림), 1,000,000 / 71,600 = 13주
		assert.deepEqual(
			venue.placed.map((p) => [p.side, p.quantity, p.price <= 71_600]),
			[["BUY", 13, true]],
		);
		const [x] = await trades.recent("ms");
		assert.equal(x!.state, "filled");
		assert.equal(x!.filledQty, 13);
		assert.equal(x!.reserved, 0);
		assert.equal(x!.children.length, 1);
		assert.equal(x!.children[0]!.ref, "91252|20260928");
		const t = store.get("ms", id)!;
		assert.equal(t.fires, 1);
		assert.equal(t.state, "done");
		assert.equal(last().kind, "ordered");
		assert.match(last().message.title, /매수 체결/);
		assert.match(last().message.lines!.join("\n"), /매수 13\/13주 · 평균/);
		assert.match(last().message.lines!.join("\n"), /최대 1번을 채워/);
		assert.equal(last().message.path, "/c/conv-9");
		// 하루 사용 금액
		assert.equal(await trades.spentToday("ms", "KRW", "2026-09-28"), 13 * 71_000);
	});

	it("신호를 처리할 때 이미 멈춘 트리거는 주문하지 않는다", async () => {
		const id = await arm();
		const tr = store.get("ms", id)!;
		await ops.pause("ms", id, "app");
		await runner.submit({ trigger: tr, bar: bar(OPEN_10 - MIN), closeAt: OPEN_10 });
		assert.equal(venue.placed.length, 0);
		assert.match(last().message.lines!.join(" "), /켜져 있지 않습니다/);
	});

	it("같은 봉 신호가 두 번 와도 주문은 한 번", async () => {
		const id = await arm(buySpec({ limits: { maxFires: 5, cooldownSec: 0, expiresAt: new Date(OPEN_10 + 86_400_000).toISOString() } }));
		await signal(id);
		await signal(id);
		assert.equal(venue.placed.length, 1);
		assert.equal((await trades.recent("ms")).length, 1);
	});

	it("장 밖 · 종가 단일가 · 자동 매매 꺼짐 — 주문하지 않고 횟수도 안 센다", async () => {
		const id = await arm();
		clock = Date.parse("2026-09-28T08:30:00+09:00");
		await signal(id);
		assert.equal(last().kind, "skipped");
		assert.match(last().message.lines!.join(" "), /정규장 밖/);
		clock = Date.parse("2026-09-28T15:25:00+09:00");
		await signal(id, clock - 2 * MIN);
		assert.match(last().message.lines!.join(" "), /종가 단일가/);
		clock = OPEN_10;
		disabled = "서버에서 자동 매매를 껐습니다";
		await signal(id, OPEN_10 - 3 * MIN);
		assert.match(last().message.lines!.join(" "), /껐습니다/);
		assert.equal(venue.placed.length, 0);
		assert.equal(store.get("ms", id)!.fires, 0);
		assert.equal(store.get("ms", id)!.state, "armed");
	});

	it("하루 매수 한도 — 진행 중 예약까지 세고, 없으면 매수하지 않는다", async () => {
		await trades.setLimit("ms", "KRW", 1_500_000);
		const a = await arm(buySpec({ name: "A" }));
		const b = await arm(buySpec({ name: "B" }));
		await signal(a);
		await signal(b);
		assert.equal(venue.placed.length, 1);
		assert.match(last().message.lines!.join(" "), /하루 매수 한도 초과/);
		await trades.setLimit("ms", "KRW", null);
		const c = await (async () => {
			armProblem = null;
			return arm(buySpec({ name: "C" }));
		})();
		await signal(c, OPEN_10 - 2 * MIN);
		assert.match(last().message.lines!.join(" "), /한도\(KRW\)가 없습니다/);
	});

	it("매도 — 매도 가능 수량으로 자르고, 없으면 주문 안 함", async () => {
		const spec = buySpec({ action: { kind: "order", target: TARGET, order: { side: "SELL", size: { holdingPct: 100 }, worstPct: 2, urgency: "immediate", deadlineSec: 30 } } });
		const id = await arm(spec);
		await signal(id);
		assert.match(last().message.lines!.join(" "), /매도 가능 수량이 없습니다/);
		sellable = 7;
		await signal(id, OPEN_10 - 2 * MIN);
		assert.deepEqual(
			venue.placed.map((p) => [p.side, p.quantity]),
			[["SELL", 7]],
		);
		assert.match(last().message.title, /매도 체결/);
	});

	it("결과 모름 — 트리거 일시정지 + 이유, 다시 보내지 않는다", async () => {
		venue.placeError = new VenueUnknown("fetch failed");
		const id = await arm();
		await signal(id);
		assert.equal(venue.placed.length, 1);
		const t = store.get("ms", id)!;
		assert.equal(t.state, "paused");
		assert.equal(t.fires, 1);
		assert.match(t.lastError ?? "", /알 수 없습니다/);
		assert.match(last().message.title, /결과 모름/);
		assert.match(last().message.lines!.join(" "), /일시정지했습니다/);
		const [x] = await trades.recent("ms");
		assert.equal(x!.state, "unknown");
		assert.equal(x!.children[0]!.state, "unknown");
	});

	it("미체결(허용가 안에 없음) — 횟수를 안 세고 켜진 채로", async () => {
		venue.passive = true;
		const id = await arm();
		await signal(id);
		// immediate 는 호가를 다시 보며 3번까지 — 모두 걸리지 않고 취소
		assert.equal(venue.placed.length, 3);
		assert.equal(venue.cancels.length, 3);
		assert.equal(store.get("ms", id)!.fires, 0);
		assert.equal(store.get("ms", id)!.state, "armed");
		assert.match(last().message.title, /미체결/);
		assert.equal(await trades.spentToday("ms", "KRW", "2026-09-28"), 0); // 예약도 풀린다
	});

	it("기다리는 매수는 종가 단일가(15:20) 전에 끝낸다", async () => {
		venue.passive = true;
		const id = await arm(buySpec({ action: { kind: "order", target: TARGET, order: { side: "BUY", size: { shares: 3 }, worstPct: 1, urgency: "patient", deadlineSec: 120 } } }));
		clock = Date.parse("2026-09-28T15:19:30+09:00");
		await signal(id, clock - 90_000);
		assert.ok(clock <= Date.parse("2026-09-28T15:20:10+09:00"), new Date(clock).toISOString());
		assert.match(last().message.lines!.join(" "), /기한 안에/);
	});

	it("비상 정지 — 진행 중인 체결의 걸린 주문을 취소하고 멈춘다", async () => {
		venue.passive = true;
		const id = await arm(buySpec({ action: { kind: "order", target: TARGET, order: { side: "BUY", size: { shares: 3 }, worstPct: 1, urgency: "patient", deadlineSec: 120 } } }));
		// 첫 주문이 걸린 뒤 사람이 비상 정지
		const place = venue.place.bind(venue);
		venue.place = async (o) => {
			const r = await place(o);
			if (venue.placed.length === 1) {
				clock += 1;
				await ops.stopAll("ms", "app");
			}
			return r;
		};
		await signal(id);
		assert.equal(venue.placed.length, 1);
		assert.equal(venue.cancels.length, 1);
		assert.match(last().message.lines!.join(" "), /비상 정지/);
		assert.equal(store.get("ms", id)!.state, "paused");
	});
});

describe("감시기 연결", () => {
	const fetchBars = (closes: number[]) => async (_u: string, _c: unknown, limit: number, at: number) =>
		closes.map((c, i) => bar(Date.parse("2026-09-28T09:00:00+09:00") + i * MIN, c)).filter((b) => b.t + MIN <= at).slice(-limit);

	it("제때 발동은 실행기로 — 감시기는 알리지 않는다 (결과 알림 하나)", async () => {
		const closes = Array(60).fill(70_000);
		const id = await arm();
		const w = new Watcher({ store, deliver: async (ev) => (delivered.push(ev), []), isActive: () => true, fetchBars: fetchBars(closes), now: () => clock, onOrder: (t, b, at) => void runner.submit({ trigger: t, bar: b, closeAt: at }) });
		closes.push(71_200); // 10:00 봉
		clock = Date.parse("2026-09-28T10:01:21+09:00");
		await w.tick();
		await runner.idle("ms");
		assert.equal(venue.placed.length, 1);
		assert.deepEqual(
			delivered.map((e) => e.kind),
			["armed", "ordered"],
		);
		assert.equal(store.get("ms", id)!.fires, 1);
	});

	it("늦은 신호로는 주문하지 않는다 — 알림만", async () => {
		const closes = Array(60).fill(70_000);
		await arm();
		const w = new Watcher({ store, deliver: async (ev) => (delivered.push(ev), []), isActive: () => true, fetchBars: fetchBars(closes), now: () => clock, onOrder: (t, b, at) => void runner.submit({ trigger: t, bar: b, closeAt: at }) });
		closes.push(71_200, 71_300, 70_000, 70_000, 70_000, 70_000);
		clock = Date.parse("2026-09-28T10:06:21+09:00");
		await w.tick();
		await runner.idle("ms");
		assert.equal(venue.placed.length, 0);
		assert.equal(last().kind, "missed");
		assert.match(last().message.lines!.join(" "), /늦은 신호로는 주문하지 않습니다/);
	});
});

describe("기동 복구", () => {
	it("걸린 주문은 취소, 보내는 중이던 것은 결과 모름 — 새 주문 없음", async () => {
		const id = await arm();
		venue.orders.set("K7", { o: { side: "BUY", quantity: 5, price: 71_000, ioc: false, clientId: "x-0" }, filled: 2, open: true });
		await trades.begin({
			id: "xdead",
			triggerId: id,
			member: "ms",
			barT: OPEN_10 - MIN,
			currency: "KRW",
			day: "2026-09-28",
			plan: { side: "BUY", quantity: 10, worstPrice: 71_600, urgency: "patient", deadlineMs: 60_000, nonce: "xdead", target: TARGET, symbol: "005930", ref: 70_950, maxAmount: 716_000 },
		});
		await trades.saveChildren("xdead", [
			{ n: 0, clientId: "xdead-0", orderId: "K7", ref: "91252|20260928", price: 71_000, quantity: 5, ioc: false, state: "open", filledQty: 0, avgPrice: null, reason: null },
			{ n: 1, clientId: "xdead-1", orderId: null, ref: null, price: 71_100, quantity: 5, ioc: false, state: "sending", filledQty: 0, avgPrice: null, reason: null },
		]);
		// 끝나지 않은 매수는 최대 금액을 잡아 둔다 (하루 한도 계산)
		assert.equal(await trades.spentToday("ms", "KRW", "2026-09-28"), 716_000);
		assert.equal(await runner.recover(), 1);
		assert.deepEqual(venue.adopted, ["K7"]);
		assert.deepEqual(venue.cancels, ["K7"]);
		assert.equal(venue.placed.length, 0);
		const [x] = await trades.recent("ms");
		assert.equal(x!.state, "unknown");
		assert.equal(x!.filledQty, 2);
		assert.equal(x!.reserved, 0);
		assert.equal(store.get("ms", id)!.state, "paused");
		assert.match(last().message.lines!.join(" "), /서버가 체결 도중 멈췄습니다/);
		assert.equal(await runner.recover(), 0);
	});
});

describe("켜기", () => {
	it("한도·계좌 확인에 걸리면 켜지지 않고, 고친 뒤 같은 카드로 켤 수 있다", async () => {
		armProblem = "하루 매수 한도(KRW)를 먼저 정해 주세요";
		const { token } = ops.prepare("ms", buySpec());
		await assert.rejects(ops.arm("ms", token), /한도/);
		armProblem = null;
		const w = await ops.arm("ms", token);
		assert.equal(w.state, "armed");
		assert.match(w.order ?? "", /매수 1,000,000원어치 · 한국투자 \*\*\*\*78-01/);
	});

	it("주문 트리거 다시 켜기도 확인한다", async () => {
		const id = await arm();
		await ops.pause("ms", id, "app");
		armProblem = "주문 계좌가 준비 때와 다릅니다";
		await assert.rejects(ops.resume("ms", id, "app"), /계좌/);
		armProblem = null;
		assert.equal((await ops.resume("ms", id, "app")).state, "armed");
	});

	it("한도 설정 — 앱 화면, 0 이하 거절, 지우기", async () => {
		assert.deepEqual(await ops.setLimit("ms", "USD", 2000), { KRW: 5_000_000, USD: 2000, USDT: null });
		await assert.rejects(ops.setLimit("ms", "USD", -1), /0보다 큰/);
		assert.deepEqual(await ops.setLimit("ms", "USD", null), { KRW: 5_000_000, USD: null, USDT: null });
		assert.deepEqual(await ops.setLimit("ms", "USDT", 300), { KRW: 5_000_000, USD: null, USDT: 300 });
		const v = await ops.view("ms");
		assert.deepEqual(v.trading?.limits, { KRW: 5_000_000, USD: null, USDT: 300 });
	});
});

describe("연계주문 (보호)", () => {
	const protectedBuy = () =>
		buySpec({ action: { kind: "order", target: TARGET, order: { side: "BUY", size: { shares: 10 }, worstPct: 1, urgency: "immediate", deadlineSec: 30 }, protect: { stop: { pct: 5 }, take: { pct: 10 }, interval: "1m" } } });
	const protectOf = (parent: string) => store.list("ms").find((t) => t.action.kind === "order" && t.action.position?.parentId === parent)!;

	it("매수 체결 → 체결 수량·평단으로 보호 트리거 하나 (손절·익절 OR, 참인 봉마다)", async () => {
		const id = await arm(protectedBuy());
		await signal(id);
		const p = protectOf(id);
		assert.ok(p, "보호 트리거");
		assert.equal(p.state, "armed");
		assert.equal(p.source.condition.fire, "while_true");
		assert.equal(p.source.condition.interval, "1m");
		assert.deepEqual(p.source.condition.market, buySpec().condition.market);
		assert.ok(p.action.kind === "order");
		// 평단 71,000 → 손절 67,450 → 67,400 (내림), 익절 78,100 (올림)
		assert.deepEqual(p.action.position, { shares: 10, avgPrice: 71_000, stopPrice: 67_400, takePrice: 78_100, parentId: id });
		assert.equal(p.maxFires, null);
		assert.ok(Date.parse(p.expiresAt) > Date.parse(buySpec().limits.expiresAt));
		assert.equal(p.conversationId, "conv-9");
		assert.match(last().message.lines!.join("\n"), /보호 켬 \(w[0-9a-f]{8}\): 10주 — 손절 < 67,400/);
	});

	it("손절 — 남은 포지션만 팔고, 다 팔면 끝 (익절도 같이 끝난다)", async () => {
		const id = await arm(protectedBuy());
		await signal(id);
		const p = protectOf(id);
		sellable = 25; // 원래 가진 15주 + 이번 10주 — 보호는 10주만
		venue.placed = [];
		await runner.submit({ trigger: p, bar: bar(OPEN_10, 67_000), closeAt: OPEN_10 + MIN });
		assert.deepEqual(
			venue.placed.map((x) => [x.side, x.quantity]),
			[["SELL", 10]],
		);
		assert.equal(store.get("ms", p.id)!.state, "done");
		assert.match(last().message.title, /손절 매도 체결/);
		assert.match(last().message.lines!.join(" "), /포지션을 다 팔아 보호를 끝냈습니다/);
	});

	it("일부만 팔리면 남은 수량으로 줄이고 켜진 채로 — 다음 봉에 다시", async () => {
		const id = await arm(protectedBuy());
		await signal(id);
		const p = protectOf(id);
		sellable = 10;
		venue.ob.bids = [{ price: 66_900, volume: 4 }];
		venue.passive = false;
		// 부분 체결을 흉내 — 4주만 맞는 가짜
		const place = venue.place.bind(venue);
		venue.place = async (o) => {
			const r = await place(o);
			const x = venue.orders.get(r.orderId)!;
			x.filled = Math.min(4, o.quantity);
			x.open = false;
			venue.ob.bids = [];
			return r;
		};
		await runner.submit({ trigger: p, bar: bar(OPEN_10, 67_000), closeAt: OPEN_10 + MIN });
		const after = store.get("ms", p.id)!;
		assert.equal(after.state, "armed");
		assert.ok(after.action.kind === "order");
		assert.equal(after.action.position?.shares, 6);
		assert.match(last().message.lines!.join(" "), /남은 6주 — 다음 봉에도/);
		// 다음 봉 — 남은 6주만 (처음 수량 10주가 아니라)
		venue.place = place;
		venue.ob.bids = [{ price: 69_000, volume: 100 }];
		venue.placed = [];
		await runner.submit({ trigger: after, bar: bar(OPEN_10 + MIN, 66_800), closeAt: OPEN_10 + 2 * MIN });
		assert.deepEqual(
			venue.placed.map((x) => [x.side, x.quantity]),
			[["SELL", 6]],
		);
		assert.equal(store.get("ms", p.id)!.state, "done");
	});

	it("매도 가능 수량이 없으면(직접 팔았다) 보호를 끈다", async () => {
		const id = await arm(protectedBuy());
		await signal(id);
		const p = protectOf(id);
		sellable = 0;
		await runner.submit({ trigger: p, bar: bar(OPEN_10, 67_000), closeAt: OPEN_10 + MIN });
		assert.equal(store.get("ms", p.id)!.state, "off");
		assert.match(last().message.lines!.join(" "), /보호를 끕니다/);
	});

	it("같은 이유로 주문하지 못하면 한 번만 알린다 (참인 봉마다 오니까)", async () => {
		const id = await arm(protectedBuy());
		await signal(id);
		const p = protectOf(id);
		sellable = 10;
		clock = Date.parse("2026-09-28T15:21:00+09:00");
		const n = delivered.length;
		await runner.submit({ trigger: p, bar: bar(clock - 2 * MIN, 67_000), closeAt: clock - MIN });
		await runner.submit({ trigger: p, bar: bar(clock - MIN, 66_900), closeAt: clock });
		assert.equal(delivered.length, n + 1);
		assert.match(last().message.lines!.join(" "), /종가 단일가/);
	});

	it("보유 종목 보호 트리거는 횟수 없이 켤 수 있고 켜기 확인을 거친다", async () => {
		const spec = buySpec({
			name: "삼성 보호",
			condition: { ...buySpec().condition, all: [{ left: "close", op: "<", right: 67_000 }], fire: "while_true" },
			action: { kind: "order", target: TARGET, order: { side: "SELL", size: { shares: 5 }, worstPct: 2, urgency: "immediate", deadlineSec: 30 }, position: { shares: 5, avgPrice: 70_000, stopPrice: 67_000, takePrice: null, parentId: null } },
			limits: { maxFires: null, cooldownSec: 0, expiresAt: new Date(OPEN_10 + 90 * 86_400_000).toISOString() },
		});
		const id = await arm(spec);
		assert.match(ops.list("ms").find((w) => w.id === id)!.order ?? "", /보호 5주 \(평단 70,000\)/);
	});
});

describe("코인 자동 매매 (Binance 현물)", () => {
	/** 2026-09-27 (일) 03:00 KST = 09-26 (토) 18:00 UTC — 주식이면 휴장 */
	const SUN_3AM = Date.parse("2026-09-27T03:00:00+09:00");
	const BINANCE: OrderTarget = { broker: "binance", account: "f00dcafe0000", accountLabel: "Binance 현물 (키 f00dca)" };
	const BTC = {
		symbol: "BTCUSDT", status: "TRADING", base: "BTC", quote: "USDT", orderTypes: ["LIMIT"], spot: true,
		tickSize: "0.01", minPrice: "0.01", maxPrice: "1000000", stepSize: "0.00001", minQty: "0.00001", maxQty: "9000",
		marketStepSize: "0.00001", marketMinQty: "0", marketMaxQty: "120", minNotional: "5", notionalAppliesToMarket: true,
	};
	const coinSpec = (over: Partial<TriggerSpec> = {}): TriggerSpec => ({
		name: "BTC 돌파 매수",
		condition: { market: { venue: "binance", symbol: "BTCUSDT" }, interval: "1m", when: "bar_close", all: [{ left: "close", op: ">", right: 84_000 }], confirmBars: 1, fire: "on_enter" },
		action: { kind: "order", target: BINANCE, order: { side: "BUY", size: { amount: 100 }, worstPct: 1, urgency: "immediate", deadlineSec: 30 } },
		limits: { maxFires: 1, cooldownSec: 0, expiresAt: new Date(SUN_3AM + 30 * 86_400_000).toISOString() },
		conversationId: null,
		...over,
	});
	const protectOf = (parent: string) => store.list("ms").find((t) => t.action.kind === "order" && t.action.position?.parentId === parent)!;

	beforeEach(async () => {
		clock = SUN_3AM;
		venue.market = "CRYPTO";
		venue.grid = cryptoGrid(BTC);
		venue.symbol = "BTCUSDT";
		venue.ob = { bids: [{ price: 83_999.99, volume: 2 }], asks: [{ price: 84_000, volume: 2 }], at: 0 };
		await trades.setLimit("ms", "USDT", 500);
	});

	it("주말 새벽에도 — USDT 금액을 최악 허용가로 나눠 코인 수량 단위로, 하루는 UTC", async () => {
		const id = await arm(coinSpec());
		await runner.submit({ trigger: store.get("ms", id)!, bar: bar(SUN_3AM - MIN, 84_100), closeAt: SUN_3AM });
		// 중간가 83,999.995 × 1.01 = 84,839.99 → 100 / 84,839.99 = 0.0011787 → 0.00117 BTC
		assert.deepEqual(
			venue.placed.map((p) => [p.side, p.quantity]),
			[["BUY", 0.00117]],
		);
		const [x] = await trades.recent("ms");
		assert.equal(x!.state, "filled");
		assert.equal(x!.currency, "USDT");
		assert.equal(x!.day, "2026-09-26");
		assert.equal(x!.broker, "binance");
		assert.equal(x!.filledQty, 0.00117);
		assert.equal(store.get("ms", id)!.state, "done");
		assert.match(last().message.lines!.join("\n"), /매수 0\.00117\/0\.00117 BTC · 평균 84,000 USDT/);
		assert.ok(Math.abs((await trades.spentToday("ms", "USDT", "2026-09-26")) - 0.00117 * 84_000) < 1e-9);
	});

	it("USDT 한도가 없거나 넘으면 매수하지 않는다 (원·달러 한도와 따로)", async () => {
		await trades.setLimit("ms", "USDT", null);
		const id = await arm(coinSpec());
		await runner.submit({ trigger: store.get("ms", id)!, bar: bar(SUN_3AM - MIN), closeAt: SUN_3AM });
		assert.equal(venue.placed.length, 0);
		assert.match(last().message.lines!.join(" "), /한도\(USDT\)가 없습니다/);
		await trades.setLimit("ms", "USDT", 50);
		await runner.submit({ trigger: store.get("ms", id)!, bar: bar(SUN_3AM - 2 * MIN), closeAt: SUN_3AM - MIN });
		assert.match(last().message.lines!.join(" "), /하루 매수 한도 초과 — 오늘 0 USDT \+ 이번 최대 99\.26 USDT > 한도 50 USDT/);
		assert.equal(store.get("ms", id)!.fires, 0);
	});

	it("USDT 마켓이 아니면 주문하지 않는다", async () => {
		const id = await arm(coinSpec({ condition: { ...coinSpec().condition, market: { venue: "binance", symbol: "ETHBTC" } } }));
		await runner.submit({ trigger: store.get("ms", id)!, bar: bar(SUN_3AM - MIN), closeAt: SUN_3AM });
		assert.equal(venue.placed.length, 0);
		assert.match(last().message.lines!.join(" "), /USDT 마켓만/);
	});

	it("연계주문 — 체결 수량(코인)으로 보호, 수수료로 모자란 만큼만 팔고 남은 부스러기는 끝낸다", async () => {
		const id = await arm(coinSpec({ action: { kind: "order", target: BINANCE, order: { side: "BUY", size: { amount: 100 }, worstPct: 1, urgency: "immediate", deadlineSec: 30 }, protect: { stop: { pct: 5 }, take: { pct: 10 }, interval: "1m" } } }));
		await runner.submit({ trigger: store.get("ms", id)!, bar: bar(SUN_3AM - MIN, 84_100), closeAt: SUN_3AM });
		const p = protectOf(id);
		assert.ok(p.action.kind === "order");
		// 평단 84,000 → 손절 79,800 · 익절 92,400 (0.01 단위)
		assert.deepEqual(p.action.position, { shares: 0.00117, avgPrice: 84_000, stopPrice: 79_800, takePrice: 92_400, parentId: id });
		assert.deepEqual(p.action.order.size, { qty: 0.00117 });
		assert.match(last().message.lines!.join("\n"), /보호 켬 \(w[0-9a-f]{8}\): 0\.00117 BTC — 손절 < 79,800/);
		// 수수료 0.1% 가 BTC 로 빠져 free 는 0.0011688 → 0.00116 만 팔 수 있다
		sellable = 0.00116;
		venue.placed = [];
		venue.ob = { bids: [{ price: 79_500, volume: 2 }], asks: [{ price: 79_500.01, volume: 2 }], at: 0 };
		await runner.submit({ trigger: p, bar: bar(SUN_3AM, 79_600), closeAt: SUN_3AM + MIN });
		assert.deepEqual(
			venue.placed.map((x) => [x.side, x.quantity]),
			[["SELL", 0.00116]],
		);
		// 남은 0.00001 BTC (약 0.8 USDT) 는 최소 주문금액 미만 — 더 팔 수 없어 끝낸다
		assert.equal(store.get("ms", p.id)!.state, "done");
		assert.match(last().message.title, /손절 매도 체결/);
		assert.match(last().message.lines!.join(" "), /포지션을 다 팔아 보호를 끝냈습니다/);
	});

	it("보호할 게 최소 주문 단위보다 작으면 보호를 끈다", async () => {
		const pos = { shares: 0.00003, avgPrice: 0, stopPrice: 80_000, takePrice: null, parentId: null };
		const id = await arm(
			coinSpec({
				condition: { market: { venue: "binance", symbol: "BTCUSDT" }, interval: "1m", when: "bar_close", all: [{ left: "close", op: "<", right: 80_000 }], confirmBars: 1, fire: "while_true" },
				action: { kind: "order", target: BINANCE, order: { side: "SELL", size: { qty: 0.00003 }, worstPct: 2, urgency: "immediate", deadlineSec: 30 }, position: pos },
				limits: { maxFires: null, cooldownSec: 0, expiresAt: new Date(SUN_3AM + 86_400_000).toISOString() },
			}),
		);
		sellable = 0.00003;
		await runner.submit({ trigger: store.get("ms", id)!, bar: bar(SUN_3AM - MIN, 79_000), closeAt: SUN_3AM });
		assert.equal(venue.placed.length, 0);
		assert.equal(store.get("ms", id)!.state, "off");
		assert.match(last().message.lines!.join(" "), /최소 주문금액.*부스러기는 팔 수 없어 보호를 끝냅니다/);
	});
});
