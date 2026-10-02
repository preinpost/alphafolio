/**
 * Binance 미국 주식 직접 거래 (`/sapi/v1/equity`) — 돈이 움직이는 코드라 요청을 한 글자씩 검사한다.
 *
 * 지켜야 할 것:
 *   - tokenize=false 를 늘 보낸다 (기본 true — 안 보내면 산 주식이 bStock 토큰이 된다)
 *   - 필드 조합 표: LIMIT = price+quantity+tradingSession · MARKET 매수 = notional · MARKET 매도 = quantity
 *   - clientOrderId 32~36자 — 짧은 id 는 "_" 로 채운다 (n=1 과 n=10 이 겹치지 않게)
 *   - 가격 0.01 · 수량 stepSize(소수점 주식) · 최소 5 USDC · 기준가 범위
 *   - 접수 응답 status F = 거절, 응답 없음·5xx = 모름 → clientOrderId 로 찾아본다 (다시 보내지 않는다)
 *   - 보유는 체결 내역(매수 − 매도)으로
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validateEquityOrder } from "../src/binance/stock-order-tool.ts";
import {
	clearEquityRulesCache,
	equityClientId,
	equityPlaceParams,
	netPosition,
	parseEquityRules,
	tradabilityProblem,
	type EquityRules,
} from "../src/binance/stocks.ts";
import { executeOrderAction } from "../src/execute.ts";
import { execute } from "../src/triggers/executor.ts";
import { planOrder } from "../src/triggers/rule.ts";
import { binanceStockVenue, classifyEquityError, equityGrid, equityOrderState } from "../src/triggers/venues/binance-stock.ts";
import { VenueRejected, VenueUnknown } from "../src/triggers/venues/types.ts";
import { BinanceStockError, parseEquityOrder } from "../src/binance/stocks.ts";

/** 실측 AAPL exchangeInfo (2026-10-01) */
const AAPL_INFO = {
	timezone: "UTC",
	symbols: [
		{
			symbol: "AAPL", tradability: "BUY_SELL", overnightSupported: true, fractionable: true, fractionableEh: true, extendedSession: true, maxNumOrders: 200,
			stepSize: "0.000000001", multiplierUp: "1.1000", multiplierDown: "0.9000", maxQty: "1000000.000000000", minNotional: "5.00000000", maxNotional: "1000000.00000000", listingTime: 1778233200000,
		},
	],
};
const AAPL = parseEquityRules(AAPL_INFO) as EquityRules;
const CREDS = { key: "k".repeat(64), secret: "s".repeat(64) };

