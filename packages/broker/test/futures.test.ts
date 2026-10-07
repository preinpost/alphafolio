/**
 * Binance USDⓈ-M 선물 — 돈이 움직이는 코드라 요청 파라미터·검증을 한 글자씩 검사한다.
 * 준비(binance_futures)는 토큰만 만들고, 실제 요청은 executeOrderAction 에서만 나간다.
 * 규칙 값은 실측(2026-10-07) BTCUSDT exchangeInfo·leverageBracket 그대로.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { BinanceFuturesAction, BinanceFuturesCloseAction, BinanceFuturesOpenAction, OrderAction } from "../src/actions.ts";
import { createBinanceFuturesTool } from "../src/binance/futures-tool.ts";
import type { BinanceFuturesCard } from "../src/binance/futures-card.ts";
import { executeOrderAction } from "../src/execute.ts";
import { divToStep } from "../src/binance/decimal.ts";
import {
	bracketFor,
	cancelRequest,
	clearFuturesCache,
	closeOrderParams,
	isolatedLiqPrice,
	maxNotionalAt,
	openOrderParams,
	parseFuturesSymbol,
	settingsRequests,
	tpslParams,
	type Bracket,
	type FuturesPosition,
} from "../src/binance/futures.ts";
import { validateClose, validateOpen, validateTpsl, type OpenContext } from "../src/binance/futures-validate.ts";
import { transferRoute } from "../src/binance/wallet.ts";

export const BTC_INFO = {
	symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL", baseAsset: "BTC", quoteAsset: "USDT", marginAsset: "USDT",
	orderTypes: ["LIMIT", "MARKET", "STOP", "STOP_MARKET", "TAKE_PROFIT", "TAKE_PROFIT_MARKET", "TRAILING_STOP_MARKET"],
	filters: [
		{ tickSize: "0.10", filterType: "PRICE_FILTER", minPrice: "556.80", maxPrice: "4529764" },
		{ minQty: "0.001", maxQty: "1000", filterType: "LOT_SIZE", stepSize: "0.001" },
		{ minQty: "0.001", stepSize: "0.001", maxQty: "120", filterType: "MARKET_LOT_SIZE" },
		{ filterType: "MIN_NOTIONAL", notional: "50" },
		{ filterType: "PERCENT_PRICE", multiplierDecimal: "4", multiplierDown: "0.9500", multiplierUp: "1.0500" },
	],
};
export const BRACKETS: Bracket[] = [
	{ initialLeverage: 150, notionalFloor: 0, notionalCap: 300000, maintMarginRatio: 0.004, cum: 0 },
	{ initialLeverage: 100, notionalFloor: 300000, notionalCap: 800000, maintMarginRatio: 0.005, cum: 300 },
	{ initialLeverage: 75, notionalFloor: 800000, notionalCap: 3000000, maintMarginRatio: 0.0065, cum: 1500 },
];
const RULES = parseFuturesSymbol(BTC_INFO);
const MARK = "83785.7";
const base = { broker: "binance", symbol: "BTCUSDT", base: "BTC", marginAsset: "USDT" } as const;

const ctx = (over: Partial<OpenContext> = {}): OpenContext => ({
	rules: RULES, mark: MARK, available: "500", brackets: BRACKETS, current: { leverage: 1, marginType: "CROSSED" }, hasPosition: false, hasOpenOrders: false, ...over,
});
const long = (over: Partial<FuturesPosition> = {}): FuturesPosition => ({
	symbol: "BTCUSDT", positionSide: "BOTH", amt: "0.002", entryPrice: "83000", breakEvenPrice: "83040", markPrice: MARK, unrealized: "1.57",
	liquidationPrice: "66500", notional: "167.57", isolatedMargin: "33.2", marginAsset: "USDT", ...over,
});

describe("거래소 규칙·구간 (순수)", () => {
	it("exchangeInfo 한 종목 → 규칙", () => {
		assert.equal(RULES.tickSize, "0.10");
		assert.equal(RULES.stepSize, "0.001");
		assert.equal(RULES.marketMaxQty, "120");
		assert.equal(RULES.minNotional, "50");
		assert.equal(RULES.multiplierUp, "1.0500");
		assert.equal(RULES.marginAsset, "USDT");
	});

	it("금액 ÷ 가격 → 단위로 내림 (부동소수점 없이)", () => {
		assert.equal(divToStep("100", "83785.7", "0.001"), "0.001");
		assert.equal(divToStep("0.3", "0.1", "1"), "3", "0.3 / 0.1 = 2.999… 로 깎이지 않는다");
		assert.equal(divToStep("1000", "83785.7", "0.001"), "0.011");
		assert.throws(() => divToStep("1", "0", "0.001"));
	});

	it("레버리지 구간 — 크기별 구간, 레버리지별 최대 크기", () => {
		assert.equal(bracketFor(BRACKETS, 100)?.initialLeverage, 150);
		assert.equal(bracketFor(BRACKETS, 500000)?.initialLeverage, 100);
		assert.equal(maxNotionalAt(BRACKETS, 125), 300000);
		assert.equal(maxNotionalAt(BRACKETS, 50), 3000000);
		assert.equal(maxNotionalAt(BRACKETS, 200), 0);
	});

	it("격리 예상 청산가 — 롱은 아래, 숏은 위", () => {
		const b = BRACKETS[0]!;
		const l = isolatedLiqPrice(true, 80000, 0.01, 10, b)!;
		const s = isolatedLiqPrice(false, 80000, 0.01, 10, b)!;
		assert.ok(Math.abs(l - 72289.16) < 0.1, String(l));
		assert.ok(Math.abs(s - 87649.4) < 0.1, String(s));
		assert.equal(isolatedLiqPrice(true, 80000, 0, 10, b), null);
	});
});

describe("요청 파라미터 (순수)", () => {
	const open: BinanceFuturesOpenAction = {
		kind: "binance-futures-open", ...base, side: "BUY", positionSide: "BOTH", type: "LIMIT", quantity: "0.002", price: "80000",
		leverage: 5, marginType: "ISOLATED", current: { leverage: 1, marginType: "CROSSED" }, estimatedNotional: "160", stopLossPrice: "76000",
	};

	it("진입 지정가 — GTC · nonce 가 newClientOrderId", () => {
		assert.deepEqual(openOrderParams(open, "afNONCE"), {
			symbol: "BTCUSDT", side: "BUY", positionSide: "BOTH", type: "LIMIT", quantity: "0.002", newClientOrderId: "afNONCE", newOrderRespType: "RESULT", price: "80000", timeInForce: "GTC",
		});
		assert.equal(openOrderParams({ ...open, type: "MARKET", price: undefined }, "n").timeInForce, undefined);
	});

	it("청산 — 단방향은 reduceOnly, 양방향은 보내지 않는다 (보내면 거절)", () => {
		const close: BinanceFuturesCloseAction = { kind: "binance-futures-close", ...base, side: "SELL", positionSide: "BOTH", type: "MARKET", quantity: "0.002", positionAmt: "0.002" };
		assert.equal(closeOrderParams(close, "n").reduceOnly, "true");
		assert.equal(closeOrderParams({ ...close, positionSide: "LONG" }, "n").reduceOnly, undefined);
	});

	it("익절·손절 — Algo 조건부, 포지션 전체, 표시가격 기준, ID 는 nonce+tp/sl (36자 안)", () => {
		const nonce = `af${"0".repeat(24)}`;
		const sl = tpslParams({ symbol: "BTCUSDT", side: "SELL", positionSide: "BOTH" }, "sl", "76000", nonce);
		assert.deepEqual(sl, {
			algoType: "CONDITIONAL", symbol: "BTCUSDT", side: "SELL", positionSide: "BOTH", type: "STOP_MARKET", triggerPrice: "76000",
			closePosition: "true", workingType: "MARK_PRICE", priceProtect: "true", clientAlgoId: `${nonce}sl`,
		});
		assert.equal(tpslParams({ symbol: "BTCUSDT", side: "SELL", positionSide: "BOTH" }, "tp", "90000", nonce).type, "TAKE_PROFIT_MARKET");
		assert.ok(sl.clientAlgoId!.length <= 36);
	});

	it("취소 — 일반은 /order, 조건부는 /algoOrder", () => {
		const o = { source: "order", id: 7, side: "BUY", type: "LIMIT", price: "80000", quantity: "0.002" } as const;
		assert.deepEqual(cancelRequest({ kind: "binance-futures-cancel", ...base, original: o }), { path: "/fapi/v1/order", params: { symbol: "BTCUSDT", orderId: "7" } });
		assert.deepEqual(cancelRequest({ kind: "binance-futures-cancel", ...base, original: { ...o, source: "algo", id: 9 } }), { path: "/fapi/v1/algoOrder", params: { algoId: "9" } });
	});

	it("설정 — 다른 것만, 증거금 방식 먼저. 진입 직전에는 레버리지를 늘 보낸다", () => {
		const cur = { leverage: 5, marginType: "CROSSED" } as const;
		assert.deepEqual(settingsRequests({ symbol: "BTCUSDT", leverage: 5, marginType: "CROSSED", current: cur }), []);
		assert.deepEqual(settingsRequests({ symbol: "BTCUSDT", leverage: 10, marginType: "ISOLATED", current: cur }).map((r) => r.path), ["/fapi/v1/marginType", "/fapi/v1/leverage"]);
		assert.deepEqual(settingsRequests({ symbol: "BTCUSDT", leverage: 5, current: cur }, true).map((r) => r.path), ["/fapi/v1/leverage"]);
	});
});

describe("진입 검증 (순수)", () => {
	it("증거금 20 USDT × 5x 격리 → 수량 내림·크기·증거금·예상 청산가", () => {
		const v = validateOpen({ side: "BUY", type: "MARKET", margin: "20", leverage: 5, marginType: "ISOLATED", stopLossPrice: "70000" }, ctx());
		assert.deepEqual(v.errors, []);
		assert.equal(v.quantity, "0.001");
		assert.equal(v.notional, "83.7857");
		assert.equal(v.margin, "16.76");
		assert.ok(Math.abs(Number(v.liqPrice) - 67297.75) < 0.1, String(v.liqPrice));
	});

	it("최소 주문금액 50 미만·증거금 부족·최대 레버리지 초과는 거절", () => {
		assert.ok(validateOpen({ side: "BUY", type: "MARKET", quantity: "0.001", leverage: 5, marginType: "CROSSED" }, ctx({ rules: { ...RULES, minNotional: "100" } })).errors.some((e) => e.includes("최소 주문금액")));
		// BTC 는 최소 수량(0.001 ≈ 84 USDT)이 최소 주문금액보다 크다 — 금액으로 말하면 금액으로 안내
		const small = validateOpen({ side: "BUY", type: "MARKET", margin: "10", leverage: 5, marginType: "CROSSED" }, ctx());
		assert.ok(small.errors.some((e) => e.includes("증거금 10 × 5x") && e.includes("크기 약 83.79")), small.errors.join(" / "));
		assert.ok(!small.errors.some((e) => e.includes("수량 0 ")));
		assert.ok(validateOpen({ side: "BUY", type: "MARKET", quantity: "0.1", leverage: 5, marginType: "CROSSED" }, ctx()).errors.some((e) => e.includes("증거금 부족")));
		assert.ok(validateOpen({ side: "BUY", type: "MARKET", quantity: "0.001", leverage: 200, marginType: "CROSSED" }, ctx()).errors.some((e) => e.includes("최대 레버리지는 150x")));
	});

	it("지정가 허용 범위(표시가격 ±5%) 밖·가격 단위 내림", () => {
		const far = validateOpen({ side: "BUY", type: "LIMIT", quantity: "0.001", price: "70000", leverage: 5, marginType: "CROSSED" }, ctx());
		assert.ok(far.errors.some((e) => e.includes("허용 범위")), far.errors.join(" / "));
		const tick = validateOpen({ side: "BUY", type: "LIMIT", quantity: "0.001", price: "83000.17", leverage: 5, marginType: "CROSSED" }, ctx());
		assert.equal(tick.price, "83000.1");
		assert.ok(tick.warnings.some((w) => w.includes("가격 단위")));
	});

	it("익절·손절 방향 — 롱은 손절이 아래, 숏은 위. 청산가 너머 손절은 거절", () => {
		assert.ok(validateOpen({ side: "BUY", type: "MARKET", quantity: "0.001", leverage: 5, marginType: "CROSSED", stopLossPrice: "90000" }, ctx()).errors.some((e) => e.includes("손절가")));
		assert.ok(validateOpen({ side: "SELL", type: "MARKET", quantity: "0.001", leverage: 5, marginType: "CROSSED", stopLossPrice: "80000" }, ctx()).errors.some((e) => e.includes("손절가")));
		const liq = validateOpen({ side: "BUY", type: "MARKET", quantity: "0.001", leverage: 20, marginType: "ISOLATED", stopLossPrice: "78000" }, ctx());
		assert.ok(liq.errors.some((e) => /청산가 [\d.]+ 너머/.test(e)), liq.errors.join(" / "));
	});

	it("포지션·미체결이 있으면 증거금 방식을 바꾸지 않는다", () => {
		const v = validateOpen({ side: "BUY", type: "MARKET", quantity: "0.001", leverage: 5, marginType: "ISOLATED" }, ctx({ hasPosition: true }));
		assert.ok(v.errors.some((e) => e.includes("증거금 방식")));
	});

	it("크기는 하나만 · 손절 없음·고레버리지는 경고", () => {
		assert.ok(validateOpen({ side: "BUY", type: "MARKET", quantity: "0.001", margin: "20", leverage: 5, marginType: "CROSSED" }, ctx()).errors.some((e) => e.includes("하나만")));
		const w = validateOpen({ side: "BUY", type: "MARKET", quantity: "0.001", leverage: 25, marginType: "CROSSED" }, ctx()).warnings;
		assert.ok(w.some((x) => x.includes("손절가가 없습니다")));
		assert.ok(w.some((x) => x.includes("25x")));
	});
});

describe("청산·익절손절 검증 (순수)", () => {
	it("전량 기본 · 롱 청산은 SELL · 포지션보다 많으면 거절", () => {
		const v = validateClose({ type: "MARKET" }, RULES, MARK, long());
		assert.equal(v.side, "SELL");
		assert.equal(v.quantity, "0.002");
		assert.ok(validateClose({ type: "MARKET", quantity: "0.003" }, RULES, MARK, long()).errors.some((e) => e.includes("포지션")));
		assert.equal(validateClose({ type: "MARKET" }, RULES, MARK, long({ amt: "-0.002" })).side, "BUY");
	});

	it("열린 롱에 익절·손절 — 표시가격 기준 방향, 청산가 너머 손절 거절", () => {
		assert.deepEqual(validateTpsl({ stopLossPrice: "80000", takeProfitPrice: "90000" }, RULES, MARK, long()).errors, []);
		assert.ok(validateTpsl({ stopLossPrice: "85000" }, RULES, MARK, long()).errors.some((e) => e.includes("손절가")));
		assert.ok(validateTpsl({ stopLossPrice: "66000" }, RULES, MARK, long()).errors.some((e) => e.includes("청산가 66500 너머")));
		assert.ok(validateTpsl({}, RULES, MARK, long()).errors.length > 0);
	});
});

describe("지갑 경로 — 선물", () => {
	it("현물·펀딩 ↔ 선물은 Universal Transfer, Earn ↔ 선물은 없다", () => {
		assert.deepEqual(transferRoute("SPOT", "FUTURES"), { kind: "universal", type: "MAIN_UMFUTURE" });
		assert.deepEqual(transferRoute("FUTURES", "SPOT"), { kind: "universal", type: "UMFUTURE_MAIN" });
		assert.deepEqual(transferRoute("FUNDING", "FUTURES"), { kind: "universal", type: "FUNDING_UMFUTURE" });
		assert.deepEqual(transferRoute("FUTURES", "FUNDING"), { kind: "universal", type: "UMFUTURE_FUNDING" });
		assert.equal(transferRoute("EARN", "FUTURES"), null);
		assert.equal(transferRoute("FUTURES", "EARN"), null);
	});
});

// ── 도구·실행 (가짜 fapi) ───────────────────────────────────

const CREDS = { key: "BINKEY000111", secret: "BINSECRET222333" };
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	clearFuturesCache();
});

interface FakeOpts {
	hedge?: boolean;
	positions?: Array<Record<string, string>>;
	algo?: Array<Record<string, unknown>>;
	/** 이 경로의 POST·DELETE 는 실패 */
	fail?: Record<string, { code: number; msg: string }>;
}

