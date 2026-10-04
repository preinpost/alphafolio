/** 브로커 툴 — 조회 실패를 미보유로 오해하지 않고, 주문 도구의 역할을 구분한다. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createBrokerTools, type PortfolioSignalsDetails } from "../src/tools.ts";
import { memoryTokenStore } from "../src/tokens.ts";
import { inspectPortfolioSignals } from "../src/portfolio-signals.ts";
import type { OrderAction } from "../src/actions.ts";
import type { BrokerAccess } from "../src/portfolio.ts";
import type { TossContext } from "../src/toss/client.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
let seq = 0;

function fakeToss(opts: { symbols?: string[]; accountsFail?: boolean; holdingsFail?: boolean; chartFail?: string[]; cashFail?: boolean; buyingPower?: string } = {}) {
	const hits: string[] = [];
	const requests: Array<{ path: string; method: string }> = [];
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		hits.push(url.pathname);
		requests.push({ path: url.pathname, method: init?.method ?? "GET" });
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
		if (url.pathname === "/oauth2/token") return json({ access_token: "t", expires_in: 3600 });
		if (url.pathname === "/api/v1/accounts") {
			if (opts.accountsFail) throw new Error("simulated broker outage");
			return json([{ accountSeq: 7 }]);
		}
		if (url.pathname === "/api/v1/holdings") {
			if (opts.holdingsFail) throw new Error("simulated holdings outage");
			return json({ items: (opts.symbols ?? []).map((symbol, i) => ({
				symbol, name: symbol, currency: "KRW", marketCountry: "KR", quantity: "1", averagePurchasePrice: "100",
				lastPrice: "110", marketValue: { amount: String(10000 - i) }, profitLoss: { amount: "10", rate: "0.1" },
			})) });
		}
		if (url.pathname === "/api/v1/buying-power") {
			if (opts.cashFail && url.searchParams.get("currency") === "USD") throw new Error("simulated USD cash outage");
			return json({ cashBuyingPower: opts.buyingPower ?? "0" });
		}
		if (url.pathname === "/api/v1/exchange-rate") return json({ midRate: "1400" });
		if (url.pathname === "/api/v1/prices") return json([{ symbol: url.searchParams.get("symbols"), lastPrice: "70000", currency: "KRW" }]);
		if (url.pathname === "/api/v1/stocks") return json([{ symbol: url.searchParams.get("symbols"), name: url.searchParams.get("symbols") }]);
		if (url.pathname === "/api/v1/candles") {
			const symbol = url.searchParams.get("symbol")!;
			if (opts.chartFail?.includes(symbol)) throw new Error(`simulated chart outage ${symbol}`);
			return json({ candles: Array.from({ length: 65 }, (_, i) => ({
				timestamp: new Date(Date.UTC(2026, 6, i + 1)).toISOString(), openPrice: String(100 + i),
				highPrice: String(102 + i), lowPrice: String(99 + i), closePrice: String(101 + i), volume: "1000", currency: "KRW",
			})), nextBefore: null });
		}
		if (url.pathname === "/api/v1/orders") return json({ orders: [{
			orderId: "T-1", symbol: "005930", side: "BUY", quantity: "3", price: "70000", currency: "KRW", status: "OPEN", execution: { filledQuantity: "0" },
		}] });
		throw new Error(`unexpected request: ${url.pathname}`);
	}) as typeof fetch;
	const ctx: TossContext = { creds: { clientId: `tool-review-${++seq}`, clientSecret: "test" }, store: memoryTokenStore(), owner: `tool-review-${seq}` };
	return { brokers: { toss: () => ctx }, hits, requests };
}

function tools(brokers: BrokerAccess) {
	return createBrokerTools({ brokers, ledger: () => { throw new Error("not configured"); }, member: "ms" });
}

async function signals(brokers: BrokerAccess) {
	const tool = tools(brokers).find((t) => t.name === "portfolio_signals")!;
	const result = await tool.execute("test", {} as never, undefined, undefined, undefined as never);
	return { text: result.content[0]!.text, details: result.details as PortfolioSignalsDetails };
}

describe("portfolio_signals 조회 상태", () => {
	it("실제 미보유는 미보유로 안내한다", async () => {
		const { brokers } = fakeToss();
		const r = await signals(brokers);
		assert.match(r.text, /점검할 보유 종목이 없습니다/);
		assert.deepEqual(r.details.rows, []);
		assert.deepEqual(r.details.skipped, []);
		assert.deepEqual(r.details.warnings, []);
	});

	it("브로커 전체 장애는 미보유가 아니라 조회 실패로 안내한다", async () => {
		const { brokers } = fakeToss({ accountsFail: true });
		const r = await signals(brokers);
		assert.doesNotMatch(r.text, /보유 종목이 없습니다/);
		assert.match(r.text, /확인하지 못했습니다/);
		assert.match(r.text, /simulated broker outage/);
		assert.ok(r.details.warnings.length > 0);
	});

	it("보유 조회만 실패해도 빈 목록을 미보유로 단정하지 않는다", async () => {
		const { brokers } = fakeToss({ holdingsFail: true });
		const r = await signals(brokers);
		assert.doesNotMatch(r.text, /보유 종목이 없습니다/);
		assert.match(r.text, /simulated holdings outage/);
	});

	it("보유는 있지만 모든 차트가 실패하면 실패 종목과 이유를 전달한다", async () => {
		const { brokers } = fakeToss({ symbols: ["005930", "000660"], chartFail: ["005930", "000660"] });
		const r = await signals(brokers);
		assert.doesNotMatch(r.text, /보유 종목이 없습니다/);
		assert.match(r.text, /점검하지 못했습니다/);
		assert.match(r.text, /005930/);
		assert.match(r.text, /000660/);
		assert.equal(r.details.skipped.length, 2);
	});

	it("부분 성공은 성공 결과와 차트 실패·포트폴리오 경고를 모두 전달한다", async () => {
		const { brokers } = fakeToss({ symbols: ["005930", "000660"], chartFail: ["000660"], cashFail: true });
		const r = await signals(brokers);
		assert.equal(r.details.rows.length, 1);
		assert.equal(r.details.rows[0]?.symbol, "005930");
		assert.match(r.text, /보유 1종목 기술적 점검/);
		assert.match(r.text, /000660/);
		assert.match(r.text, /simulated USD cash outage/);
		assert.equal(r.details.skipped.length, 1);
		assert.equal(r.details.warnings.length, 1);
	});

	it("정상 조회에서는 기존 지표 결과를 유지한다", async () => {
		const { brokers } = fakeToss({ symbols: ["005930"] });
		const r = await signals(brokers);
		assert.equal(r.details.kind, "portfolio-signals-card");
		assert.equal(r.details.rows[0]?.price, 165);
		assert.deepEqual(r.details.warnings, []);
		assert.deepEqual(r.details.skipped, []);
	});

	it("상위 12종목만 조회하고 나머지는 생략했다고 알린다", async () => {
		const { brokers, hits } = fakeToss({ symbols: Array.from({ length: 13 }, (_, i) => String(100000 + i)) });
		const r = await signals(brokers);
		assert.equal(r.details.rows.length, 12);
		assert.equal(hits.filter((p) => p === "/api/v1/candles").length, 12);
		assert.match(r.text, /외 1종목은 생략/);
	});
});

describe("분리된 유스케이스·주문 준비", () => {
	it("보유 점검 유스케이스는 도구 출력 없이 결과·조회 범위를 반환한다", async () => {
		const { brokers } = fakeToss({ symbols: ["005930"] });
		const result = await inspectPortfolioSignals(brokers);
		assert.equal(result.targetCount, 1);
		assert.equal(result.rows[0]?.symbol, "005930");
		assert.equal("content" in result, false);
		assert.equal("kind" in result, false);
	});

	it("주문 준비는 조회와 확인 토큰 발급만 하고 실제 주문을 보내지 않는다", async () => {
		const { brokers, requests } = fakeToss({ buyingPower: "1000000" });
		const prepared: OrderAction[] = [];
		const tool = createBrokerTools({ brokers, ledger: () => { throw new Error("unused"); }, member: "ms", prepareOrder: (action) => {
			prepared.push(action);
			return { token: "test-token", expiresAt: 123 };
		} }).find((t) => t.name === "order_prepare")!;
		const r = await tool.execute("test", { symbol: "005930", side: "BUY", orderType: "LIMIT", quantity: 1, price: 70000 } as never, undefined, undefined, undefined as never);
		assert.equal(prepared.length, 1);
		assert.equal(prepared[0]?.kind, "place");
		assert.equal(prepared[0]?.broker, "toss");
		assert.ok("ok" in r.details && r.details.ok);
		assert.ok("token" in r.details && r.details.token === "test-token");
		assert.match(r.content[0]!.text, /확인 버튼을 눌러야 주문이 나갑니다/);
		assert.ok(requests.filter((q) => q.path !== "/oauth2/token").every((q) => q.method === "GET"));
		assert.ok(requests.every((q) => q.path !== "/api/v1/orders"));
	});
});

describe("order_list 역할", () => {
	it("토스 전용 범위를 명시하고 취소는 order_change로 안내한다", () => {
		const tool = tools({}).find((t) => t.name === "order_list")!;
		assert.match(tool.description, /토스증권/);
		assert.match(tool.description, /order_change/);
		assert.doesNotMatch(tool.description, /투자 탭에서 취소 버튼/);
	});

	it("조회 본문에 orderId를 포함하고 쓰기 요청은 보내지 않는다", async () => {
		const { brokers, hits, requests } = fakeToss();
		const tool = tools(brokers).find((t) => t.name === "order_list")!;
		const r = await tool.execute("test", {} as never, undefined, undefined, undefined as never);
		assert.match(r.content[0]!.text, /orderId=T-1/);
		assert.ok(hits.includes("/api/v1/orders"));
		assert.ok(hits.every((p) => p === "/oauth2/token" || p === "/api/v1/accounts" || p === "/api/v1/orders"));
		assert.ok(requests.filter((r) => r.path !== "/oauth2/token").every((r) => r.method === "GET"));
	});

	it("토스 연결이 없으면 KIS 미체결 조회 경로를 안내한다", async () => {
		const tool = tools({}).find((t) => t.name === "order_list")!;
		await assert.rejects(tool.execute("test", {} as never, undefined, undefined, undefined as never), /order_change/);
	});
});
