/**
 * 포트폴리오 — 토스 달러 예수금 (PLAN §30).
 *
 * 지켜야 할 것: 달러 예수금은 **환산하지 않고 따로** 둔다. 원화 예수금·총자산(스냅샷에 쌓이는 값)의 뜻은 그대로.
 * 달러 조회만 실패해도 나머지는 보여주고 경고한다.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fetchPortfolio } from "../src/portfolio.ts";
import { memoryTokenStore } from "../src/tokens.ts";
import type { TossContext } from "../src/toss/client.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

let seq = 0;
/** 토스 API 흉내 — 경로·쿼리로 응답을 고른다. usd 가 null 이면 달러 예수금 조회를 실패시킨다 */
function fakeToss(opts: { krw: string; usd: string | null; rate?: string }): TossContext {
	globalThis.fetch = (async (input: string | URL) => {
		const url = new URL(String(input));
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
		if (url.pathname === "/oauth2/token") return json({ access_token: "t", expires_in: 3600 });
		if (url.pathname === "/api/v1/accounts") return json([{ accountSeq: 7 }]);
		if (url.pathname === "/api/v1/holdings") {
			return json({
				items: [
					{ symbol: "AAPL", name: "애플", currency: "USD", marketCountry: "US", quantity: "1", averagePurchasePrice: "360", lastPrice: "350", marketValue: { amount: "350" }, profitLoss: { amount: "-10", rate: "-0.0277" } },
				],
			});
		}
		if (url.pathname === "/api/v1/buying-power") {
			const cur = url.searchParams.get("currency");
			if (cur === "KRW") return json({ currency: "KRW", cashBuyingPower: opts.krw });
			if (opts.usd === null) return json({ error: { code: "E", message: "일시 오류" } }, 500);
			return json({ currency: "USD", cashBuyingPower: opts.usd });
		}
		if (url.pathname === "/api/v1/exchange-rate") return json({ rate: opts.rate ?? "1400", midRate: opts.rate ?? "1400" });
		return json({ error: { message: `없는 경로 ${url.pathname}` } }, 404);
	}) as typeof fetch;
	return { creds: { clientId: `c${++seq}`, clientSecret: "s" }, store: memoryTokenStore(), owner: `u${seq}` };
}

describe("토스 달러 예수금", () => {
	it("원화 예수금과 따로 준다 — 환산해서 합치지 않는다", async () => {
		const ctx = fakeToss({ krw: "5000000", usd: "1234.5" });
		const p = await fetchPortfolio({ toss: () => ctx });
		assert.equal(p.cashKrw, 5_000_000, "원화 예수금에 달러 환산분이 섞이면 안 된다");
		assert.equal(p.cashUsd, 1234.5);
		assert.equal(p.stockValueKrw, 350 * 1400, "주식 평가액만 — 달러 예수금은 총자산에 넣지 않는다");
		assert.deepEqual(p.warnings, []);
	});

	it("달러 예수금 조회만 실패하면 0 + 경고, 나머지는 그대로", async () => {
		const ctx = fakeToss({ krw: "5000000", usd: null });
		const p = await fetchPortfolio({ toss: () => ctx });
		assert.equal(p.cashKrw, 5_000_000);
		assert.equal(p.cashUsd, 0);
		assert.equal(p.holdings.length, 1);
		assert.ok(p.warnings.some((w) => w.includes("달러 예수금")), p.warnings.join(" / "));
	});

	it("달러가 없으면 0 (경고 없음)", async () => {
		const ctx = fakeToss({ krw: "100", usd: "0" });
		const p = await fetchPortfolio({ toss: () => ctx });
		assert.equal(p.cashUsd, 0);
		assert.deepEqual(p.warnings, []);
	});

	it("센트 단위로 정리한다 (부동소수점 잡음 없음)", async () => {
		const ctx = fakeToss({ krw: "0", usd: "0.1" });
		const p = await fetchPortfolio({ toss: () => ctx });
		assert.equal(p.cashUsd, 0.1);
	});
});