function fakeFapi(opts: FakeOpts = {}) {
	const calls: Array<{ method: string; path: string; q: URLSearchParams }> = [];
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const u = new URL(String(input));
		const method = init?.method ?? "GET";
		calls.push({ method, path: u.pathname, q: u.searchParams });
		const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
		const f = opts.fail?.[u.pathname];
		if (f && method !== "GET") return json(f, 400);
		switch (`${method} ${u.pathname}`) {
			case "GET /fapi/v1/exchangeInfo":
				return json({ symbols: [BTC_INFO] });
			case "GET /fapi/v1/premiumIndex":
				return json({ symbol: "BTCUSDT", markPrice: MARK, lastFundingRate: "0.0001", nextFundingTime: 1 });
			case "GET /fapi/v1/symbolConfig":
				return json([{ symbol: "BTCUSDT", marginType: "CROSSED", leverage: 1 }]);
			case "GET /fapi/v1/positionSide/dual":
				return json({ dualSidePosition: opts.hedge === true });
			case "GET /fapi/v1/multiAssetsMargin":
				return json({ multiAssetsMargin: false });
			case "GET /fapi/v1/leverageBracket":
				return json([{ symbol: "BTCUSDT", brackets: BRACKETS.map((b, i) => ({ bracket: i + 1, ...b })) }]);
			case "GET /fapi/v3/positionRisk":
				return json(opts.positions ?? []);
			case "GET /fapi/v1/openOrders":
				return json([]);
			case "GET /fapi/v1/openAlgoOrders":
				return json(opts.algo ?? []);
			case "GET /fapi/v3/account":
				return json({ totalWalletBalance: "500", totalUnrealizedProfit: "0", totalMarginBalance: "500", availableBalance: "500", totalInitialMargin: "0", totalMaintMargin: "0",
					assets: [{ asset: "USDT", walletBalance: "500", unrealizedProfit: "0", marginBalance: "500", availableBalance: "500", maxWithdrawAmount: "500" }] });
			case "POST /fapi/v1/marginType":
				return json({ code: 200, msg: "success" });
			case "POST /fapi/v1/leverage":
				return json({ symbol: "BTCUSDT", leverage: Number(u.searchParams.get("leverage")) });
			case "POST /fapi/v1/order":
				return json({ orderId: 11, status: "FILLED", executedQty: u.searchParams.get("quantity"), avgPrice: "83790" });
			case "POST /fapi/v1/algoOrder":
				return json({ algoId: u.searchParams.get("type") === "STOP_MARKET" ? 21 : 22 });
			case "DELETE /fapi/v1/algoOrder":
			case "DELETE /fapi/v1/allOpenOrders":
			case "DELETE /fapi/v1/algoOpenOrders":
				return json({ code: 200, msg: "success" });
		}
		return json({ code: -1, msg: `없는 경로 ${method} ${u.pathname}` }, 404);
	}) as typeof fetch;
	const prepared: OrderAction[] = [];
	const tool = createBinanceFuturesTool({ brokers: { binance: () => CREDS }, prepareOrder: (a) => (prepared.push(a), { token: "tok", expiresAt: 1 }) });
	const run = (p: Record<string, unknown>) =>
		tool.execute("id", p as never, undefined, undefined, undefined as never) as Promise<{ content: Array<{ text: string }>; details: BinanceFuturesCard }>;
	const writes = () => calls.filter((c) => c.method !== "GET");
	return { calls, prepared, run, writes };
}