const realFetch = globalThis.fetch;
beforeEach(() => clearEquityRulesCache());
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("규칙 · 요청 파라미터 (순수)", () => {
	it("exchangeInfo — 소수점이 안 되는 종목은 1주 단위", () => {
		assert.equal(AAPL.stepSize, "0.000000001");
		assert.equal(AAPL.minQty, "0.000000001");
		assert.equal(AAPL.minNotional, "5.00000000");
		const whole = parseEquityRules({ symbols: [{ ...AAPL_INFO.symbols[0], symbol: "BRK.A", fractionable: false, minQty: undefined }] })!;
		assert.equal(whole.stepSize, "1");
		assert.equal(whole.minQty, "1");
		assert.equal(parseEquityRules({ symbols: [] }), null, "모르는 티커는 빈 배열");
	});

	it("거래 가능 방향", () => {
		assert.equal(tradabilityProblem(AAPL, "BUY"), null);
		assert.match(tradabilityProblem({ ...AAPL, tradability: "SELL" }, "BUY") ?? "", /매도만/);
		assert.match(tradabilityProblem({ ...AAPL, tradability: "NONE" }, "SELL") ?? "", /거래할 수 없습니다/);
	});

	it("지정가 — price·quantity·DAY·RTH·tokenize=false", () => {
		assert.deepEqual(equityPlaceParams({ symbol: "AAPL", side: "BUY", orderType: "LIMIT", price: "332.40", quantity: "0.3", clientOrderId: "x0123456789abcdef-1" }), {
			symbol: "AAPL", side: "BUY", orderType: "LIMIT", quoteAsset: "USDC", clientOrderId: "x0123456789abcdef-1_____________",
			tokenize: "false", price: "332.40", quantity: "0.3", timeInForce: "DAY", tradingSession: "RTH",
		});
		assert.throws(() => equityPlaceParams({ symbol: "AAPL", side: "BUY", orderType: "LIMIT", price: "332.405", quantity: "1", clientOrderId: "a" }), /소수 2자리/);
	});

	it("시장가 — 매수는 notional 만, 매도는 quantity 만 (session 없음)", () => {
		const b = equityPlaceParams({ symbol: "NVDA", side: "BUY", orderType: "MARKET", notional: "100", clientOrderId: "af0123456789abcdef01234567" });
		assert.deepEqual([b.notional, b.quantity, b.price, b.tradingSession, b.tokenize], ["100", undefined, undefined, undefined, "false"]);
		const s = equityPlaceParams({ symbol: "NVDA", side: "SELL", orderType: "MARKET", quantity: "0.5", clientOrderId: "af0123456789abcdef01234567" });
		assert.deepEqual([s.quantity, s.notional, s.tradingSession], ["0.5", undefined, undefined]);
		assert.throws(() => equityPlaceParams({ symbol: "NVDA", side: "BUY", orderType: "MARKET", quantity: "1", clientOrderId: "a" }), /notional/);
	});

	it("clientOrderId — 32자로 채우되 n=1 과 n=10 이 겹치지 않는다", () => {
		const a = equityClientId("x0123456789abcdef-1");
		const b = equityClientId("x0123456789abcdef-10");
		assert.equal(a.length, 32);
		assert.notEqual(a, b);
		assert.match(a, /^[a-zA-Z0-9-_]{32,36}$/);
		assert.equal(equityClientId("a".repeat(36)), "a".repeat(36));
		assert.throws(() => equityClientId("a".repeat(37)), /형식/);
	});

	it("보유 추정 — 매수 − 매도, 평단은 이동평균 (매도는 평단을 안 바꾼다)", () => {
		const p = netPosition([
			{ side: "BUY", qty: "0.3", price: "300", at: 1 },
			{ side: "BUY", qty: "0.1", price: "340", at: 2 },
			{ side: "SELL", qty: "0.2", price: "350", at: 3 },
		]);
		assert.equal(p.qty, 0.2);
		assert.equal(p.avgPrice, 310);
		assert.deepEqual(netPosition([{ side: "BUY", qty: "1", price: "10", at: 1 }, { side: "SELL", qty: "1", price: "11", at: 2 }]), { qty: 0, avgPrice: null });
	});
});

describe("격자 · 규칙 — 소수점 주식", () => {
	const g = equityGrid(AAPL);
	it("금액 매수는 소수점 주식으로 (금액을 넘지 않는다), 5 USDC 미만은 small", () => {
		const p = planOrder({ side: "BUY", size: { amount: 100 }, worstPct: 1, urgency: "patient", deadlineSec: 60 }, { grid: g, ref: 332.51 });
		assert.ok(!("error" in p));
		assert.equal(p.worstPrice, 335.83);
		assert.equal(p.quantity, 0.297769704); // 100 / 335.83 = 0.2977697046… → 1e-9 내림
		assert.ok(p.maxAmount <= 100);
		const tiny = planOrder({ side: "BUY", size: { amount: 4 }, worstPct: 1, urgency: "patient", deadlineSec: 60 }, { grid: g, ref: 332.51 });
		assert.ok("error" in tiny && tiny.small);
		assert.equal(g.unit, "주");
		assert.equal(g.roundPrice(332.519, "down"), 332.51);
	});
});

