/**
 * 코인 지표 (market_technical · market: "binance").
 *
 * 실측 사고: "이더리움 주봉 ATR" 에 'ETH' 를 주식 티커로 넘겨 미국 상장 상품이 걸렸고,
 * Binance 캔들은 받아도 지표 계산 툴이 없어 답을 못 했다. 코인 봉도 같은 analyze() 를 탄다.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { clearFuturesCache } from "../src/binance/futures.ts";
import { coinPrice, cutAtRebase, fetchCryptoChart, normalizeCryptoSymbol, parseCryptoSymbol, quoteAsset } from "../src/crypto-chart.ts";
import { createBrokerTools } from "../src/tools.ts";

const DAY = 86_400_000;
const W = 7 * DAY;
/** 월요일 0시 UTC — Binance 주봉 시작 */
const MON = Date.UTC(2026, 3, 6);

/** klines 응답 행 — 가격은 문자열 */
function kline(t: number, c: number, range = 100): unknown[] {
	return [t, String(c), String(c + range / 2), String(c - range / 2), String(c), "1000", t + W - 1];
}

function fakeFetch(rows: unknown[][], urls: string[] = []) {
	return async (url: string): Promise<Response> => {
		urls.push(url);
		if (!url.includes("symbol=ETHUSDT")) return new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 });
		return new Response(JSON.stringify(rows));
	};
}

describe("심볼", () => {
	it("구분자·소문자를 Binance 표기로", () => {
		assert.equal(normalizeCryptoSymbol(" eth/usdt "), "ETHUSDT");
		assert.equal(normalizeCryptoSymbol("ETH-USDT"), "ETHUSDT");
	});
	it("호가 자산 — 긴 것부터 (FDUSD 를 USD 로 자르지 않는다)", () => {
		assert.equal(quoteAsset("ETHUSDT"), "USDT");
		assert.equal(quoteAsset("BTCFDUSD"), "FDUSD");
		assert.equal(quoteAsset("ETHBTC"), "BTC");
		assert.equal(quoteAsset("ETH"), ""); // 호가 자산 이름 그 자체는 페어가 아니다
		assert.equal(quoteAsset("FOO"), "");
	});
});

describe("봉 조회", () => {
	const rows = Array.from({ length: 30 }, (_, i) => kline(MON + i * W, 3000 + i * 10));

	it("주봉은 1w 200개, 날짜는 봉 시작(UTC) YYYYMMDD", async () => {
		const urls: string[] = [];
		const c = await fetchCryptoChart("ethusdt", "W", { fetch: fakeFetch(rows, urls), now: MON + 29 * W + DAY });
		assert.match(urls[0] as string, /interval=1w&limit=200/);
		assert.equal(c.symbol, "ETHUSDT");
		assert.equal(c.quote, "USDT");
		assert.equal(c.bars.length, 30);
		assert.equal(c.bars[0]?.date, "20260406");
		assert.equal(c.bars[0]?.high, 3050);
	});

	it("진행 중인 봉을 남기고 표시한다 (감시용과 달리 버리지 않는다)", async () => {
		const open = await fetchCryptoChart("ETHUSDT", "W", { fetch: fakeFetch(rows), now: MON + 29 * W + DAY });
		assert.equal(open.bars.length, 30);
		assert.equal(open.lastOpen, true);
		const closed = await fetchCryptoChart("ETHUSDT", "W", { fetch: fakeFetch(rows), now: MON + 30 * W });
		assert.equal(closed.lastOpen, false);
	});

	it("월봉은 1M, 마감은 다음 달 1일", async () => {
		const urls: string[] = [];
		const t = Date.UTC(2026, 1, 1); // 2월 — 28일
		const c = await fetchCryptoChart("ETHUSDT", "M", { fetch: fakeFetch([kline(t, 3000)], urls), now: Date.UTC(2026, 1, 28, 23) });
		assert.match(urls[0] as string, /interval=1M/);
		assert.equal(c.lastOpen, true);
		const after = await fetchCryptoChart("ETHUSDT", "M", { fetch: fakeFetch([kline(t, 3000)]), now: Date.UTC(2026, 2, 1) });
		assert.equal(after.lastOpen, false);
	});

	it("현물·선물 둘 다 없으면 그렇다고 알린다", async () => {
		const urls: string[] = [];
		await assert.rejects(fetchCryptoChart("ETH", "W", { fetch: fakeFetch(rows, urls) }), /Binance 현물·선물 어디에도 없는 종목입니다: ETH/);
		assert.equal(urls.length, 2);
	});
});