const LONG_POS = { symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "0.002", entryPrice: "83000", breakEvenPrice: "83040", markPrice: MARK, unRealizedProfit: "1.57", liquidationPrice: "66500", notional: "167.57", isolatedMargin: "0", marginAsset: "USDT" };

describe("binance_futures — 조회", () => {
	it("account — 잔고·포지션·조건부 미체결(algoId)", async () => {
		const { run, writes } = fakeFapi({ positions: [LONG_POS], algo: [{ algoId: 21, symbol: "BTCUSDT", side: "SELL", orderType: "STOP_MARKET", triggerPrice: "76000", price: "0", quantity: "0", closePosition: true, positionSide: "BOTH" }] });
		const r = await run({ action: "account" });
		const text = r.content[0]!.text;
		assert.match(text, /주문 가능 500/);
		assert.match(text, /BTCUSDT 롱 0\.002 · 진입 83,000/);
		assert.match(text, /STOP_MARKET 포지션 전체 시장가 · 트리거 76000 · algoId=21/);
		assert.match(text, /단방향\(One-way\)/);
		assert.equal(writes().length, 0);
	});
});

describe("binance_futures — 준비 (토큰만, 쓰기 요청은 안 나간다)", () => {
	it("롱 진입 — 증거금 20 × 5x 격리 + 손절·익절. 지금 설정(1x 교차)은 서버가 읽은 값", async () => {
		const { run, prepared, writes } = fakeFapi();
		const r = await run({ action: "open", symbol: "btc/usdt", side: "BUY", type: "MARKET", margin: "20", leverage: 5, marginType: "ISOLATED", stopLossPrice: "75000", takeProfitPrice: "90000" });
		assert.equal(r.details.ok, true, r.details.errors.join(" / "));
		assert.deepEqual(prepared, [
			{
				kind: "binance-futures-open", broker: "binance", symbol: "BTCUSDT", base: "BTC", marginAsset: "USDT", side: "BUY", positionSide: "BOTH", type: "MARKET",
				quantity: "0.001", leverage: 5, marginType: "ISOLATED", current: { leverage: 1, marginType: "CROSSED" }, estimatedNotional: "83.7857",
				takeProfitPrice: "90000", stopLossPrice: "75000",
			},
		]);
		assert.deepEqual(r.details.lines.map((l) => l.label), ["레버리지", "증거금 방식", "펀딩"]);
		assert.ok(r.details.liqPrice);
		assert.equal(writes().length, 0);
	});

	it("양방향 모드 — 진입 positionSide 는 방향, 두 포지션이면 청산 대상을 묻는다", async () => {
		const pos = [{ ...LONG_POS, positionSide: "LONG" }, { ...LONG_POS, positionSide: "SHORT", positionAmt: "-0.001" }];
		const { run, prepared } = fakeFapi({ hedge: true, positions: pos });
		const o = await run({ action: "open", symbol: "BTCUSDT", side: "SELL", type: "MARKET", quantity: "0.001", leverage: 1 });
		assert.equal((prepared[0] as BinanceFuturesOpenAction).positionSide, "SHORT", o.details.errors.join(" / "));
		const ask = await run({ action: "close", symbol: "BTCUSDT" });
		assert.equal(ask.details.ok, false);
		assert.ok(ask.details.errors.some((e) => e.includes("positionSide")));
		const short = await run({ action: "close", symbol: "BTCUSDT", positionSide: "SHORT" });
		assert.equal(short.details.ok, true, short.details.errors.join(" / "));
		assert.deepEqual(prepared[1], {
			kind: "binance-futures-close", broker: "binance", symbol: "BTCUSDT", base: "BTC", marginAsset: "USDT", side: "BUY", positionSide: "SHORT", type: "MARKET", quantity: "0.001", positionAmt: "-0.001",
		});
	});

	it("포지션이 없으면 청산·익절손절을 준비하지 않는다", async () => {
		const { run, prepared } = fakeFapi();
		for (const action of ["close", "tpsl"]) {
			const r = await run({ action, symbol: "BTCUSDT", stopLossPrice: "80000" });
			assert.equal(r.details.ok, false);
			assert.ok(r.details.errors.some((e) => e.includes("열린 포지션이 없습니다")));
		}
		assert.equal(prepared.length, 0);
	});

	it("취소 — 번호가 없으면 목록, algoId 면 조건부 원주문은 서버 조회 값", async () => {
		const algo = [{ algoId: 21, symbol: "BTCUSDT", side: "SELL", orderType: "STOP_MARKET", triggerPrice: "76000", price: "0", quantity: "0", closePosition: true, positionSide: "BOTH" }];
		const { run, prepared } = fakeFapi({ algo });
		const list = await run({ action: "cancel", symbol: "BTCUSDT" });
		assert.equal(list.details.ok, false);
		assert.ok(list.details.errors.some((e) => e.includes("algoId=21")));
		const r = await run({ action: "cancel", symbol: "BTCUSDT", algoId: 21 });
		assert.equal(r.details.ok, true, r.details.errors.join(" / "));
		assert.deepEqual((prepared[0] as Extract<BinanceFuturesAction, { kind: "binance-futures-cancel" }>).original, {
			source: "algo", id: 21, side: "SELL", type: "STOP_MARKET", price: "0", triggerPrice: "76000", quantity: "0", closePosition: true,
		});
	});

	it("prepareOrder 가 없으면 조회만 되고 준비는 거절", async () => {
		fakeFapi();
		const tool = createBinanceFuturesTool({ brokers: { binance: () => CREDS } });
		await assert.rejects(tool.execute("id", { action: "open", symbol: "BTCUSDT" } as never, undefined, undefined, undefined as never), /비활성/);
	});
});

