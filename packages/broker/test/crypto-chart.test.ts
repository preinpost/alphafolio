/**
 * 코인 지표 (market_technical · market: "binance").
 *
 * 실측 사고: "이더리움 주봉 ATR" 에 'ETH' 를 주식 티커로 넘겨 미국 상장 상품이 걸렸고,
 * Binance 캔들은 받아도 지표 계산 툴이 없어 답을 못 했다. 코인 봉도 같은 analyze() 를 탄다.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { coinPrice, fetchCryptoChart, normalizeCryptoSymbol, quoteAsset } from "../src/crypto-chart.ts";
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

	it("없는 심볼은 Binance 오류를 그대로", async () => {
		await assert.rejects(fetchCryptoChart("ETH", "W", { fetch: fakeFetch(rows) }), /Binance 에 없는 종목입니다: ETH/);
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

	it("코인 이름만 넘기면 심볼을 고치라고 알린다", async () => {
		globalThis.fetch = fakeFetch([]) as typeof fetch;
		await assert.rejects(run({ symbol: "ETH", market: "binance" }), /호가 자산까지 붙인다 \(ETHUSDT\)/);
	});
});
