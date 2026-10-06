/**
 * 코인 자동 매매 (PLAN §40 4단계) — 격자 · 규칙 · 체결기(소수 수량) · Binance 체결 어댑터(가짜 fetch).
 *
 * 지켜야 할 것:
 *   - 가격·수량은 거래소 단위에 **10진으로** 맞춘다 (0.3 − 0.1 같은 부동소수점 잡음에 한 단위를 깎지 않는다)
 *   - 금액 주문은 최악 허용가로 나눠 수량 단위로 내림 — 금액을 넘지 않는다. 최소 수량·최소 주문금액 미만은 내지 않는다
 *   - 24시간 (장 시간 없음), 하루는 UTC, 한도는 USDT, USDT 마켓만
 *   - Binance 주문은 LIMIT + IOC/GTC, newClientOrderId = 체결기 clientId
 *   - 4xx 는 거절, 5xx·-1007·연결 끊김은 결과 모름 — 모름이면 clientId 로 한 번 찾아본다 (다시 보내지 않는다)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SymbolRules } from "../src/binance/trade.ts";
import { execute } from "../src/triggers/executor.ts";
import {
	cryptoAutoProblem,
	cryptoBase,
	currencyOf,
	dailyLimitProblem,
	moneyText,
	orderText,
	planOrder,
	protectPrices,
	qtyText,
	sessionProblem,
	sessionRemainingMs,
	sizeText,
	tradingDay,
	validateOrderRule,
} from "../src/triggers/rule.ts";
import { binanceBook, binanceOrderState, binanceVenue, classifyBinance, cryptoGrid, plainDecimal } from "../src/triggers/venues/binance.ts";
import { gridOf } from "../src/triggers/venues/tick.ts";
import { VenueRejected, VenueUnknown, type Book, type ExecVenue, type VenueOrderState, type VenuePlace } from "../src/triggers/venues/types.ts";

const BTC: SymbolRules = {
	symbol: "BTCUSDT", status: "TRADING", base: "BTC", quote: "USDT", orderTypes: ["LIMIT", "MARKET"], spot: true,
	tickSize: "0.01000000", minPrice: "0.01", maxPrice: "1000000", stepSize: "0.00001000", minQty: "0.00001000", maxQty: "9000",
	marketStepSize: "0.00001", marketMinQty: "0", marketMaxQty: "120", minNotional: "5.00000000", notionalAppliesToMarket: true,
};
/** 가격이 작은 코인 — tick 0.00000001, 수량 정수 */
const PEPE: SymbolRules = { ...BTC, symbol: "PEPEUSDT", base: "PEPE", tickSize: "0.00000001", stepSize: "1.00000000", minQty: "1.00000000", minNotional: "1.00000000" };