describe("실행 (확인 카드 [확인] 뒤 서버만 부른다)", () => {
	const open: BinanceFuturesOpenAction = {
		kind: "binance-futures-open", ...base, side: "BUY", positionSide: "BOTH", type: "MARKET", quantity: "0.001",
		leverage: 5, marginType: "ISOLATED", current: { leverage: 1, marginType: "CROSSED" }, estimatedNotional: "83.79", stopLossPrice: "75000", takeProfitPrice: "90000",
	};

	it("진입 — 증거금 방식 → 레버리지 → 주문 → 손절 → 익절 순, 서명, 재시도 없음", async () => {
		const { writes } = fakeFapi();
		const r = await executeOrderAction(open, "afNONCE", { binance: () => CREDS });
		assert.equal(r.orderId, "11");
		assert.match(r.message, /진입 주문이 접수되었습니다 \(FILLED · 체결 0\.001 @ 83790\) · 설정 격리 · 레버리지 5x · 손절 75000 등록 · 익절 90000 등록/);
		const w = writes();
		assert.deepEqual(w.map((c) => `${c.method} ${c.path}`), ["POST /fapi/v1/marginType", "POST /fapi/v1/leverage", "POST /fapi/v1/order", "POST /fapi/v1/algoOrder", "POST /fapi/v1/algoOrder"]);
		assert.equal(w[2]!.q.get("newClientOrderId"), "afNONCE");
		assert.equal(w[3]!.q.get("side"), "SELL", "롱의 손절은 SELL");
		assert.equal(w[3]!.q.get("clientAlgoId"), "afNONCEsl");
		assert.ok(w.every((c) => c.q.get("signature")), "서명");
	});

	it("레버리지가 같아도 진입 직전에 다시 보낸다 — 준비 뒤 앱에서 바꿨을 수 있다", async () => {
		const { writes } = fakeFapi();
		const r = await executeOrderAction({ ...open, leverage: 1, marginType: "CROSSED", stopLossPrice: undefined, takeProfitPrice: undefined }, "n", { binance: () => CREDS });
		assert.deepEqual(writes().map((c) => c.path), ["/fapi/v1/leverage", "/fapi/v1/order"]);
		assert.doesNotMatch(r.message, /설정/, "바뀐 것이 없으면 설정 문구를 싣지 않는다");
	});

	it("설정이 실패하면 주문하지 않는다", async () => {
		const { writes } = fakeFapi({ fail: { "/fapi/v1/leverage": { code: -4028, msg: "Leverage 200 is not valid" } } });
		await assert.rejects(executeOrderAction(open, "n", { binance: () => CREDS }), /Leverage/);
		assert.ok(!writes().some((c) => c.path === "/fapi/v1/order"));
	});

	it("손절 등록이 실패해도 진입은 접수 — 보호되지 않았다고 알린다", async () => {
		fakeFapi({ fail: { "/fapi/v1/algoOrder": { code: -2021, msg: "Order would immediately trigger." } } });
		const r = await executeOrderAction(open, "n", { binance: () => CREDS });
		assert.equal(r.orderId, "11");
		assert.match(r.message, /손절 등록 실패.*immediately trigger/);
		assert.match(r.message, /보호되지 않을 수 있습니다/);
	});

	it("익절·손절만 걸 때 전부 실패하면 실패로", async () => {
		fakeFapi({ fail: { "/fapi/v1/algoOrder": { code: -2021, msg: "Order would immediately trigger." } } });
		const a: BinanceFuturesAction = { kind: "binance-futures-tpsl", ...base, side: "SELL", positionSide: "BOTH", stopLossPrice: "75000" };
		await assert.rejects(executeOrderAction(a, "n", { binance: () => CREDS }), /immediately trigger/);
	});

	it("전체 취소 — 건수가 0 인 쪽은 요청하지 않는다", async () => {
		const { writes } = fakeFapi();
		const r = await executeOrderAction({ kind: "binance-futures-cancel-all", ...base, orders: 0, algo: 2 }, "n", { binance: () => CREDS });
		assert.deepEqual(writes().map((c) => c.path), ["/fapi/v1/algoOpenOrders"]);
		assert.match(r.message, /조건부 2건 취소/);
	});

	it("토큰 값이 이상하면 요청 전에 멈춘다", async () => {
		const { calls } = fakeFapi();
		await assert.rejects(executeOrderAction({ ...open, leverage: 0 }, "n", { binance: () => CREDS }), /레버리지/);
		await assert.rejects(executeOrderAction({ ...open, quantity: "-1" }, "n", { binance: () => CREDS }), /quantity/);
		await assert.rejects(executeOrderAction({ kind: "binance-futures-tpsl", ...base, side: "SELL", positionSide: "BOTH" }, "n", { binance: () => CREDS }), /익절·손절 가격/);
		assert.equal(calls.length, 0);
	});
});
