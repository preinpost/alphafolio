/**
 * 시세·차트 심볼 라우팅 — 엉뚱한 시장/브로커로 보내지 않고, 실패하면 원인을 보존해 알린다.
 *
 * 운영 실측 (약 26건): ^GSPC 지수를 토스 /prices 로 보내 "요청 필드가 올바르지 않습니다",
 * ETHUSDT 를 주식 경로로 보내 "시세가 없습니다"·"종목을 찾을 수 없습니다",
 * KORU 같은 미국 티커를 market='binance' 로 보내 "Binance 에 없는 종목".
 * 그리고 브로커 루프가 lastError 를 덮어써 KIS 의 첫 원인이 토스의 "찾지 못함"에 가려졌다.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fetchChart, fetchQuote } from "../src/quote.ts";
import { createBrokerTools } from "../src/tools.ts";
import { memoryTokenStore } from "../src/tokens.ts";
import type { BrokerAccess } from "../src/portfolio.ts";
import type { TossContext } from "../src/toss/client.ts";
import type { KisContext } from "../src/kis/client.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
let seq = 0;

const DAY = 86_400_000;

/**
 * 토스 가짜 — /prices 는 known 목록만 가격을 주고 나머지는 빈 배열(실측 "시세 없음"과 같은 모양).
 * 지수처럼 토스가 거부하는 심볼은 rejectPrices 에 넣으면 400 "요청 필드가 올바르지 않습니다".
 * candles 는 known 이 아니면 "종목을 찾을 수 없습니다" 400.
 */
function fakeToss(opts: { known?: string[]; rejectPrices?: (s: string) => boolean } = {}) {
	const known = new Set(opts.known ?? []);
	const requests: string[] = [];
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
	const prev = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		if (!url.hostname.includes("tossinvest")) return prev(input, init);
		{
			requests.push(`${url.pathname}?${url.search.slice(1)}`);
			if (url.pathname === "/oauth2/token") return json({ access_token: "t", expires_in: 3600 });
			if (url.pathname === "/api/v1/prices") {
				const sym = url.searchParams.get("symbols") ?? "";
				if (opts.rejectPrices?.(sym)) return json({ error: { code: "INVALID", message: "요청 필드가 올바르지 않습니다" } }, 400);
				return json(known.has(sym) ? [{ symbol: sym, lastPrice: "70000", currency: "USD" }] : []);
			}
			if (url.pathname === "/api/v1/candles") {
				const sym = url.searchParams.get("symbol") ?? "";
				if (!known.has(sym)) return json({ error: { code: "NOT_FOUND", message: "종목을 찾을 수 없습니다" } }, 400);
				return json({ candles: Array.from({ length: 65 }, (_, i) => ({
					timestamp: new Date(Date.UTC(2026, 6, i + 1)).toISOString(), openPrice: String(100 + i),
					highPrice: String(102 + i), lowPrice: String(99 + i), closePrice: String(101 + i), volume: "1000", currency: "USD",
				})), nextBefore: null });
			}
			if (url.pathname === "/api/v1/stocks") return json([]);
			throw new Error(`unexpected toss request: ${url.pathname}`);
		}
	}) as typeof fetch;
	const ctx: TossContext = { creds: { clientId: `route-${++seq}`, clientSecret: "test" }, store: memoryTokenStore(), owner: `route-${seq}` };
	return { toss: () => ctx, requests };
}

/** 토스 요청 중 시세(/prices)·차트(/candles) 호출만 */
const tossCalls = (requests: string[]) => requests.filter((r) => /\/api\/v1\/(prices|candles)/.test(r));

/** Binance 가짜 — ETHUSDT 만 현물에 있다. 다른 심볼은 -1121 */
function fakeBinance(urls: string[] = []) {
	const rows = Array.from({ length: 30 }, (_, i) => {
		const t = Date.UTC(2026, 5, 1) + i * DAY;
		return [t, String(3000 + i), String(3050 + i), String(2950 + i), String(3000 + i), "1000", t + DAY - 1];
	});
	const prev = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (!url.includes("binance.com")) return prev(input, init);
		urls.push(url);
		if (url.includes("symbol=ETHUSDT")) return new Response(JSON.stringify(rows));
		return new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 });
	}) as typeof fetch;
}

function access(toss?: () => TossContext, kis?: () => KisContext): BrokerAccess {
	return { ...(toss ? { toss } : {}), ...(kis ? { kis } : {}) } as BrokerAccess;
}

function tools(brokers: BrokerAccess) {
	return createBrokerTools({ brokers, ledger: () => { throw new Error("not configured"); }, member: "ms" });
}

async function run(name: string, brokers: BrokerAccess, params: Record<string, unknown>) {
	const tool = tools(brokers).find((t) => t.name === name)!;
	return tool.execute("test", params as never, undefined, undefined, undefined as never);
}

