/**
 * 체결기 (PLAN §40 2단계) — 가짜 거래소로 가격 결정·부분 체결·취소·결과 모름을 검사한다.
 *
 * 지켜야 할 것:
 *   - 가격은 절대 최악 허용가를 넘지 않는다 (매수 ≤, 매도 ≥), 호가 단위에 맞는다
 *   - 자식 주문은 보내기 전에 기록된다
 *   - 결과를 모르면 다시 보내지 않는다 (멱등성 키가 있는 곳만 같은 clientId 로 한 번)
 *   - 잔량 취소를 확인하지 못하면 unknown
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execute, joinPrice, midPrice, slippageBps, sweepPrice, type ChildOrder, type ExecIntent } from "../src/triggers/executor.ts";
import { roundPrice, stepPrice, priceText } from "../src/triggers/venues/tick.ts";
import { VenueRejected, VenueUnknown, type Book, type ExecVenue, type VenuePlace, type VenueOrderState } from "../src/triggers/venues/types.ts";
import type { Market } from "../src/orders.ts";

// ── 가짜 거래소 ──────────────────────────────────────────────

interface FakeOrder extends VenuePlace {
	id: string;
	filled: number;
	amount: number;
	open: boolean;
	at: number;
}

class Clock {
	t = 1_000_000;
	now = () => this.t;
	sleep = async (ms: number) => {
		this.t += ms;
	};
}

/**
 * 호가를 들고 있다가 들어온 지정가를 반대편 호가와 맞춘다 (가격 개선 포함). 남은 건 걸어 둔다(IOC 면 버린다).
 * arrive(t, side, price, qty): 시각 t 이후 status 조회 때 걸린 주문과 맞춰 줄 상대 주문.
 */
class FakeVenue implements ExecVenue {
	label = "가짜";
	symbol = "TEST";
	orders = new Map<string, FakeOrder>();
	placed: VenuePlace[] = [];
	cancels: string[] = [];
	arrivals: Array<{ at: number; side: "BUY" | "SELL"; price: number; qty: number }> = [];
	placeError: (() => Error | null) | null = null;
	statusError: (() => Error | null) | null = null;
	cancelIgnored = false;
	private seq = 0;
	byClient = new Map<string, string>();

	ob: Book;
	clock: Clock;
	market: Market;
	supportsIoc: boolean;
	idempotent: boolean;

	constructor(ob: Book, clock: Clock, market: Market = "KR", supportsIoc = false, idempotent = false) {
		this.ob = ob;
		this.clock = clock;
		this.market = market;
		this.supportsIoc = supportsIoc;
		this.idempotent = idempotent;
	}

	async book(): Promise<Book> {
		return structuredClone({ ...this.ob, at: this.clock.t });
	}

	async place(o: VenuePlace): Promise<{ orderId: string }> {
		this.placed.push({ ...o });
		const e = this.placeError?.();
		if (e) {
			// 결과 모름은 실제로는 접수된 것으로 둔다 (그래야 다시 보내면 중복이 드러난다)
			if (e instanceof VenueUnknown) this.accept(o);
			throw e;
		}
		const dup = this.byClient.get(o.clientId);
		if (dup && this.idempotent) return { orderId: dup };
		return { orderId: this.accept(o) };
	}

	private accept(o: VenuePlace): string {
		const id = `O${++this.seq}`;
		this.byClient.set(o.clientId, id);
		const ord: FakeOrder = { ...o, id, filled: 0, amount: 0, open: true, at: this.clock.t };
		const levels = o.side === "BUY" ? this.ob.asks : this.ob.bids;
		for (const l of levels) {
			const ok = o.side === "BUY" ? l.price <= o.price : l.price >= o.price;
			if (!ok) break;
			const take = Math.min(l.volume, o.quantity - ord.filled);
			l.volume -= take;
			ord.filled += take;
			ord.amount += take * l.price;
			if (ord.filled >= o.quantity) break;
		}
		if (o.side === "BUY") this.ob.asks = this.ob.asks.filter((l) => l.volume > 0);
		else this.ob.bids = this.ob.bids.filter((l) => l.volume > 0);
		if (ord.filled >= o.quantity || o.ioc) ord.open = false;
		this.orders.set(id, ord);
		return id;
	}