describe("수동 주문 검증 (binance_stock_order)", () => {
	it("지정가 — 0.01·수량 단위로 내림, 금액 추정", () => {
		const v = validateEquityOrder({ side: "BUY", type: "LIMIT", price: "330.129", quantity: "0.5" }, AAPL, "332.5", null);
		assert.deepEqual(v.errors, []);
		assert.equal(v.price, "330.12");
		assert.equal(v.quantity, "0.5");
		assert.equal(v.estimated, "165.06");
		assert.ok(v.warnings.some((w) => /0\.01/.test(w)));
	});

	it("막는 것 — 조합·최소 금액·기준가 범위·방향", () => {
		assert.ok(validateEquityOrder({ side: "BUY", type: "MARKET", quantity: "1" }, AAPL, "332", null).errors.some((e) => /금액\(notional/.test(e)));
		assert.ok(validateEquityOrder({ side: "BUY", type: "LIMIT", price: "332", quantity: "0.01" }, AAPL, "332", null).errors.some((e) => /최소 주문금액/.test(e)));
		assert.ok(validateEquityOrder({ side: "BUY", type: "LIMIT", price: "400", quantity: "1" }, AAPL, "332", null).errors.some((e) => /허용 범위/.test(e)));
		assert.ok(validateEquityOrder({ side: "BUY", type: "MARKET", notional: "100" }, { ...AAPL, tradability: "SELL" }, "332", null).errors.some((e) => /매도만/.test(e)));
	});

	it("매도가 체결 내역 보유보다 많으면 경고 (막지는 않는다 — 거래소가 판단)", () => {
		const v = validateEquityOrder({ side: "SELL", type: "MARKET", quantity: "2" }, AAPL, "332", 1.5);
		assert.deepEqual(v.errors, []);
		assert.ok(v.warnings.some((w) => /보유\(1\.5주\)보다 많습니다/.test(w)));
	});
});

// ── 어댑터 (가짜 fetch) ──

interface Req {
	method: string;
	path: string;
	query: Record<string, string>;
	headers: Record<string, string>;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
function venueWith(reply: (r: Req) => Response | Promise<Response>) {
	const reqs: Req[] = [];
	const f = async (input: string, init?: RequestInit) => {
		const u = new URL(input);
		const r = { method: init?.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), headers: (init?.headers ?? {}) as Record<string, string> };
		reqs.push(r);
		return reply(r);
	};
	return { reqs, make: () => binanceStockVenue(CREDS, "AAPL", { fetch: f, rules: AAPL, sleep: async () => {}, now: () => 1_790_000_000_000 }) };
}

describe("Binance 미국 주식 체결 어댑터", () => {
	it("지정가 — POST /sapi/v1/equity/order/place, 서명, tokenize=false, RTH·DAY, IOC 없음", async () => {
		const { reqs, make } = venueWith(() => json({ status: "S", orderId: "3f1c-uuid", clientOrderId: "x" }));
		const v = await make();
		assert.equal(v.market, "US");
		assert.equal(v.supportsIoc, false);
		assert.equal(v.idempotent, false);
		assert.deepEqual(await v.place({ side: "BUY", quantity: 0.297770896, price: 335.83, ioc: false, clientId: "x0123456789abcdef-0" }), { orderId: "3f1c-uuid" });
		const q = reqs[0]!;
		assert.deepEqual([q.method, q.path], ["POST", "/sapi/v1/equity/order/place"]);
		assert.equal(q.headers["X-MBX-APIKEY"], CREDS.key);
		assert.match(q.query.signature ?? "", /^[0-9a-f]{64}$/);
		assert.deepEqual(
			{ ...q.query, signature: undefined, timestamp: undefined, recvWindow: undefined },
			{ symbol: "AAPL", side: "BUY", orderType: "LIMIT", quoteAsset: "USDC", clientOrderId: "x0123456789abcdef-0_____________", tokenize: "false", price: "335.83", quantity: "0.297770896", timeInForce: "DAY", tradingSession: "RTH", signature: undefined, timestamp: undefined, recvWindow: undefined },
		);
		await assert.rejects(v.place({ side: "BUY", quantity: 1, price: 1, ioc: true, clientId: "x-1" }), VenueRejected);
	});

	it("호가 — quote 한 단 (키 헤더만, 서명 없음), 빈 본문이면 빈 호가", async () => {
		let empty = false;
		const { reqs, make } = venueWith(() => (empty ? new Response("", { status: 200 }) : json({ symbol: "AAPL", bidPrice: "332.4", askPrice: "332.62", bidSize: 120, askSize: 40 })));
		const v = await make();
		const b = await v.book();
		assert.deepEqual([b.bids, b.asks], [[{ price: 332.4, volume: 120 }], [{ price: 332.62, volume: 40 }]]);
		assert.equal(reqs[0]!.path, "/sapi/v1/equity/market/quote");
		assert.equal(reqs[0]!.query.signature, undefined);
		empty = true;
		const e = await v.book();
		assert.deepEqual([e.bids, e.asks], [[], []]);
	});

	it("접수 status F 는 거절, 4xx 거절, 결과 모름이면 clientOrderId 로 찾아본다", async () => {
		let mode: "F" | "400" | "502-found" | "502-none" = "F";
		const { reqs, make } = venueWith((r) => {
			if (r.path.endsWith("/order/place")) {
				if (mode === "F") return json({ status: "F" });
				if (mode === "400") return json({ code: -2010, msg: "disclaimer not signed" }, 400);
				return new Response("<html>502</html>", { status: 502 });
			}
			if (r.path.endsWith("/order/detail")) return mode === "502-found" ? json({ orderId: "u-9", status: "NEW", filledQty: "0" }) : json({ code: -2013, msg: "Order does not exist" }, 400);
			return json({});
		});
		const v = await make();
		const req = { side: "BUY" as const, quantity: 1, price: 330, ioc: false, clientId: "xq-0" };
		await assert.rejects(v.place(req), VenueRejected);
		mode = "400";
		await assert.rejects(v.place(req), (e: Error) => e instanceof VenueRejected && /disclaimer/.test(e.message));
		mode = "502-found";
		assert.deepEqual(await v.place(req), { orderId: "u-9" });
		const look = reqs.at(-1)!;
		assert.deepEqual([look.path, look.query.clientOrderId], ["/sapi/v1/equity/order/detail", equityClientId("xq-0")]);
		mode = "502-none";
		await assert.rejects(v.place(req), VenueUnknown);
		assert.equal(reqs.filter((r) => r.path.endsWith("/order/place")).length, 4, "주문마다 POST 는 한 번씩만");
	});

	it("상태 — filledQty·avgFilledPrice·열림, 취소는 orderId 로", async () => {
		assert.deepEqual(equityOrderState(parseEquityOrder({ orderId: "a", status: "PARTIALLY_FILLED", filledQty: "0.1", avgFilledPrice: "332.5" })), { filledQty: 0.1, avgPrice: 332.5, open: true });
		assert.deepEqual(equityOrderState(parseEquityOrder({ orderId: "a", status: "ACCEPTED", filledQty: "0" })), { filledQty: 0, avgPrice: null, open: true });
		assert.equal(equityOrderState(parseEquityOrder({ orderId: "a", status: "EXPIRED", filledQty: "0" })).open, false);
		assert.equal(equityOrderState(parseEquityOrder({ orderId: "a", status: "REJECTED" })).rejected, "Binance 가 주문을 거부했습니다");
		const { reqs, make } = venueWith((r) => (r.path.endsWith("/cancel") ? json({ orderId: "u1", status: "S" }) : json({ orderId: "u1", status: "CANCELED", filledQty: "0.2", avgFilledPrice: "331" })));
		const v = await make();
		await v.cancel("u1");
		assert.deepEqual([reqs[0]!.method, reqs[0]!.path, reqs[0]!.query.orderId], ["POST", "/sapi/v1/equity/order/cancel", "u1"]);
		assert.deepEqual(await v.status("u1"), { filledQty: 0.2, avgPrice: 331, open: false });
	});

	it("오류 구분", () => {
		assert.ok(classifyEquityError(new BinanceStockError("x", 0)) instanceof VenueUnknown);
		assert.ok(classifyEquityError(new BinanceStockError("x", 503)) instanceof VenueUnknown);
		assert.ok(classifyEquityError(new BinanceStockError("x", 400, -1007)) instanceof VenueUnknown);
		assert.ok(classifyEquityError(new BinanceStockError("x", 400, -2010)) instanceof VenueRejected);
	});

	it("체결기 — 지정가 + 잔량 취소, 소수점 수량", async () => {
		let t = 0;
		const orders = new Map<string, { qty: string; price: string }>();
		const { reqs, make } = venueWith((r) => {
			if (r.path.endsWith("/market/quote")) return json({ bidPrice: "332.40", askPrice: "332.50", bidSize: 10, askSize: 10 });
			if (r.path.endsWith("/order/place")) {
				const id = `u${orders.size}`;
				orders.set(id, { qty: r.query.quantity!, price: r.query.price! });
				return json({ status: "S", orderId: id });
			}
			if (r.path.endsWith("/order/detail")) {
				const o = orders.get(r.query.orderId!)!;
				return json({ orderId: r.query.orderId, status: "FILLED", filledQty: o.qty, avgFilledPrice: o.price });
			}
			return json({ status: "S" });
		});
		const v = await make();
		const rep = await execute({ side: "BUY", quantity: 0.297770896, worstPrice: 335.83, urgency: "immediate", deadlineMs: 30_000, nonce: "xabc" }, v, { now: () => t, sleep: async (ms) => void (t += ms) });
		assert.equal(rep.status, "filled");
		assert.equal(rep.filledQty, 0.297770896);
		const place = reqs.find((r) => r.path.endsWith("/order/place"))!;
		assert.deepEqual([place.query.price, place.query.quantity, place.query.tokenize], ["332.5", "0.297770896", "false"]);
	});
});

describe("확인 카드 실행 — binance-stock-place", () => {
	it("nonce 를 clientOrderId 로, tokenize=false, 시장가 매수는 notional", async () => {
		const reqs: Array<Record<string, string>> = [];
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			const u = new URL(String(input));
			reqs.push({ method: init?.method ?? "GET", path: u.pathname, ...Object.fromEntries(u.searchParams) });
			return json({ status: "S", orderId: "uuid-1", clientOrderId: "c" });
		}) as typeof fetch;
		const nonce = "af0123456789abcdef01234567";
		const r = await executeOrderAction(
			{ kind: "binance-stock-place", broker: "binance_stock", symbol: "NVDA", quote: "USDC", side: "BUY", type: "MARKET", notional: "100", estimatedQuote: "100" },
			nonce,
			{ binance: () => CREDS },
		);
		assert.equal(r.orderId, "uuid-1");
		assert.equal(reqs.length, 1);
		assert.deepEqual([reqs[0]!.method, reqs[0]!.path, reqs[0]!.notional, reqs[0]!.tokenize, reqs[0]!.clientOrderId], ["POST", "/sapi/v1/equity/order/place", "100", "false", equityClientId(nonce)]);
		assert.equal(reqs[0]!.tradingSession, undefined);
		await assert.rejects(
			executeOrderAction({ kind: "binance-stock-place", broker: "binance_stock", symbol: "NVDA", quote: "USDC", side: "BUY", type: "LIMIT", price: "0", quantity: "1", estimatedQuote: "0" }, nonce, { binance: () => CREDS }),
			/가격 값이 올바르지 않습니다/,
		);
		await assert.rejects(
			executeOrderAction({ kind: "binance-stock-place", broker: "binance_stock", symbol: "NVDA", quote: "USDC", side: "BUY", type: "MARKET", notional: "100", estimatedQuote: "100" }, nonce, { binance: () => ({ ...CREDS, testnet: true }) }),
			/테스트넷이 없습니다/,
		);
	});
});