/** 선물에만 있는 심볼 — 실측 사고: KORUUSDT(TradFi 무기한)를 현물에서만 찾고 "바이낸스에 없는 심볼"이라 답했다 */
function venueFetch(rows: unknown[][], urls: string[] = []) {
	return async (url: string): Promise<Response> => {
		urls.push(url);
		const ok = url.startsWith("https://fapi.binance.com/fapi/v1/klines?symbol=KORUUSDT") || url.startsWith("https://api.binance.com/api/v3/klines?symbol=ETHUSDT");
		return ok ? new Response(JSON.stringify(rows)) : new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 });
	};
}

describe("선물 봉", () => {
	const rows = Array.from({ length: 30 }, (_, i) => kline(MON + i * W, 17 + i * 0.1, 1));

	it("현물에 없으면 선물에서 다시 찾는다", async () => {
		const urls: string[] = [];
		const c = await fetchCryptoChart("KORUUSDT", "W", { fetch: venueFetch(rows, urls), now: MON + 30 * W });
		assert.equal(c.venue, "futures");
		assert.equal(c.bars.length, 30);
		assert.match(urls[0] as string, /^https:\/\/api\.binance\.com\/api\/v3\/klines/);
		assert.match(urls[1] as string, /^https:\/\/fapi\.binance\.com\/fapi\/v1\/klines\?symbol=KORUUSDT/);
	});

	it("둘 다 있는 심볼은 현물 — 선물을 부르지 않는다", async () => {
		const urls: string[] = [];
		const c = await fetchCryptoChart("ETHUSDT", "W", { fetch: venueFetch(rows, urls) });
		assert.equal(c.venue, "spot");
		assert.equal(urls.length, 1);
	});

	it("무기한 표기(.P · P · PERP)는 떼고 바로 선물로", async () => {
		assert.deepEqual(parseCryptoSymbol("koruusdtp"), { symbol: "KORUUSDT", perp: true });
		assert.deepEqual(parseCryptoSymbol("KORUUSDT.P"), { symbol: "KORUUSDT", perp: true });
		assert.deepEqual(parseCryptoSymbol("BTCUSDT-PERP"), { symbol: "BTCUSDT", perp: true });
		assert.deepEqual(parseCryptoSymbol("ETHUSDT"), { symbol: "ETHUSDT", perp: false });
		assert.deepEqual(parseCryptoSymbol("ETHBTC"), { symbol: "ETHBTC", perp: false });
		const urls: string[] = [];
		const c = await fetchCryptoChart("KORUUSDT.P", "D", { fetch: venueFetch(rows, urls) });
		assert.equal(c.symbol, "KORUUSDT");
		assert.equal(c.venue, "futures");
		assert.equal(urls.length, 1);
	});

	it("venue 를 정하면 그곳만 본다", async () => {
		const urls: string[] = [];
		await assert.rejects(fetchCryptoChart("KORUUSDT", "D", { fetch: venueFetch(rows, urls), venue: "spot" }), /Binance 에 없는 종목입니다: KORUUSDT/);
		assert.equal(urls.length, 1);
		await assert.rejects(fetchCryptoChart("ETHUSDT", "D", { fetch: venueFetch(rows), venue: "futures" }), /Binance 선물에 없는 종목입니다: ETHUSDT/);
	});
});

describe("가격 단위 변경", () => {
	const bar = (date: string, close: number) => ({ date, open: close, high: close, low: close, close, volume: 1 });
	it("마지막 단위 변경 봉까지 버린다", () => {
		const r = cutAtRebase([bar("1", 500), bar("2", 497), bar("3", 21), bar("4", 22), bar("5", 20)]);
		assert.equal(r.date, "3");
		assert.deepEqual(r.bars.map((b) => b.date), ["4", "5"]);
	});
	it("큰 변동이어도 5배 안쪽이면 그대로", () => {
		const bars = [bar("1", 100), bar("2", 30), bar("3", 120)];
		assert.deepEqual(cutAtRebase(bars), { bars, date: null });
	});
});

describe("코인 가격 표기", () => {
	it("1 이상은 소수 둘째 자리", () => {
		assert.equal(coinPrice(4123.456, "USDT"), "4,123.46 USDT");
	});
	it("1 미만은 유효숫자 4자리 — 저가 코인 ATR 이 0 으로 보이지 않게", () => {
		assert.equal(coinPrice(0.000012345, "USDT"), "0.00001235 USDT");
		assert.equal(coinPrice(0.5, ""), "0.5");
	});
});