	async cancel(id: string): Promise<void> {
		this.cancels.push(id);
		const o = this.orders.get(id);
		if (!o) throw new Error("없는 주문");
		if (!o.open) throw new VenueRejected("이미 닫힌 주문");
		if (!this.cancelIgnored) o.open = false;
	}

	async status(id: string): Promise<VenueOrderState> {
		const e = this.statusError?.();
		if (e) throw e;
		const o = this.orders.get(id);
		if (!o) throw new Error("없는 주문");
		// 도착한 상대 주문과 맞춘다
		for (const a of this.arrivals) {
			if (!o.open || a.qty <= 0 || a.at > this.clock.t || a.side === o.side) continue;
			const cross = o.side === "BUY" ? a.price <= o.price : a.price >= o.price;
			if (!cross) continue;
			const take = Math.min(a.qty, o.quantity - o.filled);
			a.qty -= take;
			o.filled += take;
			o.amount += take * o.price;
			if (o.filled >= o.quantity) o.open = false;
		}
		return { filledQty: o.filled, avgPrice: o.filled ? o.amount / o.filled : null, open: o.open };
	}
}

const book = (bids: Array<[number, number]>, asks: Array<[number, number]>): Book => ({
	bids: bids.map(([price, volume]) => ({ price, volume })),
	asks: asks.map(([price, volume]) => ({ price, volume })),
	at: 0,
});

const intent = (o: Partial<ExecIntent> = {}): ExecIntent => ({ side: "BUY", quantity: 10, worstPrice: 71_000, urgency: "immediate", deadlineMs: 60_000, nonce: "sig01", ...o });

function run(v: FakeVenue, i: ExecIntent, log: ChildOrder[] = []) {
	return execute(i, v, { now: v.clock.now, sleep: v.clock.sleep, record: async (c) => void log.push(c) });
}

// ── 호가 단위 ────────────────────────────────────────────────

describe("호가 단위", () => {
	it("국장: 구간 경계를 넘나든다", () => {
		assert.equal(stepPrice("KR", 49_950, 1), 50_000);
		assert.equal(stepPrice("KR", 50_000, 1), 50_100);
		assert.equal(stepPrice("KR", 50_000, -1), 49_950);
		assert.equal(stepPrice("KR", 2_000, -1), 1_999);
		assert.equal(stepPrice("KR", 1_999, 1), 2_000);
		assert.equal(stepPrice("KR", 2_005, -1), 2_000);
		assert.equal(stepPrice("KR", 199_900, 1), 200_000);
		assert.equal(stepPrice("KR", 200_000, -1), 199_900);
	});
	it("국장: 매수 상한은 내림, 매도 하한은 올림", () => {
		assert.equal(roundPrice("KR", 71_234, "down"), 71_200);
		assert.equal(roundPrice("KR", 71_234, "up"), 71_300);
		assert.equal(roundPrice("KR", 71_200, "up"), 71_200);
		assert.equal(roundPrice("KR", 4_999, "up"), 4_999 + 1); // 5원 단위 구간 — 5,000
	});
	it("미장: 센트 정수 (부동소수점 잡음 없음)", () => {
		assert.equal(roundPrice("US", 4.35, "down"), 4.35);
		assert.equal(roundPrice("US", 4.351, "down"), 4.35);
		assert.equal(roundPrice("US", 4.351, "up"), 4.36);
		assert.equal(stepPrice("US", 4.35, 1), 4.36);
		assert.equal(stepPrice("US", 0.29, 1), 0.3);
		assert.equal(stepPrice("US", 100, -1), 99.99);
		assert.equal(priceText("US", 4.3), "4.30");
		assert.equal(priceText("KR", 71_200), "71200");
	});
});

// ── 가격 고르기 ──────────────────────────────────────────────

