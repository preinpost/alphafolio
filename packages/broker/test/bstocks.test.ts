/**
 * Binance bStocks (토큰화 미국 주식) — 심볼 모양·판정·후보 문장·경고.
 *
 * 지켜야 할 것:
 *   - 판정은 B 접미 USDT 쌍 + 기준가 계산 EXTERNAL #2 (코인 BNBUSDT 처럼 모양만 맞는 건 아니다)
 *   - 조회가 실패하면 코인으로 (캐시하지 않는다)
 *   - 쌍이 아닌 티커는 고르지 않고 후보를 알린다 (STX = Seagate bStock · Stacks 코인)
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { binanceSymbolHint, bStockGate, bStockOf, bStockStatus, bStockSymbol, bStockTicker, bStockWarnings, clearBStockCache } from "../src/binance/bstocks.ts";

const realFetch = globalThis.fetch;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
beforeEach(() => clearBStockCache());
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("bStock 심볼", () => {
	it("티커 ↔ 쌍", () => {
		assert.equal(bStockSymbol("aapl"), "AAPLBUSDT");
		assert.equal(bStockSymbol("BRK.B"), "BRKBBUSDT");
		assert.equal(bStockTicker("NVDABUSDT"), "NVDA");
		assert.equal(bStockTicker("ETHUSDT"), null);
		assert.equal(bStockTicker("AAPLBUSDC"), null);
	});
});

describe("bStock 판정", () => {
	it("EXTERNAL #2 면 bStock, 평균가 계산이면 코인 — 캐시한다", async () => {
		const calls: string[] = [];
		const f = async (u: string) => {
			calls.push(u);
			return u.includes("NVDAB") ? json({ calculationType: "EXTERNAL", externalCalculationId: 2 }) : json({ calculationType: "ARITHMETIC_MEAN", bucketCount: 80 });
		};
		assert.deepEqual(await bStockOf("NVDABUSDT", { fetch: f }), { symbol: "NVDABUSDT", ticker: "NVDA", token: "NVDAB" });
		assert.equal(await bStockOf("BNBUSDT", { fetch: f }), null, "모양만 맞는 코인");
		await bStockOf("NVDABUSDT", { fetch: f });
		assert.equal(calls.length, 2);
		assert.match(calls[0]!, /\/api\/v3\/referencePrice\/calculation\?symbol=NVDABUSDT$/);
		assert.equal(await bStockOf("ETHUSDT", { fetch: f }), null);
		assert.equal(calls.length, 2, "모양이 아니면 조회하지 않는다");
	});

	it("조회 실패는 코인으로, 캐시하지 않는다", async () => {
		let fail = true;
		const f = async () => {
			if (fail) throw new Error("fetch failed");
			return json({ calculationType: "EXTERNAL", externalCalculationId: 2 });
		};
		assert.equal(await bStockOf("AAPLBUSDT", { fetch: f }), null);
		fail = false;
		assert.equal((await bStockOf("AAPLBUSDT", { fetch: f }))?.ticker, "AAPL");
	});
});

describe("쌍이 아닌 티커 — 후보", () => {
	const info = (symbol: string, status = "TRADING") => ({ symbols: [{ symbol, status, baseAsset: symbol.replace(/USDT$/, ""), quoteAsset: "USDT", filters: [] }] });
	function exchange(have: string[]) {
		globalThis.fetch = (async (input: string | URL) => {
			const s = new URL(String(input)).searchParams.get("symbol") ?? "";
			return have.includes(s) ? json(info(s)) : json({ code: -1121, msg: "Invalid symbol." }, 400);
		}) as typeof fetch;
	}

	it("둘 다 있으면 코인인지 주식인지 묻게 한다 — 주식이면 실제 주식(직접 거래) 쪽, 토큰은 직접 말했을 때만 (STX)", async () => {
		exchange(["STXUSDT", "STXBUSDT"]);
		const h = (await binanceSymbolHint("stx")) ?? "";
		assert.match(h, /코인 STXUSDT 인지 미국 주식인지 사용자에게 물어보세요/);
		assert.match(h, /binance_stock_order\(symbol: 'STX'\)/);
		assert.match(h, /bStock·토큰이라고 직접 말했을 때만/);
	});

	it("주식 티커는 토큰이 아니라 실제 주식으로 안내한다 (AAPL), 없으면 형식 안내, 쌍이면 null", async () => {
		exchange(["AAPLBUSDT"]);
		const h = (await binanceSymbolHint("AAPL")) ?? "";
		assert.match(h, /^AAPL 이\(가\) 미국 주식이면 실제 주식은 binance_stock_order\(symbol: 'AAPL'\) · 자동 매매는 watch_alert market: 'us' \+ order\.broker: 'binance_stock'/);
		assert.doesNotMatch(h.split("—")[0]!, /AAPLBUSDT/, "첫 안내에 토큰 심볼을 내밀지 않는다");
		exchange(["SOLUSDT"]);
		assert.match((await binanceSymbolHint("SOL")) ?? "", /코인 SOLUSDT/);
		assert.match((await binanceSymbolHint("ZZZZ")) ?? "", /거래쌍이 없습니다/);
		assert.equal(await binanceSymbolHint("AAPLBUSDT"), null);
		assert.equal(await binanceSymbolHint("BTCUSDT"), null);
	});

	it("경고 — 증서·24시간·기준가 범위, 자동 매매면 시세 출처", () => {
		const b = { symbol: "AAPLBUSDT", ticker: "AAPL", token: "AAPLB" };
		assert.equal(bStockWarnings(b, false).length, 2);
		assert.match(bStockWarnings(b, true).join(" "), /토큰화 증권.*±10%.*나스닥 AAPL 시세가 아닙니다/);
	});
});

describe("bStock 주문 길목 — 토큰은 사용자가 직접 원할 때만", () => {
	it("bStock 이고 bStock: true 가 없으면 실제 주식 쪽으로 돌려보낸다", () => {
		const g = bStockGate("AAPLBUSDT", "bstock", undefined) ?? "";
		assert.match(g, /AAPL 주식이 아니라 bStock/);
		assert.match(g, /binance_stock_order\(symbol: 'AAPL'\)/);
		assert.equal(bStockGate("AAPLBUSDT", "bstock", false) !== null, true);
		assert.equal(bStockGate("AAPLBUSDT", "bstock", true), null);
		assert.equal(bStockGate("BTCUSDT", "coin", undefined), null);
	});

	it("확인 조회가 실패하면(unknown) bStock 으로 본다 — 보수적으로", async () => {
		assert.match(bStockGate("NVDABUSDT", "unknown", undefined) ?? "", /확인하지 못했습니다/);
		assert.equal(await bStockStatus("NVDABUSDT", { fetch: async () => { throw new Error("down"); } }), "unknown");
		assert.equal(await bStockStatus("ETHUSDT"), "coin", "모양이 아니면 조회 없이 코인");
		assert.equal(await bStockStatus("BNBUSDT", { fetch: async () => json({ calculationType: "ARITHMETIC_MEAN" }) }), "coin");
		assert.equal(await bStockStatus("NVDABUSDT", { fetch: async () => json({ calculationType: "EXTERNAL", externalCalculationId: 2 }) }), "bstock");
	});
});