describe("market_technical — binance", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	const tool = () => {
		// 증권 키가 없어도 된다 — 공개 klines
		const t = createBrokerTools({ brokers: {}, ledger: () => ({}) as never, member: "m" }).find((x) => x.name === "market_technical");
		assert.ok(t);
		return t;
	};
	const run = (p: Record<string, unknown>) =>
		tool().execute("id", p as never, undefined, undefined, undefined as never) as Promise<{ content: Array<{ text: string }>; details: { currency: string; snapshot: { atr: number | null } | null } }>;

	it("증권 키 없이 주봉 ATR 을 USDT 로 계산한다", async () => {
		// 봉마다 고저 폭 100, 종가 변화 10 → TR = 100 → ATR(14) = 100
		const rows = Array.from({ length: 80 }, (_, i) => kline(Date.UTC(2025, 0, 6) + i * W, 3000 + i * 10));
		globalThis.fetch = fakeFetch(rows) as typeof fetch;
		const res = await run({ symbol: "ETHUSDT", market: "binance", period: "W" });
		const text = res.content[0]?.text ?? "";
		assert.equal(res.details.currency, "USDT");
		assert.equal(res.details.snapshot?.atr, 100);
		assert.match(text, /^ETHUSDT 주봉 80개/);
		assert.match(text, /ATR\(14\) 100 USDT/);
		assert.match(text, /Binance 현물 기준/);
	});

	it("선물 종목은 계약 종류·표시가격·펀딩비를 함께 알린다", async () => {
		clearFuturesCache();
		const rows = Array.from({ length: 80 }, (_, i) => kline(Date.UTC(2025, 0, 6) + i * DAY, 17 + i * 0.01, 1));
		const klines = venueFetch(rows);
		globalThis.fetch = (async (url: string) => {
			if (url.startsWith("https://fapi.binance.com/fapi/v1/exchangeInfo"))
				return new Response(JSON.stringify({ symbols: [{ symbol: "KORUUSDT", contractType: "TRADIFI_PERPETUAL", underlyingType: "EQUITY", baseAsset: "KORU", quoteAsset: "USDT", filters: [] }] }));
			if (url.startsWith("https://fapi.binance.com/fapi/v1/premiumIndex"))
				return new Response(JSON.stringify({ symbol: "KORUUSDT", markPrice: "16.66684611", lastFundingRate: "0.00012987", nextFundingTime: Date.UTC(2026, 9, 12, 8) }));
			return klines(url);
		}) as typeof fetch;
		const res = await run({ symbol: "KORUUSDT", market: "binance" });
		const text = res.content[0]?.text ?? "";
		assert.equal(res.details.currency, "USDT");
		assert.match(text, /Binance USDⓈ-M 선물 기준 \(TradFi 무기한 — 미국 주식 기반 \(실물이 아니라 가격을 따라가는 계약\)\)/);
		assert.match(text, /표시가격 16\.67 USDT · 펀딩비 \+0\.0130% \(다음 17:00 KST\)/);
		assert.doesNotMatch(text, /현물 기준/);
	});

	it("TradFi 는 가격 단위가 바뀐 봉 뒤만 쓴다 — 지난 봉을 Binance 가 고치지 않는다", async () => {
		clearFuturesCache();
		// 실측 모양: 497 → (그날 497 에 열려 21 에 닫힘) → 21 근처
		const rows = Array.from({ length: 80 }, (_, i) => kline(Date.UTC(2025, 0, 6) + i * DAY, i < 40 ? 497 : 21 + i * 0.01, 1));
		const klines = venueFetch(rows);
		globalThis.fetch = (async (url: string) => {
			if (url.startsWith("https://fapi.binance.com/fapi/v1/exchangeInfo"))
				return new Response(JSON.stringify({ symbols: [{ symbol: "KORUUSDT", contractType: "TRADIFI_PERPETUAL", underlyingType: "EQUITY", filters: [] }] }));
			if (url.startsWith("https://fapi.binance.com/fapi/v1/premiumIndex")) return new Response("{}", { status: 400 });
			return klines(url);
		}) as typeof fetch;
		const res = await run({ symbol: "KORUUSDT", market: "binance" });
		const text = res.content[0]?.text ?? "";
		assert.match(text, /^KORUUSDT 일봉 39개/);
		assert.match(text, /20250215 봉에서 가격 단위가 바뀌어\(분할·계약 변경 추정, Binance 는 지난 봉을 고치지 않는다\) 그 뒤 39봉만 썼다/);
		assert.doesNotMatch(text, /497/);
	});

	it("선물 부가 정보가 실패해도 지표는 낸다", async () => {
		clearFuturesCache();
		const rows = Array.from({ length: 80 }, (_, i) => kline(Date.UTC(2025, 0, 6) + i * DAY, 17 + i * 0.01, 1));
		globalThis.fetch = venueFetch(rows) as typeof fetch;
		const res = await run({ symbol: "KORUUSDT", venue: "futures" });
		const text = res.content[0]?.text ?? "";
		assert.match(text, /^KORUUSDT 일봉 80개/);
		assert.match(text, /Binance USDⓈ-M 선물 기준 · 봉 경계/);
	});

	it("코인 이름만 넘기면 심볼을 고치라고 알린다", async () => {
		globalThis.fetch = fakeFetch([]) as typeof fetch;
		await assert.rejects(run({ symbol: "ETH", market: "binance" }), /호가 자산까지 붙인다 \(ETHUSDT\)/);
	});
});
