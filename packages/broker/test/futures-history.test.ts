/**
 * Binance USDⓈ-M 선물 손익·체결 내역 (binance_futures history · 매매일지 가져오기).
 * 파서·요약·구간 고르기는 순수, 조회는 가짜 fapi — 손익 내역으로 종목·구간을 고르고, 7일 넘게 한 번에 묻지 않는지 본다.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	binanceFuturesFills,
	directionOf,
	futuresFill,
	futuresHistory,
	futuresIncome,
	futuresQuote,
	futuresTrades,
	groupOrders,
	parseIncome,
	parseTrade,
	summarizeIncome,
	tradedSymbols,
	tradeRanges,
	windows,
	type FuturesIncome,
	type FuturesTrade,
} from "../src/binance/futures-history.ts";
import { createBinanceFuturesTool } from "../src/binance/futures-tool.ts";
import type { BinanceFuturesHistoryDetails } from "../src/binance/futures-card.ts";

const DAY = 86_400_000;
// 2026-10-12 21:00 KST
const NOW = Date.parse("2026-10-12T21:00:00+09:00");
const CREDS = { key: "k", secret: "s" };

const inc = (over: Partial<FuturesIncome>): FuturesIncome => ({ symbol: "BTCUSDT", type: "COMMISSION", amount: -0.08, asset: "USDT", at: NOW - DAY, tranId: "1", tradeId: "1", ...over });
const trade = (over: Partial<FuturesTrade>): FuturesTrade => ({
	id: 1, orderId: 11, symbol: "BTCUSDT", side: "BUY", positionSide: "BOTH", price: 83_000, qty: 0.002, quoteQty: 166, realizedPnl: 0,
	commission: 0.0664, commissionAsset: "USDT", maker: false, at: NOW - DAY, ...over,
});

describe("선물 내역 — 파서", () => {
	it("손익·체결 한 줄 — 숫자는 문자열로 온다, 빠진 줄은 버린다", () => {
		assert.deepEqual(parseIncome({ symbol: "btcusdt", incomeType: "REALIZED_PNL", income: "-1.25", asset: "USDT", time: 5, tranId: 9, tradeId: "77" }), {
			symbol: "BTCUSDT", type: "REALIZED_PNL", amount: -1.25, asset: "USDT", at: 5, tranId: "9", tradeId: "77",
		});
		assert.equal(parseIncome({ symbol: "", incomeType: "TRANSFER", income: "500", asset: "USDT", time: 6 })!.symbol, "");
		assert.equal(parseIncome({ incomeType: "", time: 1 }), null);
		const t = parseTrade({ id: 3, orderId: 11, symbol: "BTCUSDT", side: "SELL", positionSide: "LONG", price: "83790", qty: "0.002", quoteQty: "167.58", realizedPnl: "1.58", commission: "0.067", commissionAsset: "USDT", maker: true, time: 9 })!;
		assert.deepEqual([t.side, t.positionSide, t.price, t.realizedPnl, t.maker], ["SELL", "LONG", 83_790, 1.58, true]);
		assert.equal(parseTrade({ id: 3, symbol: "BTCUSDT", time: 9 }), null, "orderId 없음");
	});

	it("진입·청산 — 양방향은 positionSide, 단방향은 실현손익으로", () => {
		assert.equal(directionOf({ side: "BUY", positionSide: "LONG", realizedPnl: 0 }), "LONG_OPEN");
		assert.equal(directionOf({ side: "SELL", positionSide: "LONG", realizedPnl: 0 }), "LONG_CLOSE", "본전 청산도 양방향은 정확");
		assert.equal(directionOf({ side: "SELL", positionSide: "SHORT", realizedPnl: 0 }), "SHORT_OPEN");
		assert.equal(directionOf({ side: "BUY", positionSide: "SHORT", realizedPnl: 3 }), "SHORT_CLOSE");
		assert.equal(directionOf({ side: "BUY", positionSide: "BOTH", realizedPnl: 0 }), "LONG_OPEN");
		assert.equal(directionOf({ side: "SELL", positionSide: "BOTH", realizedPnl: -2 }), "LONG_CLOSE");
		assert.equal(directionOf({ side: "SELL", positionSide: "BOTH", realizedPnl: 0 }), "SHORT_OPEN");
		assert.equal(directionOf({ side: "BUY", positionSide: "BOTH", realizedPnl: 1 }), "SHORT_CLOSE");
	});

	it("체결 → 주문 단위 — 수량 가중 평단 · 실현손익·수수료 합 · 수수료 자산이 섞이면 null · 최근 순", () => {
		const orders = groupOrders([
			trade({ id: 1, orderId: 11, price: 83_000, qty: 0.001, quoteQty: 83, commission: 0.0332, at: NOW - 3 * DAY }),
			trade({ id: 2, orderId: 11, price: 83_100, qty: 0.001, quoteQty: 83.1, commission: 0.0332, at: NOW - 3 * DAY + 1000 }),
			trade({ id: 3, orderId: 12, side: "SELL", price: 84_000, qty: 0.002, quoteQty: 168, realizedPnl: 1.9, commission: 0.0672, at: NOW - DAY }),
			trade({ id: 4, orderId: 13, commission: 0.0001, commissionAsset: "BNB", at: NOW - 2 * DAY }),
			trade({ id: 5, orderId: 13, commission: 0.03, commissionAsset: "USDT", at: NOW - 2 * DAY }),
		]);
		assert.deepEqual(orders.map((o) => o.orderId), [12, 13, 11]);
		const open = orders.find((o) => o.orderId === 11)!;
		assert.deepEqual([open.qty, open.price, open.commission, open.fills, open.direction, open.at], [0.002, 83_050, 0.0664, 2, "LONG_OPEN", NOW - 3 * DAY]);
		const close = orders[0]!;
		assert.deepEqual([close.direction, close.realizedPnl], ["LONG_CLOSE", 1.9]);
		assert.equal(orders[1]!.commission, null, "USDT·BNB 를 더하지 않는다");
	});

	it("손익 요약 — 종목×자산 · 자산별 합계 · 입출금은 손익에서 뺀다", () => {
		const r = summarizeIncome([
			inc({ type: "REALIZED_PNL", amount: 10 }),
			inc({ type: "COMMISSION", amount: -0.5 }),
			inc({ type: "FUNDING_FEE", amount: -0.1 }),
			inc({ symbol: "ETHUSDT", type: "REALIZED_PNL", amount: -3 }),
			inc({ symbol: "ETHUSDT", type: "COMMISSION", amount: -0.001, asset: "BNB" }),
			inc({ symbol: "", type: "TRANSFER", amount: 500 }),
			inc({ symbol: "", type: "TRANSFER", amount: -100 }),
		]);
		assert.deepEqual(r.totals.find((t) => t.asset === "USDT"), { symbol: "", asset: "USDT", realized: 7, commission: -0.5, funding: -0.1, other: 0, net: 6.4 });
		assert.deepEqual(r.bySymbol.map((s) => `${s.symbol}/${s.asset}=${s.net}`), ["BTCUSDT/USDT=9.4", "ETHUSDT/USDT=-3", "ETHUSDT/BNB=-0.001"]);
		assert.deepEqual(r.moves, [{ asset: "USDT", amount: 400 }]);
	});

	it("7일 구간 · 매매한 종목(최근 순) · 체결을 훑을 구간 — 손익이 있는 구간 + 실현손익 구간의 앞", () => {
		const from = NOW - 30 * DAY;
		const w = windows(from, NOW);
		assert.equal(w.length, 5);
		assert.ok(w.every(([s, e]) => e - s < 7 * DAY), "Binance 는 7일 넘게 받지 않는다");
		assert.equal(w.at(-1)![1], NOW);
		const rows = [
			inc({ symbol: "ETHUSDT", at: from + 1 * DAY }),
			inc({ symbol: "BTCUSDT", type: "REALIZED_PNL", amount: 1, at: from + 15 * DAY }),
			inc({ symbol: "", type: "TRANSFER", at: from + 29 * DAY }),
		];
		assert.deepEqual(tradedSymbols(rows), ["BTCUSDT", "ETHUSDT"], "입출금은 종목이 아니다");
		assert.deepEqual(tradeRanges(rows, "BTCUSDT", from, NOW), [w[1], w[2]], "진입이 앞 구간일 수 있다");
		assert.deepEqual(tradeRanges(rows, "ETHUSDT", from, NOW), [w[0]]);
		assert.equal(futuresQuote("KORUUSDT"), "USDT");
		assert.equal(futuresQuote("ETHUSDC"), "USDC");
	});

	it("일지 체결 — ref·방향·실현손익. 수수료는 증거금 자산일 때만", () => {
		const [o] = groupOrders([trade({ orderId: 12, side: "SELL", positionSide: "SHORT", realizedPnl: 0 })]);
		const f = futuresFill(o!);
		assert.equal(f.ref, "binance_futures:BTCUSDT:12");
		assert.equal(f.broker, "binance_futures");
		assert.deepEqual([f.side, f.filled, f.price, f.currency, f.fee, f.open], ["SELL", 0.002, 83_000, "USDT", 0.0664, false]);
		assert.deepEqual(f.context, { direction: "SHORT_OPEN", realizedPnl: 0, positionSide: "SHORT" });
		const [bnb] = groupOrders([trade({ commission: 0.0001, commissionAsset: "BNB" })]);
		assert.equal(futuresFill(bnb!).fee, null, "BNB 수수료를 USDT 로 적지 않는다");
	});
});

// ── 가짜 fapi ───────────────────────────────────────────────

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

interface Call {
	path: string;
	q: URLSearchParams;
}

function fakeFapi(opts: { income: Array<Record<string, unknown>>; trades: Array<Record<string, unknown>>; open?: Array<Record<string, unknown>>; positions?: Array<Record<string, unknown>>; fail?: string }) {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const u = new URL(String(input));
		const q = u.searchParams;
		calls.push({ path: u.pathname, q });
		assert.equal(init?.method ?? "GET", "GET", "내역 조회는 읽기만");
		assert.ok(q.get("signature"), "서명 요청");
		const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
		if (opts.fail && u.pathname === opts.fail) return json({ code: -2015, msg: "Invalid API-key, IP, or permissions for action." }, 401);
		const n = (k: string) => Number(q.get(k));
		const limit = n("limit") || 500;
		switch (u.pathname) {
			case "/fapi/v1/income": {
				const rows = opts.income.filter((r) => Number(r.time) >= n("startTime") && Number(r.time) <= n("endTime"));
				const page = n("page") || 1;
				return json(rows.slice((page - 1) * limit, page * limit));
			}
			case "/fapi/v1/userTrades": {
				const sym = opts.trades.filter((t) => t.symbol === q.get("symbol"));
				if (q.has("fromId")) {
					assert.ok(!q.has("startTime") && !q.has("endTime"), "fromId 는 기간과 같이 못 보낸다");
					return json(sym.filter((t) => Number(t.id) >= n("fromId")).slice(0, limit));
				}
				assert.ok(n("endTime") - n("startTime") < 7 * DAY, "7일 이내");
				return json(sym.filter((t) => Number(t.time) >= n("startTime") && Number(t.time) <= n("endTime")).slice(0, limit));
			}
			case "/fapi/v1/openOrders":
				return json(opts.open ?? []);
			case "/fapi/v3/positionRisk":
				return json(opts.positions ?? []);
		}
		return json({ code: -1, msg: `없는 경로 ${u.pathname}` }, 404);
	}) as typeof fetch;
	return calls;
}

const rawIncome = (symbol: string, type: string, income: string, time: number, tranId: number) => ({ symbol, incomeType: type, income, asset: "USDT", time, tranId, tradeId: "" });
const rawTrade = (id: number, orderId: number, symbol: string, side: string, price: string, qty: string, realizedPnl: string, time: number) => ({
	id, orderId, symbol, side, positionSide: "BOTH", price, qty, quoteQty: String(Number(price) * Number(qty)), realizedPnl, commission: "0.05", commissionAsset: "USDT", maker: false, time,
});

describe("선물 내역 — 조회", () => {
	it("손익 내역 — 7일씩, 1,000건이 차면 다음 쪽", async () => {
		const income = Array.from({ length: 1500 }, (_, i) => rawIncome("BTCUSDT", "FUNDING_FEE", "-0.01", NOW - DAY + i, i + 1));
		const calls = fakeFapi({ income, trades: [] });
		const r = await futuresIncome(CREDS, NOW - 10 * DAY, NOW);
		assert.equal(r.rows.length, 1500);
		assert.equal(r.truncated, false);
		const pages = calls.filter((c) => c.path === "/fapi/v1/income").map((c) => `${c.q.get("startTime")}:${c.q.get("page")}`);
		assert.equal(pages.length, 3, "앞 구간 1쪽 + 뒤 구간 2쪽");
	});

	it("체결 — 1,000건이 차면 fromId 로 이어 받고, 구간 끝을 넘은 것은 버린다", async () => {
		const start = NOW - 6 * DAY;
		const trades = Array.from({ length: 1200 }, (_, i) => rawTrade(i + 1, 1000 + i, "BTCUSDT", "BUY", "83000", "0.001", "0", start + i * 1000));
		trades.push(rawTrade(5000, 9999, "BTCUSDT", "BUY", "83000", "0.001", "0", NOW + DAY));
		const calls = fakeFapi({ income: [], trades });
		const r = await futuresTrades(CREDS, "BTCUSDT", [[start, NOW]]);
		assert.equal(r.trades.length, 1200);
		assert.ok(!r.trades.some((t) => t.id === 5000), "구간 밖");
		assert.deepEqual(calls.map((c) => c.q.get("fromId")), [null, "1001"]);
	});

	it("history — 손익 내역에서 매매한 종목만 골라 체결을 훑는다 (입출금만 있는 구간·종목은 부르지 않는다)", async () => {
		const t1 = NOW - 20 * DAY;
		const t2 = NOW - 2 * DAY;
		const calls = fakeFapi({
			income: [
				rawIncome("", "TRANSFER", "500", NOW - 25 * DAY, 1),
				rawIncome("BTCUSDT", "COMMISSION", "-0.05", t1, 2),
				rawIncome("BTCUSDT", "REALIZED_PNL", "2.5", t2, 3),
				rawIncome("BTCUSDT", "COMMISSION", "-0.05", t2, 4),
				rawIncome("BTCUSDT", "FUNDING_FEE", "-0.02", NOW - 10 * DAY, 5),
			],
			trades: [rawTrade(1, 11, "BTCUSDT", "BUY", "83000", "0.002", "0", t1), rawTrade(2, 12, "BTCUSDT", "SELL", "84250", "0.002", "2.5", t2)],
		});
		const h = await futuresHistory(CREDS, NOW - 30 * DAY, NOW);
		assert.deepEqual(h.symbols, ["BTCUSDT"]);
		assert.deepEqual(h.orders.map((o) => `${o.orderId}:${o.direction}`), ["12:LONG_CLOSE", "11:LONG_OPEN"]);
		const tradeCalls = calls.filter((c) => c.path === "/fapi/v1/userTrades");
		assert.ok(tradeCalls.length <= 4, `훑은 구간 ${tradeCalls.length}개 — 5개 전부가 아니다`);
		assert.ok(tradeCalls.every((c) => c.q.get("symbol") === "BTCUSDT"));
	});

	it("열린 포지션 — 손익 기록이 없는 수수료 0 진입도 마지막 구간에서 찾는다", async () => {
		const t = NOW - 2 * 3_600_000;
		const calls = fakeFapi({
			income: [],
			trades: [{ ...rawTrade(1, 31, "KORUUSDT", "SELL", "16.25", "60", "0", t), commission: "0" }],
			positions: [{ symbol: "KORUUSDT", positionSide: "BOTH", positionAmt: "-60", entryPrice: "16.25", markPrice: "16.2", unRealizedProfit: "3", liquidationPrice: "0", notional: "-972", isolatedMargin: "0", marginAsset: "USDT" }],
		});
		const h = await futuresHistory(CREDS, NOW - 30 * DAY, NOW);
		assert.deepEqual(h.orders.map((o) => `${o.symbol}:${o.orderId}:${o.direction}`), ["KORUUSDT:31:SHORT_OPEN"]);
		assert.equal(calls.filter((c) => c.path === "/fapi/v1/userTrades").length, 1, "마지막 구간만");
	});

	it("binance_futures history — 손익 합계·종목별·체결 줄", async () => {
		const t1 = NOW - 3 * DAY;
		const t2 = NOW - 1 * DAY;
		fakeFapi({
			income: [
				rawIncome("BTCUSDT", "COMMISSION", "-0.0664", t1, 1),
				rawIncome("BTCUSDT", "FUNDING_FEE", "-0.0123", t1 + 8 * 3_600_000, 2),
				rawIncome("BTCUSDT", "REALIZED_PNL", "2.5", t2, 3),
				rawIncome("BTCUSDT", "COMMISSION", "-0.0674", t2, 4),
				rawIncome("", "TRANSFER", "487.94", NOW - 5 * DAY, 5),
			],
			trades: [rawTrade(1, 11, "BTCUSDT", "BUY", "83000", "0.002", "0", t1), rawTrade(2, 12, "BTCUSDT", "SELL", "84250", "0.002", "2.5", t2)],
		});
		const tool = createBinanceFuturesTool({ brokers: { binance: () => CREDS }, now: () => NOW });
		const r = (await tool.execute("id", { action: "history", days: 7 } as never, undefined, undefined, undefined as never)) as { content: Array<{ text: string }>; details: BinanceFuturesHistoryDetails };
		const text = r.content[0]!.text;
		assert.equal(r.details.kind, "binance-futures-history");
		assert.equal(r.details.orderCount, 2);
		assert.match(text, /합계: 실현 \+2\.5 · 수수료 -0\.1338 · 펀딩비 -0\.0123 → 순손익 \+2\.3539 USDT/);
		assert.match(text, /입출금 \(손익 아님\): USDT \+487\.94/);
		assert.match(text, /BTCUSDT 롱 청산 \(매도\) 0\.002 @ 84,250 · 실현 \+2\.5 · 수수료 0\.05 USDT · orderId=12/);
		assert.match(text, /BTCUSDT 롱 진입 \(매수\) 0\.002 @ 83,000 · 수수료 0\.05 USDT · orderId=11/);
	});

	it("binance_futures history — 선물 권한이 없으면 이유를 알려 준다", async () => {
		fakeFapi({ income: [], trades: [], fail: "/fapi/v1/income" });
		const tool = createBinanceFuturesTool({ brokers: { binance: () => CREDS }, now: () => NOW });
		await assert.rejects(tool.execute("id", { action: "history" } as never, undefined, undefined, undefined as never), /선물 내역 조회 실패.*선물 권한/);
	});

	it("일지 가져오기 — 아직 열린(부분 체결) 주문은 open", async () => {
		const t = NOW - DAY;
		fakeFapi({
			income: [rawIncome("ETHUSDT", "COMMISSION", "-0.05", t, 1)],
			trades: [rawTrade(1, 21, "ETHUSDT", "BUY", "2555", "0.1", "0", t), rawTrade(2, 22, "ETHUSDT", "BUY", "2550", "0.05", "0", t + 1)],
			open: [{ symbol: "ETHUSDT", orderId: 22 }],
		});
		const r = await binanceFuturesFills(CREDS, NOW - 30 * DAY, NOW);
		assert.deepEqual(r.fills.map((f) => `${f.ref}:${f.open}`).sort(), ["binance_futures:ETHUSDT:21:false", "binance_futures:ETHUSDT:22:true"]);
	});
});