describe("계좌 조회 (binance_stock_account)", () => {
	it("보유 — 전 종목 체결을 종목별로, 다 판 종목은 뺀다", async () => {
		const { holdingsFromFills } = await import("../src/binance/stocks.ts");
		const h = holdingsFromFills([
			{ symbol: "PANW", side: "BUY", qty: "0.2", price: "400", at: 1 },
			{ symbol: "PANW", side: "BUY", qty: "0.05", price: "420", at: 2 },
			{ symbol: "AAPL", side: "BUY", qty: "1", price: "200", at: 1 },
			{ symbol: "AAPL", side: "SELL", qty: "1", price: "210", at: 3 },
		]);
		assert.deepEqual(h.map((x) => x.symbol), ["PANW"]);
		assert.equal(h[0]!.qty, 0.25);
		assert.equal(h[0]!.avgPrice, 404);
		assert.equal(h[0]!.fills, 2);
	});

	it("괴리 — 중간가·사면·팔면·호가 폭, 호가나 본주가 없으면 null", async () => {
		const { premiumOf } = await import("../src/binance/stock-account-tool.ts");
		const p = premiumOf({ bid: 405.61, ask: 406.43 }, 406.7)!;
		assert.equal(p.binance, 406.02);
		assert.equal(p.pct, -0.17);
		assert.equal(p.askPct, -0.07);
		assert.equal(p.bidPct, -0.27);
		assert.equal(p.spreadPct, 0.2);
		assert.equal(premiumOf({ bid: 0, ask: 410 }, 400)!.pct, 2.5, "한쪽만 있으면 그 값");
		assert.equal(premiumOf(null, 400), null);
		assert.equal(premiumOf({ bid: 1, ask: 1 }, 0), null);
	});

	it("Funding — POST 서명 조회, 응답 파싱", async () => {
		const { fundingAssets } = await import("../src/binance/stocks.ts");
		const seen: Array<{ url: string; method?: string }> = [];
		const out = await fundingAssets(CREDS, {
			now: () => 1_700_000_000_000,
			fetch: async (url, init) => {
				seen.push({ url, method: init?.method });
				return new Response(JSON.stringify([{ asset: "USDC", free: "100.71", locked: "0", freeze: "0", withdrawing: "0", btcValuation: "0" }, { asset: "PANWB", free: "0.5" }]));
			},
		});
		assert.equal(seen[0]!.method, "POST");
		assert.match(seen[0]!.url, /\/sapi\/v1\/asset\/get-funding-asset\?timestamp=1700000000000&recvWindow=5000&signature=[0-9a-f]{64}$/);
		assert.deepEqual(out[0], { asset: "USDC", free: "100.71", locked: "0", freeze: "0", withdrawing: "0" });
		assert.equal(out[1]!.locked, "0", "빠진 필드는 0");
		await assert.rejects(
			fundingAssets(CREDS, { fetch: async () => new Response(JSON.stringify({ code: -2015, msg: "Invalid API-key" }), { status: 401 }) }),
			/Funding 지갑 조회 실패 \(HTTP 401 -2015\)/,
		);
	});

	it("전 종목 체결 조회는 symbol 을 보내지 않는다", async () => {
		const { equityFills } = await import("../src/binance/stocks.ts");
		const urls: string[] = [];
		const fills = await equityFills(CREDS, null, 1, {
			fetch: async (url) => {
				urls.push(url);
				return new Response(JSON.stringify({ total: 1, rows: [{ symbol: "PANW", side: "BUY", qty: "0.25", price: "404", executionAt: 5 }] }));
			},
		});
		assert.doesNotMatch(urls[0]!, /[?&]symbol=/);
		assert.equal(fills[0]!.symbol, "PANW");
	});
});

