/**
 * 코인·Binance 선물 타점 — 같은 판정 규칙에 거래소 tickSize·코인 표기·코인 비용을 넣는다.
 *
 * 실측 사고 (2026-10-12): KORUUSDT(선물에만 있는 TradFi 무기한)를 물었더니 타점 툴이 주식만 봐서
 * 토스의 미국 주식 KORU 로 판정했다 — 사용자가 물은 선물 가격이 아니었다.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { clearFuturesCache } from "../src/binance/futures.ts";
import type { Bar } from "../src/indicators.ts";
import { evaluateTiming, fallbackTick, marketGrid, tickGrid, type TimingResult } from "../src/timing.ts";
import { leverageLine } from "../src/tools/analysis.ts";
import { createBrokerTools } from "../src/tools.ts";

const DAY = 86_400_000;

function barsOf(closes: number[]): Bar[] {
	return closes.map((c, i) => ({ date: String(20260101 + i), open: c, high: c * 1.03, low: c * 0.97, close: c, volume: 1000 }));
}

/** 흔들리며 내리는 시계열 (KORU 처럼 약세) */
const falling = (n = 90) => Array.from({ length: n }, (_, i) => 25 - i * 0.09 + ((i * 7) % 5) * 0.12);

describe("가격 격자", () => {
	it("tickGrid — 부동소수점 잡음 없이 호가단위로 내림·올림", () => {
		const g = tickGrid("0.01000000", { fmt: String, costPct: 0.1 });
		assert.equal(g.floor(4.35), 4.35, "4.35 / 0.01 = 434.99999… 로 깎이지 않는다");
		assert.equal(g.floor(16.959), 16.95);
		assert.equal(g.breakeven(16.951), 16.96);
		assert.equal(g.clean(0.1 + 0.2), 0.3);
		const fine = tickGrid("0.001", { fmt: String, costPct: 0.1 });
		assert.equal(fine.floor(16.9599), 16.959);
	});

	it("거래소 규칙이 없으면 가격의 유효숫자 5자리 정도", () => {
		assert.equal(fallbackTick(16.7), "0.001");
		assert.equal(fallbackTick(2554), "0.1");
		assert.equal(fallbackTick(84_000), "1");
		assert.equal(fallbackTick(0.5), "0.00001");
	});

	it("주식은 예전 규칙 그대로 (marketGrid)", () => {
		const bars = barsOf(falling().map((c) => c * 1000));
		const a = evaluateTiming({ bars, market: "KR" }) as TimingResult;
		const b = evaluateTiming({ bars, market: "KR", grid: marketGrid("KR") }) as TimingResult;
		assert.deepEqual(a, b);
	});

	it("코인 격자로 판정 — 가격이 tick 위에 있고 USDT 로 표기", () => {
		const grid = tickGrid("0.001", { fmt: (v) => `${v} USDT`, costPct: 0.1 });
		const r = evaluateTiming({ bars: barsOf(falling()), market: "US", grid, valueNote: "선물 — 재무 해당 없음" }) as TimingResult;
		const onTick = (v: number | null) => v === null || Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6;
		assert.ok([r.stopLoss, r.target1, r.target2, ...r.scenarios.map((s) => s.triggerPrice)].every(onTick));
		assert.equal(r.roundTripCostPct, 0.1);
		assert.match(r.layers.find((l) => l.name === "밸류")?.reasons[0] ?? "", /선물 — 재무 해당 없음/);
		assert.match(r.layers.find((l) => l.name === "리스크")?.reasons.join() ?? "", /USDT/);
	});
});

describe("레버리지 줄", () => {
	const r = (entry: number, stop: number | null) => ({ entry: { price: entry, type: "now" }, stopLoss: stop }) as TimingResult;
	it("손절 폭 × 배수, 청산 상한은 1 ÷ 손절 폭 올림", () => {
		assert.equal(
			leverageLine(r(100, 81.4)),
			"손절 폭 18.6% — 손절 시 증거금 손실 2배 −37.2% · 3배 −55.8% · 5배 −93%. 6배 이상이면 손절가에 닿기 전에 강제청산된다 (유지증거금·수수료 때문에 그보다 낮은 배수에서도 청산될 수 있다 — 실제 청산가는 binance_futures 준비 카드에서 확인)",
		);
	});
	it("손절 폭이 25% 면 4배부터 청산 — 100% 넘는 배수는 빼고", () => {
		const line = leverageLine(r(100, 75)) ?? "";
		assert.match(line, /2배 −50% · 3배 −75%\. 4배 이상이면/);
	});
	it("손절이 없으면 줄도 없다", () => {
		assert.equal(leverageLine(r(100, null)), null);
	});
});