describe("코인 격자 (10진)", () => {
	const g = cryptoGrid(BTC);

	it("가격 — 내림·올림·한 호가", () => {
		assert.equal(g.roundPrice(83_886.466, "down"), 83_886.46);
		assert.equal(g.roundPrice(83_886.466, "up"), 83_886.47);
		assert.equal(g.roundPrice(83_886.46, "up"), 83_886.46, "이미 단위면 그대로");
		assert.equal(g.stepPrice(83_886.46, 1), 83_886.47);
		assert.equal(g.stepPrice(83_886.46, -1), 83_886.45);
		assert.equal(g.stepPrice(0.3, -1), 0.29);
		const p = cryptoGrid(PEPE);
		assert.equal(p.roundPrice(0.0000123456, "down"), 0.00001234);
		assert.equal(p.roundPrice(0.0000123456, "up"), 0.00001235);
		assert.equal(p.stepPrice(0.00001234, 1), 0.00001235);
	});

	it("수량 — 부동소수점 잡음에 한 단위를 깎지 않는다", () => {
		const c = cryptoGrid({ ...BTC, stepSize: "0.01000000" });
		assert.equal(0.3 - 0.1, 0.19999999999999998, "대조군");
		assert.equal(c.floorQty(0.3 - 0.1), 0.2);
		assert.equal(g.floorQty(0.1 + 0.2), 0.3);
		assert.equal(g.floorQty(0.0011786), 0.00117);
		assert.equal(g.floorQty(0), 0);
		assert.equal(cryptoGrid(PEPE).floorQty(12_345_678.9), 12_345_678);
		assert.equal(g.minQty, 0.00001);
		assert.equal(g.minNotional, 5);
		assert.equal(g.unit, "BTC");
	});

	it("10진 문자열 — 잡음 제거, 지수 표기 없음", () => {
		assert.equal(plainDecimal(84_000 * 1.1), "92400");
		assert.equal(plainDecimal(0.3 - 0.1), "0.2");
		assert.equal(plainDecimal(1.23e-7), "0.000000123");
		assert.equal(plainDecimal(12_345_678.9), "12345678.9");
		assert.equal(plainDecimal(7), "7");
		// 올림이 잡음 때문에 한 호가 더 올라가지 않는다
		assert.equal(g.roundPrice(84_000 * 1.1, "up"), 92_400);
		const p = cryptoGrid(PEPE);
		assert.equal(p.roundPrice(0.000000123456, "down"), 0.00000012);
		assert.equal(p.roundPrice(0.00000012, "up"), 0.00000012);
		assert.equal(p.stepPrice(0.00000012, -1), 0.00000011);
	});

	it("gridOf — 코인 어댑터가 grid 를 안 주면 멈춘다 (주식 표로 코인 가격을 자르지 않는다)", () => {
		assert.throws(() => gridOf({ market: "CRYPTO" }), /grid/);
		assert.equal(gridOf({ market: "KR" }).roundPrice(71_659, "down"), 71_600);
	});
});