describe("가격 고르기", () => {
	const b = book(
		[
			[70_900, 5],
			[70_800, 20],
		],
		[
			[71_000, 4],
			[71_100, 4],
			[71_200, 50],
		],
	);
	it("sweep: 누적 잔량이 채워지는 호가, 최악 허용가로 자른다", () => {
		assert.equal(sweepPrice(b, "BUY", 3, 72_000), 71_000);
		assert.equal(sweepPrice(b, "BUY", 8, 72_000), 71_100);
		assert.equal(sweepPrice(b, "BUY", 9, 72_000), 71_200);
		assert.equal(sweepPrice(b, "BUY", 9, 71_100), 71_100); // 허용가 밖 호가는 쓰지 않는다
		assert.equal(sweepPrice(b, "BUY", 500, 72_000), 72_000); // 호가가 모자라면 허용가
		assert.equal(sweepPrice(b, "SELL", 10, 70_000), 70_800);
		assert.equal(sweepPrice(book([], []), "SELL", 1, 70_000), 70_000);
	});
	it("join: 우리 쪽 최우선, 없으면 반대편, 허용가 안으로", () => {
		assert.equal(joinPrice(b, "BUY", 72_000), 70_900);
		assert.equal(joinPrice(b, "SELL", 70_000), 71_000);
		assert.equal(joinPrice(book([], [[71_000, 1]]), "BUY", 72_000), 71_000);
		assert.equal(joinPrice(b, "BUY", 70_500), 70_500);
		assert.equal(midPrice(b), 70_950);
	});
	it("슬리피지: 불리한 쪽이 양수", () => {
		assert.equal(slippageBps("BUY", 71_100, 71_000), 14.1);
		assert.equal(slippageBps("SELL", 71_100, 71_000), -14.1);
		assert.equal(slippageBps("BUY", null, 71_000), null);
	});
});

// ── immediate ────────────────────────────────────────────────

describe("immediate", () => {
	it("두 호가에 걸쳐 전량 — 가중 평균, 허용가 안", async () => {
		const clock = new Clock();
		const v = new FakeVenue(
			book(
				[[70_900, 5]],
				[
					[71_000, 4],
					[71_100, 10],
				],
			),
			clock,
		);
		const log: ChildOrder[] = [];
		const r = await run(v, intent({ worstPrice: 71_234 }), log);
		assert.equal(r.status, "filled");
		assert.equal(r.filledQty, 10);
		assert.equal(r.avgPrice, (4 * 71_000 + 6 * 71_100) / 10);
		assert.equal(v.placed.length, 1);
		assert.equal(v.placed[0]!.price, 71_100);
		assert.equal(r.arrivalPrice, 70_950);
		assert.equal(r.reason, null);
		// 보내기 전 기록 → 접수 → 끝
		assert.deepEqual(
			log.map((c) => c.state),
			["sending", "open", "done"],
		);
		assert.equal(log[0]!.orderId, null);
		assert.equal(log[0]!.clientId, "sig01-0");
	});

	it("허용가 안에 호가가 없으면 허용가에 한 번 내고 멈춘다 (취소)", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([[70_900, 5]], [[71_500, 10]]), clock);
		const r = await run(v, intent({ worstPrice: 71_234 }));
		assert.equal(r.status, "none");
		assert.equal(v.placed.length, 1);
		assert.equal(v.placed[0]!.price, 71_200); // 허용가를 호가 단위로 내림
		assert.equal(v.cancels.length, 1);
		assert.match(r.reason ?? "", /허용가 안에 남은 호가가 없습니다/);
	});

	it("IOC 부분 체결 → 호가를 다시 보고 남은 수량만", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([[70_000, 1]], [[71_000, 4]]), clock, "KR", true);
		// 첫 주문 뒤 호가가 다시 찬다
		const place = v.place.bind(v);
		v.place = async (o) => {
			const r = await place(o);
			if (v.placed.length === 1) v.ob.asks = [{ price: 71_000, volume: 100 }];
			return r;
		};
		const r = await run(v, intent({ side: "BUY", worstPrice: 71_000 }));
		assert.equal(r.status, "filled");
		assert.deepEqual(
			v.placed.map((p) => [p.quantity, p.ioc]),
			[
				[10, true],
				[6, true],
			],
		);
	});

	it("매도 — 허용가 이상으로만", async () => {
		const clock = new Clock();
		const v = new FakeVenue(
			book(
				[
					[70_000, 3],
					[69_000, 100],
				],
				[[70_100, 1]],
			),
			clock,
		);
		const r = await run(v, intent({ side: "SELL", quantity: 5, worstPrice: 69_550 }));
		assert.equal(v.placed[0]!.price, 69_600); // 69,550 → 올림 (100원 단위)
		assert.equal(r.filledQty, 3);
		assert.equal(r.status, "partial");
		assert.ok(v.placed.every((p) => p.price >= 69_550));
	});
});

