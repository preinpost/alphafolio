/**
 * Binance 현물 거래 (PLAN §36) — 돈이 움직이는 코드라 요청을 한 글자씩 검사한다.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { BinanceAction } from "../src/actions.ts";
import { cmpDec, floorToStep, isMultipleOf, mulDec, subDec } from "../src/binance/decimal.ts";
import { createBinanceOrderTool, validateBinance, type BinanceOrderCard } from "../src/binance/order-tool.ts";
import { executeBinance, ocoParams, otoParams, parseSymbolRules, placeParams, replaceParams, type SymbolRules } from "../src/binance/trade.ts";
import { binanceSign } from "../src/data/gateway.ts";
import { executeOrderAction } from "../src/execute.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("10진 계산 (부동소수점 없이)", () => {
	it("단위로 내림 — Number 로는 0.3 을 0.1 단위로 내리면 0.2 가 된다", () => {
		assert.equal(Math.floor(0.3 / 0.1) * 0.1 < 0.3, true, "대조군: 부동소수점 함정이 실제로 있다");
		assert.equal(floorToStep("0.3", "0.10000000"), "0.3");
		assert.equal(floorToStep("0.001234", "0.00001000"), "0.00123");
		assert.equal(floorToStep("83500.129", "0.01000000"), "83500.12");
		assert.equal(floorToStep("7", "1.00000000"), "7");
	});

	it("센트 단위 전수 — 이미 단위에 맞는 값은 그대로 (1~100,000 × 0.01)", () => {
		for (let c = 1; c <= 100_000; c++) {
			const v = (c / 100).toFixed(2);
			if (floorToStep(v, "0.01000000") !== String(Number(v))) assert.fail(`${v} → ${floorToStep(v, "0.01000000")}`);
		}
	});

	it("뺄셈·곱셈·비교가 정확하다", () => {
		assert.equal(subDec("0.30000000", "0.10000000"), "0.2");
		assert.equal(mulDec("0.00120", "83500.00"), "100.2");
		assert.equal(cmpDec("5", "4.99999999"), 1);
		assert.equal(cmpDec("0.10", "0.1"), 0);
		assert.equal(isMultipleOf("0.35", "0.1"), false);
	});
});

// 실제 exchangeInfo 모양 (BTCUSDT 요약)
const INFO = {
	symbols: [
		{
			symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT", isSpotTradingAllowed: true,
			orderTypes: ["LIMIT", "LIMIT_MAKER", "MARKET", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"],
			filters: [
				{ filterType: "PRICE_FILTER", minPrice: "0.01000000", maxPrice: "1000000.00000000", tickSize: "0.01000000" },
				{ filterType: "LOT_SIZE", minQty: "0.00001000", maxQty: "9000.00000000", stepSize: "0.00001000" },
				{ filterType: "MARKET_LOT_SIZE", minQty: "0.00000000", maxQty: "120.00000000", stepSize: "0.00000000" },
				{ filterType: "NOTIONAL", minNotional: "5.00000000", applyMinToMarket: true, maxNotional: "9000000.00000000" },
			],
		},
	],
};
const RULES = parseSymbolRules(INFO) as SymbolRules;
const LAST = "84000.00";
const FREE = { USDT: "412.33", BTC: "0.01" };

describe("거래소 규칙 검증", () => {
	it("규칙을 읽는다 (MARKET_LOT_SIZE 단위 0 이면 그대로)", () => {
		assert.equal(RULES.tickSize, "0.01000000");
		assert.equal(RULES.stepSize, "0.00001000");
		assert.equal(RULES.minNotional, "5.00000000");
		assert.equal(RULES.base, "BTC");
	});

	it("지정가 매수 — 가격·수량을 단위로 내리고 알린다, 주문금액 계산", () => {
		const v = validateBinance({ action: "place", side: "BUY", type: "LIMIT", price: "83500.129", quantity: "0.001234" }, RULES, LAST, FREE);
		assert.deepEqual(v.errors, []);
		assert.equal(v.price, "83500.12");
		assert.equal(v.quantity, "0.00123");
		assert.equal(v.notional, mulDec("83500.12", "0.00123"));
		assert.equal(v.warnings.filter((w) => w.includes("내림")).length, 2);
	});

	it("최소 주문금액 미만은 거절", () => {
		const v = validateBinance({ action: "place", side: "BUY", type: "LIMIT", price: "84000", quantity: "0.00005" }, RULES, LAST, FREE);
		assert.ok(v.errors.some((e) => e.includes("최소 주문금액")), v.errors.join(" / "));
	});

	it("현재가와 50% 넘게 벌어진 가격은 자릿수 오타로 거절", () => {
		const v = validateBinance({ action: "place", side: "BUY", type: "LIMIT", price: "8400", quantity: "0.001" }, RULES, LAST, FREE);
		assert.ok(v.errors.some((e) => e.includes("자릿수")));
	});

	it("잔고 부족 — 매수는 USDT, 매도는 BTC", () => {
		assert.ok(validateBinance({ action: "place", side: "BUY", type: "LIMIT", price: "84000", quantity: "0.01" }, RULES, LAST, FREE).errors.some((e) => e.includes("USDT 잔고 부족")));
		assert.ok(validateBinance({ action: "place", side: "SELL", type: "LIMIT", price: "84000", quantity: "0.02" }, RULES, LAST, FREE).errors.some((e) => e.includes("BTC 잔고 부족")));
	});

	it("금액(quoteQuantity) 주문은 시장가 매수만", () => {
		assert.deepEqual(validateBinance({ action: "place", side: "BUY", type: "MARKET", quoteQuantity: "100" }, RULES, LAST, FREE).errors, []);
		assert.ok(validateBinance({ action: "place", side: "SELL", type: "MARKET", quoteQuantity: "100" }, RULES, LAST, FREE).errors.some((e) => e.includes("시장가 매수만")));
	});

	it("OCO — 익절가 > 현재가 > 손절 스톱가, 매도 수량만큼 BTC", () => {
		assert.deepEqual(validateBinance({ action: "oco", quantity: "0.005", takeProfitPrice: "90000", stopPrice: "80000", stopLimitPrice: "79900" }, RULES, LAST, FREE).errors, []);
		assert.ok(validateBinance({ action: "oco", quantity: "0.005", takeProfitPrice: "80000", stopPrice: "90000" }, RULES, LAST, FREE).errors.some((e) => e.includes("익절가")));
	});

	it("OTO — 매도가는 매수가보다 높아야", () => {
		assert.ok(validateBinance({ action: "oto", quantity: "0.001", buyPrice: "83000", sellPrice: "82000" }, RULES, LAST, FREE).errors.some((e) => e.includes("매도가")));
	});

	it("거래 중이 아닌 종목은 거절", () => {
		const halted = { ...RULES, status: "BREAK" };
		assert.ok(validateBinance({ action: "place", side: "BUY", type: "MARKET", quoteQuantity: "10" }, halted, LAST, FREE).errors.some((e) => e.includes("거래할 수 없습니다")));
	});
});

describe("요청 파라미터", () => {
	const NONCE = "af0123456789abcdef012345";
	const b = { broker: "binance" as const, symbol: "BTCUSDT", base: "BTC", quote: "USDT" };

	it("지정가: GTC·수량·가격·newClientOrderId(nonce)", () => {
		assert.deepEqual(placeParams({ kind: "binance-place", ...b, side: "BUY", type: "LIMIT", quantity: "0.00123", price: "83500.12", estimatedQuote: "1" }, NONCE), {
			symbol: "BTCUSDT", side: "BUY", type: "LIMIT", newClientOrderId: NONCE, newOrderRespType: "RESULT", timeInForce: "GTC", quantity: "0.00123", price: "83500.12",
		});
	});

	it("시장가 금액 매수: quoteOrderQty 만 (수량을 같이 보내지 않는다)", () => {
		const p = placeParams({ kind: "binance-place", ...b, side: "BUY", type: "MARKET", quoteOrderQty: "100", estimatedQuote: "100" }, NONCE);
		assert.equal(p.quoteOrderQty, "100");
		assert.equal("quantity" in p, false);
		assert.equal("price" in p, false);
	});

	it("OCO: 위 LIMIT_MAKER(익절) · 아래 STOP_LOSS_LIMIT(손절) · listClientOrderId", () => {
		assert.deepEqual(ocoParams({ kind: "binance-oco", ...b, quantity: "0.005", takeProfitPrice: "90000", stopPrice: "80000", stopLimitPrice: "79900" }, NONCE), {
			symbol: "BTCUSDT", side: "SELL", quantity: "0.005", listClientOrderId: NONCE,
			aboveType: "LIMIT_MAKER", abovePrice: "90000", belowType: "STOP_LOSS_LIMIT", belowStopPrice: "80000", belowPrice: "79900", belowTimeInForce: "GTC",
		});
	});

	it("OTO: 지정가 매수 → 지정가 매도, 같은 수량", () => {
		const p = otoParams({ kind: "binance-oto", ...b, quantity: "0.001", buyPrice: "83000", sellPrice: "86000" }, NONCE);
		assert.equal(p.workingSide, "BUY");
		assert.equal(p.pendingSide, "SELL");
		assert.equal(p.workingQuantity, p.pendingQuantity);
	});

	it("재주문: 취소 실패 시 새 주문을 내지 않는다 (STOP_ON_FAILURE)", () => {
		const p = replaceParams({ kind: "binance-replace", ...b, original: { orderId: 7, side: "BUY", type: "LIMIT", price: "80000", origQty: "0.001", executedQty: "0" }, quantity: "0.001", price: "79000" }, NONCE);
		assert.equal(p.cancelReplaceMode, "STOP_ON_FAILURE");
		assert.equal(p.cancelOrderId, "7");
		assert.equal(p.side, "BUY");
	});
});

// ── 실행 ────────────────────────────────────────────────────

interface Req {
	url: URL;
	method: string;
	headers: Record<string, string>;
}
function fakeBinance(reply: (r: Req, n: number) => Response): Req[] {
	const reqs: Req[] = [];
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const r = { url: new URL(String(input)), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> };
		reqs.push(r);
		return reply(r, reqs.length);
	}) as typeof fetch;
	return reqs;
}
const CREDS = { key: "BINKEY000111", secret: "BINSECRET222333" };
const place: BinanceAction = { kind: "binance-place", broker: "binance", symbol: "BTCUSDT", base: "BTC", quote: "USDT", side: "BUY", type: "LIMIT", quantity: "0.001", price: "83000", estimatedQuote: "83" };

describe("실행", () => {
	it("서명 POST — 키 헤더, 서명은 마지막, 비밀키는 URL 에 없다", async () => {
		const reqs = fakeBinance(() => new Response(JSON.stringify({ orderId: 42, status: "NEW" })));
		const r = await executeBinance(place, "afNONCE", CREDS);
		assert.equal(reqs.length, 1);
		assert.equal(reqs[0]!.method, "POST");
		assert.equal(reqs[0]!.url.pathname, "/api/v3/order");
		assert.equal(reqs[0]!.headers["X-MBX-APIKEY"], "BINKEY000111");
		const qs = reqs[0]!.url.search.slice(1);
		const [body, sig] = qs.split("&signature=");
		assert.equal(sig, binanceSign(body!, "BINSECRET222333"));
		assert.equal(reqs[0]!.url.searchParams.get("newClientOrderId"), "afNONCE");
		assert.doesNotMatch(reqs[0]!.url.href, /BINSECRET/);
		assert.equal(r.orderId, "42");
	});

	it("서버 오류에 재시도하지 않는다 (재시도 = 중복 주문)", async () => {
		const reqs = fakeBinance(() => new Response("bad gateway", { status: 502 }));
		await assert.rejects(executeBinance(place, "afNONCE", CREDS));
		assert.equal(reqs.length, 1);
	});

	it("거절 코드(음수)는 메시지와 함께, 키는 지운다", async () => {
		fakeBinance(() => new Response(JSON.stringify({ code: -2010, msg: "Account has insufficient balance. key=BINKEY000111" }), { status: 400 }));
		await assert.rejects(executeBinance(place, "afNONCE", CREDS), (e: Error) => /insufficient/.test(e.message) && !e.message.includes("BINKEY000111"));
	});

	it("각 동작의 메서드·경로", async () => {
		const cases: Array<[BinanceAction, string, string]> = [
			[{ kind: "binance-cancel", broker: "binance", symbol: "BTCUSDT", base: "BTC", quote: "USDT", original: { orderId: 7, side: "BUY", type: "LIMIT", price: "1", origQty: "1", executedQty: "0" } }, "DELETE", "/api/v3/order"],
			[{ kind: "binance-cancel-all", broker: "binance", symbol: "BTCUSDT", base: "BTC", quote: "USDT", count: 2 }, "DELETE", "/api/v3/openOrders"],
			[{ kind: "binance-oco", broker: "binance", symbol: "BTCUSDT", base: "BTC", quote: "USDT", quantity: "0.001", takeProfitPrice: "90000", stopPrice: "80000", stopLimitPrice: "79900" }, "POST", "/api/v3/orderList/oco"],
			[{ kind: "binance-oto", broker: "binance", symbol: "BTCUSDT", base: "BTC", quote: "USDT", quantity: "0.001", buyPrice: "83000", sellPrice: "86000" }, "POST", "/api/v3/orderList/oto"],
		];
		for (const [a, method, path] of cases) {
			const reqs = fakeBinance(() => new Response(JSON.stringify(a.kind === "binance-cancel-all" ? [{}, {}] : { orderListId: 1 })));
			await executeBinance(a, "afNONCE", CREDS);
			assert.equal(reqs[0]!.method, method, a.kind);
			assert.equal(reqs[0]!.url.pathname, path, a.kind);
		}
	});

	it("실행기 분기 — Binance 동작은 Binance 로만, 키가 없으면 멈춘다", async () => {
		const reqs = fakeBinance(() => new Response(JSON.stringify({ orderId: 1 })));
		await executeOrderAction(place, "afNONCE", { binance: () => CREDS });
		assert.ok(reqs.every((r) => r.url.host.includes("binance")));
		await assert.rejects(executeOrderAction(place, "afNONCE", {}), /Binance 연결이 없습니다/);
	});
});

describe("binance_order — 재주문의 원주문은 조회값, 남은 수량은 10진 계산", () => {
	it("원 0.3 · 체결 0.1 → 남은 0.2 (Number 로 빼면 0.19999… → 한 단위 깎임)", async () => {
		const info = JSON.parse(JSON.stringify(INFO));
		info.symbols[0].filters[1].stepSize = "0.00010000";
		globalThis.fetch = (async (input: string | URL) => {
			const u = new URL(String(input));
			const json = (b: unknown) => new Response(JSON.stringify(b));
			if (u.pathname === "/api/v3/exchangeInfo") return json(info);
			if (u.pathname === "/api/v3/ticker/price") return json({ price: LAST });
			if (u.pathname === "/api/v3/openOrders") return json([{ symbol: "BTCUSDT", orderId: 7, side: "BUY", type: "LIMIT", price: "80000.00", origQty: "0.30000000", executedQty: "0.10000000" }]);
			return json({});
		}) as typeof fetch;
		const prepared: BinanceAction[] = [];
		const tool = createBinanceOrderTool({ brokers: { binance: () => ({ ...CREDS, key: `k${Math.random()}` }) }, prepareOrder: (a) => (prepared.push(a as BinanceAction), { token: "t", expiresAt: 1 }) });
		const r = (await tool.execute("id", { action: "replace", symbol: "BTC/USDT", orderId: 7, price: "79000" } as never, undefined, undefined, undefined as never)) as { details: BinanceOrderCard };
		assert.equal(r.details.ok, true, r.details.errors.join(" / "));
		const a = prepared[0]!;
		assert.equal(a.kind, "binance-replace");
		assert.equal(a.kind === "binance-replace" && a.quantity, "0.2");
		assert.equal(a.kind === "binance-replace" && a.original.price, "80000.00");
	});

	it("목록에 없는 주문은 준비하지 않는다", async () => {
		globalThis.fetch = (async (input: string | URL) => {
			const u = new URL(String(input));
			const json = (b: unknown) => new Response(JSON.stringify(b));
			if (u.pathname === "/api/v3/exchangeInfo") return json(INFO);
			if (u.pathname === "/api/v3/ticker/price") return json({ price: LAST });
			if (u.pathname === "/api/v3/openOrders") return json([]);
			return json({});
		}) as typeof fetch;
		const prepared: unknown[] = [];
		const tool = createBinanceOrderTool({ brokers: { binance: () => ({ ...CREDS, key: `k${Math.random()}` }) }, prepareOrder: (a) => (prepared.push(a), { token: "t", expiresAt: 1 }) });
		const r = (await tool.execute("id", { action: "cancel", symbol: "BTCUSDT", orderId: 99 } as never, undefined, undefined, undefined as never)) as { details: BinanceOrderCard };
		assert.equal(r.details.ok, false);
		assert.equal(prepared.length, 0);
		assert.ok(r.details.errors.some((e) => e.includes("미체결 목록에 없는")));
	});
});