describe("코인 규칙 · 리스크", () => {
	const grid = cryptoGrid(BTC);
	const BUY = { side: "BUY" as const, worstPct: 1, urgency: "patient" as const, deadlineSec: 60 };
	const SELL = { side: "SELL" as const, worstPct: 2, urgency: "immediate" as const, deadlineSec: 30 };

	it("금액 매수 — 최악 허용가로 나눠 수량 단위 내림, 금액을 넘지 않는다", () => {
		const p = planOrder({ ...BUY, size: { amount: 100 } }, { grid, ref: 84_000 });
		assert.ok(!("error" in p));
		// 84,000 × 1.01 = 84,840 → 100 / 84,840 = 0.0011786… → 0.00117
		assert.equal(p.worstPrice, 84_840);
		assert.equal(p.quantity, 0.00117);
		assert.ok(p.maxAmount <= 100);
	});

	it("수량·보유 % 매도 — 매도 가능 수량(수량 단위 내림)으로 자른다", () => {
		const a = planOrder({ ...SELL, size: { qty: 0.5 } }, { grid, ref: 84_000, sellable: 0.0123456 });
		assert.ok(!("error" in a));
		assert.equal(a.quantity, 0.01234);
		const b = planOrder({ ...SELL, size: { holdingPct: 50 } }, { grid, ref: 84_000, sellable: 0.02 });
		assert.ok(!("error" in b));
		assert.equal(b.quantity, 0.01);
	});

	it("최소 수량·최소 주문금액 미만은 small 로 거절 (보호 트리거가 부스러기를 포기하는 근거)", () => {
		const tiny = planOrder({ ...SELL, size: { qty: 0.00001 } }, { grid, ref: 84_000, sellable: 0.000009 });
		assert.ok("error" in tiny && tiny.small);
		assert.match("error" in tiny ? tiny.error : "", /최소 수량\(0\.00001 BTC\)/);
		const cheap = planOrder({ ...BUY, size: { amount: 4 } }, { grid, ref: 84_000 });
		assert.ok("error" in cheap && cheap.small);
		assert.match("error" in cheap ? cheap.error : "", /최소 주문금액\(5\)/);
	});

	it("검증 — qty 는 0보다 크게, 수량 종류는 하나만", () => {
		assert.deepEqual(validateOrderRule({ ...BUY, size: { qty: 0.01 } }), []);
		assert.ok(validateOrderRule({ ...BUY, size: { qty: 0 } }).some((e) => /코인 수량/.test(e)));
		assert.ok(validateOrderRule({ ...BUY, size: { qty: 1, amount: 1 } as never }).some((e) => /하나만/.test(e)));
	});

	it("24시간 · UTC 하루 · USDT · USDT 마켓만", () => {
		const t = Date.parse("2026-09-27T23:30:00Z"); // 일요일 밤 (KST 월 08:30)
		assert.equal(sessionProblem("binance", t), null);
		assert.equal(sessionRemainingMs("binance", t), Number.POSITIVE_INFINITY);
		assert.equal(tradingDay("binance", t), "2026-09-27");
		assert.equal(currencyOf("binance"), "USDT");
		assert.equal(cryptoAutoProblem("BTCUSDT"), null);
		assert.match(cryptoAutoProblem("ETHBTC") ?? "", /USDT 마켓만/);
		assert.match(cryptoAutoProblem("USDT") ?? "", /USDT 마켓만/);
		assert.equal(cryptoBase("BTCUSDT"), "BTC");
	});

	it("표시 — USDT 금액·코인 수량·한도 초과 문장·주문 한 줄", () => {
		assert.equal(moneyText(1234.5, "USDT"), "1,234.5 USDT");
		assert.equal(moneyText(0.00001234, "USDT"), "0.00001234 USDT");
		assert.equal(qtyText(0.00000123, "BTC"), "0.00000123 BTC", "지수 표기 없이");
		assert.equal(sizeText({ qty: 0.015 }, "USDT", "BTC"), "0.015 BTC");
		assert.equal(sizeText({ amount: 500 }, "USDT"), "500 USDT어치");
		assert.match(dailyLimitProblem(300, 800, 1000, "USDT") ?? "", /오늘 800 USDT \+ 이번 최대 300 USDT > 한도 1,000 USDT/);
		const target = { broker: "binance" as const, account: "x", accountLabel: "Binance 현물 (키 abc123)" };
		assert.equal(orderText({ target, order: { ...BUY, size: { amount: 500 } } }, "binance", "ETHUSDT"), "매수 500 USDT어치 · Binance 현물 (키 abc123) · 최악 +1% · 기다리며 60초");
		assert.equal(
			orderText({ target, order: { ...SELL, size: { qty: 0.5 } }, position: { shares: 0.5, avgPrice: 0, stopPrice: 2400, takePrice: null, parentId: null } }, "binance", "ETHUSDT"),
			"보호 0.5 ETH · Binance 현물 (키 abc123)",
		);
	});

	it("보호 가격 — 코인 격자로 손절 내림·익절 올림", () => {
		const r = protectPrices({ stop: { pct: 5 }, take: { pct: 10 } }, 84_123.45, grid);
		assert.equal(r.stopPrice, 79_917.27); // 79,917.2775 → 내림
		assert.equal(r.takePrice, 92_535.8); // 92,535.795 → 올림
	});
});

// ── 체결기 + 소수 수량 ────────────────────────────────────────

class Clock {
	t = 1_000_000;
	now = () => this.t;
	sleep = async (ms: number) => {
		this.t += ms;
	};
}

/** IOC 는 반대편 호가와 맞춰 보고 남은 건 버린다. fills 로 체결 수량을 정할 수 있다 */
class CoinVenue implements ExecVenue {
	label = "가짜 Binance";
	market = "CRYPTO" as const;
	symbol = "BTCUSDT";
	grid = cryptoGrid(BTC);
	supportsIoc = true;
	idempotent = false;
	placed: VenuePlace[] = [];
	orders = new Map<string, { o: VenuePlace; filled: number }>();
	/** 주문마다 체결 수량 (없으면 전부) */
	fills: number[] = [];
	ob: Book = { bids: [{ price: 83_999.99, volume: 1 }], asks: [{ price: 84_000, volume: 1 }], at: 0 };
	private n = 0;
	async book() {
		return structuredClone(this.ob);
	}
	async place(o: VenuePlace) {
		this.placed.push({ ...o });
		const id = `B${++this.n}`;
		const f = this.fills.shift();
		this.orders.set(id, { o, filled: f ?? o.quantity });
		return { orderId: id };
	}
	async cancel() {}
	async status(id: string): Promise<VenueOrderState> {
		const x = this.orders.get(id)!;
		return { filledQty: x.filled, avgPrice: x.filled > 0 ? x.o.price : null, open: false };
	}
}