// ── patient ──────────────────────────────────────────────────

describe("patient", () => {
	it("최우선 매수호가에 걸고 10초마다 한 호가씩 — 매도호가에 닿으면 체결", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([[70_900, 5]], [[71_200, 50]]), clock);
		const r = await run(v, intent({ urgency: "patient", worstPrice: 72_000 }));
		assert.equal(r.status, "filled");
		assert.deepEqual(
			v.placed.map((p) => p.price),
			[70_900, 71_000, 71_100, 71_200],
		);
		assert.equal(r.avgPrice, 71_200);
		assert.equal(v.cancels.length, 3);
	});

	it("걸어 둔 사이 상대가 오면 우리 가격에 체결 (가격 개선 없음)", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([[70_900, 5]], [[71_500, 50]]), clock);
		v.arrivals.push({ at: clock.t + 3_000, side: "SELL", price: 70_900, qty: 4 });
		v.arrivals.push({ at: clock.t + 12_000, side: "SELL", price: 71_000, qty: 100 });
		const r = await run(v, intent({ urgency: "patient", worstPrice: 72_000 }));
		assert.equal(r.status, "filled");
		assert.deepEqual(
			v.placed.map((p) => [p.price, p.quantity]),
			[
				[70_900, 10],
				[71_000, 6],
			],
		);
		assert.equal(r.avgPrice, (4 * 70_900 + 6 * 71_000) / 10);
	});

	it("허용가에 닿으면 더 움직이지 않고 기한까지 둔 뒤 잔량 취소", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([[70_900, 5]], [[71_500, 50]]), clock);
		const r = await run(v, intent({ urgency: "patient", worstPrice: 71_000, deadlineMs: 60_000 }));
		assert.equal(r.status, "none");
		assert.deepEqual(
			v.placed.map((p) => p.price),
			[70_900, 71_000],
		);
		assert.ok(v.placed.every((p) => p.price <= 71_000));
		assert.ok(clock.t - 1_000_000 >= 60_000);
		assert.match(r.reason ?? "", /기한/);
	});

	it("시장이 올라가면 최우선 매수호가까지 따라간다 (허용가까지)", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([[70_900, 5]], [[71_500, 50]]), clock);
		const place = v.place.bind(v);
		v.place = async (o) => {
			const r = await place(o);
			if (v.placed.length === 1) v.ob.bids = [{ price: 71_300, volume: 5 }];
			return r;
		};
		await run(v, intent({ urgency: "patient", worstPrice: 71_400, deadlineMs: 30_000 }));
		assert.equal(v.placed[1]!.price, 71_300);
		assert.ok(v.placed.every((p) => p.price <= 71_400));
	});

	it("우리가 취소하지 않았는데 닫히면 다시 내지 않는다", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([[70_900, 5]], [[71_500, 50]]), clock);
		const status = v.status.bind(v);
		v.status = async (id) => {
			const o = v.orders.get(id)!;
			o.open = false;
			return status(id);
		};
		const r = await run(v, intent({ urgency: "patient", worstPrice: 72_000 }));
		assert.equal(v.placed.length, 1);
		assert.equal(r.status, "none");
		assert.match(r.reason ?? "", /증권사가 주문을 닫았습니다/);
	});
});