describe("market_timing — Binance 선물", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
		clearFuturesCache();
	});

	const closes = falling();
	const klines = closes.map((c, i) => [Date.UTC(2026, 6, 16) + i * DAY, String(c), String(c * 1.03), String(c * 0.97), String(c), "1000", 0]);
	const mock = (positions: unknown[] = []) => {
		const urls: string[] = [];
		globalThis.fetch = (async (input: string | URL) => {
			const url = String(input);
			urls.push(url);
			if (url.startsWith("https://api.binance.com/api/v3/klines")) return new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 });
			if (url.startsWith("https://fapi.binance.com/fapi/v1/klines")) return new Response(JSON.stringify(klines));
			if (url.startsWith("https://fapi.binance.com/fapi/v1/exchangeInfo"))
				return new Response(
					JSON.stringify({
						symbols: [{ symbol: "KORUUSDT", contractType: "TRADIFI_PERPETUAL", underlyingType: "EQUITY", baseAsset: "KORU", quoteAsset: "USDT", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.001" }] }],
					}),
				);
			if (url.startsWith("https://fapi.binance.com/fapi/v1/premiumIndex")) return new Response(JSON.stringify({ markPrice: "17.0", lastFundingRate: "0.0001", nextFundingTime: 0 }));
			if (url.startsWith("https://fapi.binance.com/fapi/v3/positionRisk")) return new Response(JSON.stringify(positions));
			throw new Error(`예상 밖 요청: ${url}`);
		}) as typeof fetch;
		return urls;
	};
	const run = (p: Record<string, unknown>, brokers: Record<string, unknown> = {}) => {
		const t = createBrokerTools({ brokers, ledger: () => ({}) as never, member: "m" } as never).find((x) => x.name === "market_timing");
		assert.ok(t);
		return t.execute("id", p as never, undefined, undefined, undefined as never) as Promise<{ content: Array<{ text: string }>; details: { currency: string; symbol: string; name: string } }>;
	};

	it("무기한 표기면 선물 봉으로 판정 — 증권 키 없이, 롱 기준·레버리지 한도를 함께", async () => {
		const urls = mock();
		const res = await run({ symbol: "koruusdtp", market: "binance" });
		const text = res.content[0]?.text ?? "";
		assert.equal(urls.filter((u) => u.includes("api.binance.com/api/v3/klines")).length, 0, "무기한 표기면 현물을 보지 않는다");
		assert.match(text, /^KORUUSDT 선물 타점 판정 \[스윙·단기 둘 다\] — 일봉 90개/);
		assert.match(text, /USDT/);
		assert.doesNotMatch(text, /\$/);
		assert.match(text, /\[밸류\] 중립: 선물 — 재무 해당 없음/);
		assert.match(text, /왕복 비용 0\.1% 가정/);
		assert.match(text, /Binance USDⓈ-M 선물 기준 \(TradFi 무기한 — 미국 주식 기반/);
		assert.match(text, /롱\(매수\) 기준.*숏 진입 판정은 하지 않는다/);
		assert.match(text, /\[스윙 레버리지\] 손절 폭 [\d.]+% — 손절 시 증거금 손실 2배/);
		assert.equal(res.details.currency, "USDT");
	});

	it("롱 포지션은 보유로 반영, 숏은 반영하지 않고 알린다", async () => {
		const creds = { binance: () => ({ key: "k", secret: "s" }) };
		mock([{ symbol: "KORUUSDT", positionSide: "BOTH", positionAmt: "12", entryPrice: "18.5", markPrice: "17", unRealizedProfit: "-18", liquidationPrice: "0", notional: "204" }]);
		const long = (await run({ symbol: "KORUUSDT", market: "binance", venue: "futures", horizon: "swing" }, creds)).content[0]?.text ?? "";
		assert.match(long, /보유 12 KORU · 평단 18\.5 USDT/);

		clearFuturesCache();
		mock([{ symbol: "KORUUSDT", positionSide: "BOTH", positionAmt: "-3", entryPrice: "20", markPrice: "17", unRealizedProfit: "9", liquidationPrice: "0", notional: "-51" }]);
		const short = (await run({ symbol: "KORUUSDT", market: "binance", venue: "futures", horizon: "swing" }, creds)).content[0]?.text ?? "";
		assert.match(short, /숏 포지션 3 KORU 보유 중 \(진입가 20 USDT\) — 판정 규칙이 롱 기준이라 보유로 반영하지 않았다/);
		assert.match(short, /손익분기\(진입 시\)/);
	});
});