describe("체결기 — 코인 소수 수량", () => {
	it("IOC 매도 — 부분 체결 뒤 잔량을 수량 단위로 정확히 (0.00117 − 0.0005 = 0.00067)", async () => {
		const clock = new Clock();
		const v = new CoinVenue();
		v.fills = [0.0005, 0.00067];
		const r = await execute({ side: "SELL", quantity: 0.00117, worstPrice: 82_000, urgency: "immediate", deadlineMs: 30_000, nonce: "xabc" }, v, { now: clock.now, sleep: clock.sleep });
		assert.deepEqual(
			v.placed.map((p) => [p.quantity, p.ioc]),
			[
				[0.00117, true],
				[0.00067, true],
			],
		);
		assert.equal(r.status, "filled");
		assert.equal(r.filledQty, 0.00117);
	});

	it("남은 잔량이 최소 주문금액 미만이면 더 내지 않는다 (거래소가 거절한다)", async () => {
		const clock = new Clock();
		const v = new CoinVenue();
		v.fills = [0.00112]; // 남은 0.00005 BTC × 84,000 = 4.2 USDT < 5
		const r = await execute({ side: "BUY", quantity: 0.00117, worstPrice: 84_840, urgency: "immediate", deadlineMs: 30_000, nonce: "xdef" }, v, { now: clock.now, sleep: clock.sleep });
		assert.equal(v.placed.length, 1);
		assert.equal(r.status, "partial");
		assert.equal(r.filledQty, 0.00112);
		assert.match(r.reason ?? "", /최소 주문금액/);
	});

	it("수량이 단위에 안 맞으면 시작하지 않는다", async () => {
		await assert.rejects(execute({ side: "BUY", quantity: 0.000123, worstPrice: 84_840, urgency: "immediate", deadlineMs: 30_000, nonce: "x1" }, new CoinVenue()), /수량이 올바르지 않습니다/);
	});
});

// ── Binance 어댑터 (가짜 fetch) ────────────────────────────────

interface Req {
	method: string;
	path: string;
	query: Record<string, string>;
	headers: Record<string, string>;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const CREDS = { key: "k".repeat(64), secret: "s".repeat(64) };

function venueWith(reply: (r: Req) => Response | Promise<Response>) {
	const reqs: Req[] = [];
	const f = async (input: string, init?: RequestInit) => {
		const u = new URL(input);
		const r = { method: init?.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), headers: (init?.headers ?? {}) as Record<string, string> };
		reqs.push(r);
		return reply(r);
	};
	return { reqs, make: () => binanceVenue(CREDS, "BTCUSDT", { fetch: f, rules: BTC, sleep: async () => {}, now: () => 1_700_000_000_000 }) };
}