// ── 실패 ────────────────────────────────────────────────────

describe("실패", () => {
	it("결과 모름 — 멱등성 키가 없으면 다시 보내지 않는다", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([[70_900, 5]], [[71_000, 50]]), clock);
		v.placeError = () => new VenueUnknown("fetch failed");
		const log: ChildOrder[] = [];
		const r = await run(v, intent(), log);
		assert.equal(r.status, "unknown");
		assert.equal(v.placed.length, 1);
		assert.match(r.reason ?? "", /알 수 없습니다/);
		assert.deepEqual(
			log.map((c) => c.state),
			["sending", "unknown"],
		);
	});

	it("결과 모름 — 멱등성 키가 있으면 같은 clientId 로 한 번 (주문은 하나)", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([[70_900, 5]], [[71_000, 50]]), clock, "KR", false, true);
		let n = 0;
		v.placeError = () => (n++ === 0 ? new VenueUnknown("socket hang up") : null);
		const r = await run(v, intent());
		assert.equal(r.status, "filled");
		assert.equal(v.placed.length, 2);
		assert.equal(v.placed[0]!.clientId, v.placed[1]!.clientId);
		assert.equal(v.orders.size, 1);
	});

	it("거절 — 멈추고 이유", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([[70_900, 5]], [[71_000, 50]]), clock);
		v.placeError = () => new VenueRejected("주문가능금액을 초과했습니다");
		const r = await run(v, intent());
		assert.equal(r.status, "none");
		assert.match(r.reason ?? "", /주문가능금액/);
	});

	it("잔량 취소를 확인하지 못하면 unknown", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([[70_900, 5]], [[71_500, 50]]), clock);
		v.cancelIgnored = true;
		const r = await run(v, intent({ worstPrice: 71_000 }));
		assert.equal(r.status, "unknown");
		assert.match(r.reason ?? "", /잔량 취소를 확인하지 못했습니다/);
		assert.equal(r.children[0]!.state, "unknown"); // 기록에도 — 기동 복구가 이 주문을 다시 확인한다
	});

	it("상태 조회가 계속 실패하면 unknown (주문번호 안내)", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([[70_900, 5]], [[71_500, 50]]), clock);
		v.statusError = () => new Error("EGW00201 초당 거래건수 초과");
		const r = await run(v, intent({ worstPrice: 71_000 }));
		assert.equal(r.status, "unknown");
		assert.match(r.reason ?? "", /O1/);
	});

	it("기록이 실패하면 주문하지 않는다", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([[70_900, 5]], [[71_000, 50]]), clock);
		await assert.rejects(execute(intent(), v, { now: clock.now, sleep: clock.sleep, record: async () => Promise.reject(new Error("D1 down")) }), /D1 down/);
		assert.equal(v.placed.length, 0);
	});

	it("비상 정지 — 걸린 주문을 취소하고 새로 내지 않는다", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([[70_900, 5]], [[71_500, 50]]), clock);
		let stop = false;
		setTimeout(() => (stop = true), 0);
		const r = await execute(intent({ urgency: "patient", worstPrice: 72_000 }), v, {
			now: clock.now,
			sleep: async (ms) => {
				clock.t += ms;
				if (clock.t - 1_000_000 >= 5_000) stop = true;
			},
			shouldStop: () => stop,
		});
		assert.equal(v.placed.length, 1);
		assert.equal(v.cancels.length, 1);
		assert.equal(r.status, "none");
		assert.match(r.reason ?? "", /비상 정지/);
		const r2 = await execute(intent(), v, { now: clock.now, sleep: clock.sleep, shouldStop: () => true });
		assert.equal(v.placed.length, 1);
		assert.equal(r2.children.length, 0);
	});

	it("입력 검증 — 소수 수량·nonce 형식", async () => {
		const clock = new Clock();
		const v = new FakeVenue(book([], []), clock);
		await assert.rejects(run(v, intent({ quantity: 1.5 })), /수량/);
		await assert.rejects(run(v, intent({ nonce: "a b" })), /nonce/);
	});
});