describe("지수(^) 심볼 — 토스로 보내지 않는다", () => {
	it("market_price: ^GSPC 는 브로커 호출 없이 지수 미지원을 안내한다", async () => {
		const f = fakeToss({ known: ["^GSPC"], rejectPrices: (s) => s.startsWith("^") });
		await assert.rejects(fetchQuote(access(f.toss), "^GSPC"), /지수.*지원하지 않습니다.*twelve/);
		assert.deepEqual(tossCalls(f.requests), [], "토스 /prices 를 호출하면 안 된다");
	});

	it("market_technical: ^IXIC 도 같은 안내 (차트 경로)", async () => {
		const f = fakeToss({ known: ["^IXIC"], rejectPrices: (s) => s.startsWith("^") });
		await assert.rejects(fetchChart(access(f.toss), "^IXIC", "D"), /지수.*지원하지 않습니다/);
		assert.deepEqual(tossCalls(f.requests), []);
	});
});

describe("코인 심볼(USDT·USDC·FDUSD 접미) — 주식 경로로 보내지 않는다", () => {
	it("market_price: ETHUSDT 는 주식 시세 조회 없이 market_technical(binance) 를 안내한다", async () => {
		const f = fakeToss();
		await assert.rejects(fetchQuote(access(f.toss), "ETHUSDT"), /코인.*market_technical.*binance/);
		assert.deepEqual(tossCalls(f.requests), [], "토스 /prices 를 호출하면 안 된다");
	});

	it("market_technical: market 을 빼도 ETHUSDT 는 Binance 현물로 간다 (토스 candles 호출 없음)", async () => {
		const f = fakeToss();
		const urls: string[] = [];
		fakeBinance(urls);
		const r = await run("market_technical", access(f.toss), { symbol: "ETHUSDT" });
		assert.match(urls[0] ?? "", /api\/v3\/klines\?symbol=ETHUSDT/);
		assert.deepEqual(tossCalls(f.requests), []);
		assert.match(r.content[0]!.text, /ETHUSDT/);
	});

	it("market_technical: market='us' 가 와도 USDT 접미는 코인으로 간다 (확실한 규칙)", async () => {
		const f = fakeToss();
		const urls: string[] = [];
		fakeBinance(urls);
		await run("market_technical", access(f.toss), { symbol: "ETHUSDT", market: "us" });
		assert.match(urls[0] ?? "", /symbol=ETHUSDT/);
		assert.deepEqual(tossCalls(f.requests), []);
	});

	it("market_timing: market 을 빼도 ETHUSDT 는 코인 판정으로 간다", async () => {
		const f = fakeToss();
		const urls: string[] = [];
		fakeBinance(urls);
		await run("market_timing", access(f.toss), { symbol: "ETHUSDT" });
		assert.match(urls[0] ?? "", /symbol=ETHUSDT/);
		assert.deepEqual(tossCalls(f.requests), []);
	});
});

describe("Binance 에 없는 미국 티커 — 재시도 방법을 알려준다", () => {
	it("market_technical market='binance' + KORU(호가 자산 없음) → market:'us' 안내", async () => {
		fakeBinance();
		const f = fakeToss({ known: ["KORU"] });
		await assert.rejects(run("market_technical", access(f.toss), { symbol: "KORU", market: "binance" }), /market:'us'/);
	});

	it("market_timing market='binance' + INTC → market:'us' 안내", async () => {
		fakeBinance();
		const f = fakeToss({ known: ["INTC"] });
		await assert.rejects(run("market_timing", access(f.toss), { symbol: "INTC", market: "binance" }), /market:'us'/);
	});
});

describe("브로커 실패 원인 보존", () => {
	it("KIS 가 실패하고 토스가 '찾지 못함'이어도 KIS 실패 사유를 함께 알린다", async () => {
		// KIS 모의투자 서버는 해외 시세 API 를 지원하지 않는다 — 이 응답이 첫 원인이다
		globalThis.fetch = (async (input: string | URL) => {
			const url = new URL(String(input));
			if (url.hostname.includes("koreainvestment")) {
				return new Response(JSON.stringify({ rt_cd: "1", msg_cd: "EGW00000", msg1: "모의투자 미지원 API 입니다" }), { status: 200 });
			}
			if (url.pathname === "/oauth2/token") return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
			if (url.pathname === "/api/v1/prices") return new Response(JSON.stringify([]));
			throw new Error(`unexpected: ${url.href}`);
		}) as typeof fetch;
		const kisCtx: KisContext = {
			creds: { appKey: "k", appSecret: "s", env: "paper" },
			store: memoryTokenStore(),
			owner: `kis-${++seq}`,
		};
		const f = fakeToss();
		await assert.rejects(fetchQuote(access(f.toss, () => kisCtx), "KORZ"), (err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			assert.match(msg, /모의투자 미지원/, msg);
			assert.match(msg, /KIS/, msg);
			assert.match(msg, /토스/, msg);
			return true;
		});
	});
});

describe("시세 없음 안내", () => {
	it("토스 단독 — 원자재·지수·비상장 범위 밖이라는 힌트를 준다", async () => {
		const f = fakeToss();
		await assert.rejects(fetchQuote(access(f.toss), "PLATINUM"), /시세가 없습니다.*지수·원자재·비상장/);
	});
});