describe("Binance 체결 어댑터", () => {
	it("지정가 IOC — 요청을 한 글자씩 (단위에 맞춘 문자열, clientId, 서명, 키 헤더)", async () => {
		const { reqs, make } = venueWith(() => json({ orderId: 991, status: "FILLED" }));
		const v = await make();
		assert.equal(v.market, "CRYPTO");
		assert.equal(v.supportsIoc, true);
		assert.equal(v.idempotent, false);
		const r = await v.place({ side: "BUY", quantity: 0.00117, price: 84_840, ioc: true, clientId: "x0123456789abcdef-0" });
		assert.deepEqual(r, { orderId: "991" });
		const q = reqs[0]!;
		assert.equal(q.method, "POST");
		assert.equal(q.path, "/api/v3/order");
		assert.equal(q.headers["X-MBX-APIKEY"], CREDS.key);
		assert.deepEqual(
			{ ...q.query, signature: undefined, timestamp: undefined },
			{ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", timeInForce: "IOC", quantity: "0.00117", price: "84840", newClientOrderId: "x0123456789abcdef-0", newOrderRespType: "RESULT", recvWindow: "5000", signature: undefined, timestamp: undefined },
		);
		assert.match(q.query.signature ?? "", /^[0-9a-f]{64}$/);
		// 걸어 두기는 GTC, 가격 잡음은 단위로
		await v.place({ side: "SELL", quantity: 0.1 + 0.2, price: 84_000.10000000001, ioc: false, clientId: "x-1" });
		assert.equal(reqs[1]!.query.timeInForce, "GTC");
		assert.equal(reqs[1]!.query.quantity, "0.3");
		assert.equal(reqs[1]!.query.price, "84000.1");
	});

	it("호가 — 공개 depth, 정렬", async () => {
		const { reqs, make } = venueWith(() => json({ bids: [["83999.00", "0.5"], ["84000.00", "0.1"]], asks: [["84002.00", "1"], ["84001.00", "0"], ["84001.50", "2"]] }));
		const b = await (await make()).book();
		assert.equal(reqs[0]!.path, "/api/v3/depth");
		assert.equal(reqs[0]!.headers["X-MBX-APIKEY"], undefined, "공개 경로는 키를 싣지 않는다");
		assert.deepEqual(b.bids.map((l) => l.price), [84_000, 83_999]);
		assert.deepEqual(b.asks.map((l) => l.price), [84_001.5, 84_002], "잔량 0 은 뺀다");
	});

	it("상태 — 체결량·평균가(누적 금액 ÷ 체결량)·열림", () => {
		assert.deepEqual(binanceOrderState({ status: "PARTIALLY_FILLED", executedQty: "0.00050000", cummulativeQuoteQty: "42.00000000" }), { filledQty: 0.0005, avgPrice: 84_000, open: true });
		assert.deepEqual(binanceOrderState({ status: "FILLED", executedQty: "0.001", cummulativeQuoteQty: "84.1" }), { filledQty: 0.001, avgPrice: 84_100, open: false });
		assert.deepEqual(binanceOrderState({ status: "EXPIRED", executedQty: "0", cummulativeQuoteQty: "0" }), { filledQty: 0, avgPrice: null, open: false }, "IOC 잔량 만료");
		assert.deepEqual(binanceOrderState({ status: "CANCELED", executedQty: "0.0002", cummulativeQuoteQty: "16.8" }), { filledQty: 0.0002, avgPrice: 84_000, open: false });
		assert.equal(binanceOrderState({ status: "REJECTED", executedQty: "0" }).rejected, "거래소가 주문을 거부했습니다");
		assert.equal(binanceOrderState({ status: "EXPIRED_IN_MATCH", executedQty: "0" }).open, false);
		assert.deepEqual(binanceBook({ bids: "x", asks: null }, 1), { bids: [], asks: [], at: 1 });
	});

	it("오류 구분 — 4xx 거절, 5xx·-1006·-1007·연결 끊김 모름", () => {
		assert.ok(classifyBinance(400, { code: -2010, msg: "Account has insufficient balance" }, "") instanceof VenueRejected);
		assert.ok(classifyBinance(429, { code: -1003, msg: "Too many requests" }, "") instanceof VenueRejected);
		assert.ok(classifyBinance(503, null, "Service Unavailable") instanceof VenueUnknown);
		assert.ok(classifyBinance(408, { code: -1007, msg: "Timeout waiting for response from backend server. Send status unknown" }, "") instanceof VenueUnknown);
		assert.ok(classifyBinance(400, { code: -1006, msg: "unexpected" }, "") instanceof VenueUnknown);
		assert.ok(classifyBinance(0, null, "fetch failed") instanceof VenueUnknown);
	});

	it("거절은 그대로 거절 (찾아보지 않는다), 키·시크릿은 메시지에서 가린다", async () => {
		const { reqs, make } = venueWith(() => json({ code: -2010, msg: `bad key ${CREDS.key}` }, 400));
		const v = await make();
		await assert.rejects(v.place({ side: "BUY", quantity: 0.001, price: 84_000, ioc: true, clientId: "x-0" }), (e: Error) => e instanceof VenueRejected && !e.message.includes(CREDS.key) && e.message.includes("****"));
		assert.equal(reqs.length, 1);
	});

	it("결과 모름 → clientId 로 찾아서 있으면 그 주문, 없으면 모름 (다시 보내지 않는다)", async () => {
		let found = true;
		const { reqs, make } = venueWith((r) => {
			if (r.method === "POST") return new Response("<html>502</html>", { status: 502 });
			if (r.query.origClientOrderId) return found ? json({ orderId: 555, status: "FILLED" }) : json({ code: -2013, msg: "Order does not exist." }, 400);
			return json({});
		});
		const v = await make();
		assert.deepEqual(await v.place({ side: "BUY", quantity: 0.001, price: 84_000, ioc: true, clientId: "xq-0" }), { orderId: "555" });
		assert.equal(reqs[1]!.query.origClientOrderId, "xq-0");
		found = false;
		await assert.rejects(v.place({ side: "BUY", quantity: 0.001, price: 84_000, ioc: true, clientId: "xq-1" }), VenueUnknown);
		assert.equal(reqs.filter((r) => r.method === "POST").length, 2, "POST 는 주문마다 한 번씩만");
	});

	it("취소·상태 — orderId 로", async () => {
		const { reqs, make } = venueWith((r) => (r.method === "DELETE" ? json({ status: "CANCELED" }) : json({ status: "NEW", executedQty: "0", cummulativeQuoteQty: "0" })));
		const v = await make();
		await v.cancel("991");
		const s = await v.status("991");
		assert.deepEqual([reqs[0]!.method, reqs[0]!.path, reqs[0]!.query.orderId], ["DELETE", "/api/v3/order", "991"]);
		assert.deepEqual([reqs[1]!.method, reqs[1]!.query.orderId, s.open], ["GET", "991", true]);
	});

	it("체결 수수료를 주문별로 서명 조회하고 1000건을 넘으면 다음 페이지를 읽는다", async () => {
		const { reqs, make } = venueWith((request) => {
			const count = request.query.fromId ? 1 : 1000;
			const firstId = Number(request.query.fromId ?? 1);
			return json(Array.from({ length: count }, (_, index) => ({
				id: firstId + index, orderId: 991, qty: "0.001", commission: "0", commissionAsset: "USDT",
			})));
		});
		const venue = await make();
		assert.deepEqual(await venue.settlement!("991", 1.001), { baseFeeQty: 0, quoteFee: 0 });
		assert.equal(reqs.length, 2);
		assert.equal(reqs[0]!.path, "/api/v3/myTrades");
		assert.equal(reqs[0]!.query.orderId, "991");
		assert.equal(reqs[0]!.headers["X-MBX-APIKEY"], CREDS.key);
		assert.equal(reqs[1]!.query.fromId, "1001");
	});

	it("요청 제한 Retry-After를 어댑터 재생성 후에도 존중한다", async () => {
		let clock = 1_900_000_000_000;
		let calls = 0;
		const options = {
			rules: BTC,
			now: () => clock,
			fetch: async () => {
				calls++;
				if (calls === 1) return new Response(JSON.stringify({ code: -1003, msg: "Too many requests" }), { status: 429, headers: { "Retry-After": "30" } });
				return json({ bids: [["2700", "1"]], asks: [["2701", "1"]] });
			},
		};
		const creds = { ...CREDS, testnet: true };
		await assert.rejects((await binanceVenue(creds, "BTCUSDT", options)).book(), VenueRejected);
		await assert.rejects((await binanceVenue(creds, "BTCUSDT", options)).book(), /요청 제한/);
		assert.equal(calls, 1);
		clock += 30_001;
		await (await binanceVenue(creds, "BTCUSDT", options)).book();
		assert.equal(calls, 2);
	});

	it("거래할 수 없는 종목이면 만들지 않는다", async () => {
		await assert.rejects(binanceVenue(CREDS, "BTCUSDT", { rules: { ...BTC, status: "BREAK" } }), /거래할 수 없습니다/);
		await assert.rejects(binanceVenue(CREDS, "BTCUSDT", { rules: { ...BTC, spot: false } }), /현물 거래가 막혀/);
	});
});