describe("수수료 (order/history fee)", () => {
	it("주문 파싱 — fee·createdAt, 없으면 null", () => {
		const o = parseEquityOrder({ orderId: "a", symbol: "PANW", fee: "0.02", createdAt: 1_759_400_000_000, filledQty: "0.25" });
		assert.equal(o.fee, "0.02");
		assert.equal(o.createdAt, 1_759_400_000_000);
		const bare = parseEquityOrder({ orderId: "b" });
		assert.equal(bare.fee, null);
		assert.equal(bare.createdAt, null);
	});

	it("종목별 합계 — 체결 없는 주문은 뺀다, 체결 금액 = filledQty × avgFilledPrice", async () => {
		const { feesFromOrders } = await import("../src/binance/stocks.ts");
		const f = feesFromOrders([
			parseEquityOrder({ orderId: "1", symbol: "PANW", side: "BUY", filledQty: "0.2", avgFilledPrice: "400", fee: "0.01" }),
			parseEquityOrder({ orderId: "2", symbol: "PANW", side: "SELL", filledQty: "0.1", avgFilledPrice: "420", fee: "0.02" }),
			parseEquityOrder({ orderId: "3", symbol: "PANW", side: "BUY", filledQty: "0", status: "CANCELED", fee: "0.5" }),
			parseEquityOrder({ orderId: "4", symbol: "AAPL", side: "BUY", filledQty: "1", avgFilledPrice: "200" }),
		]);
		assert.deepEqual(f, [
			{ symbol: "AAPL", fee: 0, filled: 200, orders: 1 },
			{ symbol: "PANW", fee: 0.03, filled: 122, orders: 2 },
		]);
	});

	it("내역 조회 — GET /order/history 서명, 전 종목이면 symbol 없음, 페이지를 넘긴다", async () => {
		const { equityOrderHistory } = await import("../src/binance/stocks.ts");
		const urls: string[] = [];
		const rows = Array.from({ length: 100 }, (_, i) => ({ orderId: `o${i}`, symbol: "PANW", filledQty: "1", fee: "0" }));
		const out = await equityOrderHistory(CREDS, null, 1, {
			fetch: async (url) => {
				urls.push(url);
				const page = Number(new URL(url).searchParams.get("current"));
				return new Response(JSON.stringify({ total: 101, rows: page === 1 ? rows : [{ orderId: "last", symbol: "PANW", fee: "0.01" }] }));
			},
		});
		assert.equal(urls.length, 2);
		assert.match(urls[0]!, /\/sapi\/v1\/equity\/order\/history\?startTime=1&endTime=\d+&current=1&size=100&timestamp=\d+&recvWindow=5000&signature=[0-9a-f]{64}$/);
		assert.equal(out.length, 101);
		assert.equal(out[100]!.fee, "0.01");
	});
});
