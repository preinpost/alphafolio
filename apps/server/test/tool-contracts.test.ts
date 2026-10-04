/** 실제 런타임 등록 경로의 도구 이름·스키마·페르소나 계약 (외부 API 호출 없음). */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Check } from "typebox/value";
import { buildSystemPrompt } from "@alphafolio/agent";
import { createUserTools, CUSTOM_TOOL_NAMES } from "../src/tool-registry.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function registry() {
	const accessed: string[] = [];
	const unavailable = () => { throw new Error("credentials must be resolved at execution time"); };
	const opts: Parameters<typeof createUserTools>[0] = {
		ledgerConfig: unavailable,
		brokerAccess: (user) => { accessed.push(`broker:${user}`); return { kis: unavailable, toss: unavailable, binance: unavailable }; },
		naverCreds: unavailable, dataCreds: unavailable,
		prepareOrder: (user) => { accessed.push(`order:${user}`); return unavailable; },
		mcpServers: (user) => { accessed.push(`mcp:${user}`); return []; },
		mcpFetch: unavailable, prepareMcpWrite: () => unavailable,
		watch: (user) => ({ prepareWatch: unavailable, listWatches: async () => { accessed.push(`watch:${user}`); return []; }, pauseWatch: unavailable, channels: () => [] }),
	};
	return { opts, accessed };
}

// 페르소나가 안내하는 주요 호출을 각 도구별로 적는다. 스키마의 required·enum·타입 변경을 함께 검출한다.
const examples: Record<string, Array<Record<string, unknown>>> = {
	ledger_add: [{ amount: 8000, type: "expense", daysAgo: 1 }, { amount: 8000, type: "expense" }, { date: "2026-09-03", amount: 1000, type: "income" }],
	ledger_summary: [{ period: "this_month", scope: "mine" }, { groupBy: "member" }],
	ledger_list: [{ period: "last_7d", type: "expense" }],
	ledger_update: [{ id: "tx-1", amount: 1000 }],
	ledger_delete: [{ id: "tx-1" }],
	ledger_budget: [{ action: "status" }, { action: "set", category: "식비", limit: 10000 }],
	market_price: [{ symbol: "005930" }],
	market_technical: [{ symbol: "ETHUSDT", market: "binance", period: "D" }],
	market_timing: [{ symbol: "005930" }, { symbol: "AAPL", horizon: "short" }],
	stock_research: [{ symbol: "005930" }],
	market_movers: [{ market: "KR", type: "trading_amount" }],
	market_news: [{ query: "삼성전자" }],
	market_overseas_news: [{ symbol: "NVDA" }, {}],
	market_financials: [{ symbol: "005930", quarters: 8 }],
	portfolio_holdings: [{}], portfolio_signals: [{}], finance_overview: [{ period: "this_month" }],
	order_prepare: [{ symbol: "005930", side: "BUY", orderType: "LIMIT", quantity: 1, price: 70000 }],
	order_list: [{ status: "OPEN" }, { status: "CLOSED" }],
	order_change: [{ action: "cancel" }, { action: "modify", orderId: "T-1", price: 69000 }],
	order_conditional: [{ action: "cancel", conditionalOrderId: "C-1" }],
	binance_order: [{ action: "place", symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: "0.001", price: "80000" }],
	binance_stock_order: [{ action: "place", symbol: "AAPL", side: "BUY", type: "MARKET", notional: "5" }, { action: "cancel", symbol: "AAPL" }],
	binance_stock_account: [{}], binance_wallet: [{ action: "balances" }, { action: "transfer", from: "EARN", to: "SPOT", asset: "USDT", all: true }],
	kis_find: [{ query: "외국인 수급" }], kis_call: [{ api: "FHPIF05030100", params: {} }],
	toss_query: [{ api: "getConditionalOrders", describe: true }],
	data_find: [{ query: "earnings calendar" }], data_call: [{ provider: "binance", api: "GET /api/v3/openOrders" }],
	kis_stream: [{ find: "주식 체결" }],
	derivatives_greeks: [{ type: "call", underlying: 100, strike: 100, expiry: "2026-12-31", vol: 25, currency: "USD" }],
	mcp_call: [{}, { server: "example", tool: "get_quote", describe: true }],
	watch_alert: [{ action: "list" }, { action: "pause", id: "watch-1" }, { action: "prepare", symbol: "ETHUSDT", market: "binance", interval: "1h", all: [{ left: "close", op: "<", right: 2600 }] }],
};

describe("사용자별 도구 등록 계약", () => {
	it("등록된 34개 도구가 선언된 목록과 정확히 일치하고 이름이 중복되지 않는다", () => {
		const { opts } = registry();
		const tools = createUserTools(opts, "ms");
		const names = tools.map((t) => t.name);
		assert.equal(names.length, 34);
		assert.equal(new Set(names).size, names.length);
		assert.deepEqual(names, [...CUSTOM_TOOL_NAMES]);
		assert.deepEqual(Object.keys(examples).sort(), [...names].sort());
	});

	it("생성 단계에서 자격증명이나 네트워크에 접근하지 않는다", () => {
		globalThis.fetch = (async () => { throw new Error("unexpected network request"); }) as typeof fetch;
		const { opts } = registry();
		assert.equal(createUserTools(opts, "ms").length, 34);
	});

	it("모든 도구에 설명·객체 스키마·실행 함수가 있고 호출 예제가 스키마에 맞는다", () => {
		const { opts } = registry();
		for (const tool of createUserTools(opts, "ms")) {
			assert.ok(tool.label?.trim(), tool.name);
			assert.ok(tool.description.trim(), tool.name);
			assert.equal(tool.parameters.type, "object", tool.name);
			assert.equal(typeof tool.execute, "function", tool.name);
			for (const args of examples[tool.name]!) {
				assert.ok(Check(tool.parameters, args), `${tool.name}: ${JSON.stringify(args)}`);
				for (const key of Object.keys(args)) assert.ok(key in tool.parameters.properties, `${tool.name}: undeclared ${key}`);
			}
		}
	});

	it("잘못된 enum·타입과 지원하지 않는 실행 동작을 거절하는 스키마를 유지한다", () => {
		const { opts } = registry();
		const tools = new Map(createUserTools(opts, "ms").map((t) => [t.name, t]));
		for (const [name, args] of [
			["ledger_add", { amount: 8000, type: "EXPENSE", daysAgo: 1 }],
			["ledger_add", { amount: 8000, type: "expense", daysAgo: -1 }],
			["ledger_add", { amount: 8000, type: "expense", daysAgo: 0.5 }],
			["order_change", { action: "execute" }],
			["order_conditional", { action: "create", conditionalOrderId: "C-1" }],
			["watch_alert", { action: "arm" }], ["watch_alert", { action: "delete", id: "watch-1" }],
			["binance_wallet", { action: "withdraw" }],
			["binance_order", { action: "place", symbol: "BTCUSDT", quantity: 0.001 }],
		] as const) assert.equal(Check(tools.get(name)!.parameters, args), false, name);
	});

	it("도메인 도구와 다른 사용자로 바인딩된 도구가 섞이지 않는다", async () => {
		const { opts, accessed } = registry();
		for (const user of ["ms", "sj"]) {
			const tools = createUserTools(opts, user);
			const before = accessed.length;
			for (const name of ["mcp_call", "watch_alert"]) {
				const tool = tools.find((t) => t.name === name)!;
				await tool.execute("test", (name === "watch_alert" ? { action: "list" } : {}) as never, undefined, undefined, undefined as never);
			}
			assert.deepEqual(accessed.slice(before), [`mcp:${user}`, `watch:${user}`]);
		}
	});

	it("금융 도구 목록에 셸·파일 접근이나 확인 후 실행용 도구를 등록하지 않는다", () => {
		for (const name of ["read", "write", "edit", "bash", "powershell", "order_execute", "mcp_execute", "watch_arm"]) {
			assert.ok(!(CUSTOM_TOOL_NAMES as readonly string[]).includes(name), name);
		}
	});
});

describe("시스템 프롬프트와 도구 계약", () => {
	it("페르소나가 지시하는 자체 도구 이름은 실제로 등록되어 있다", () => {
		const prompt = buildSystemPrompt({ ledgerEnabled: true, member: "ms" });
		const refs = [...prompt.matchAll(/`((?:ledger_|market_|portfolio_|finance_|order_|binance_|kis_|data_)[a-z_]+|stock_research|toss_query|mcp_call|watch_alert)`/g)].map((m) => m[1]!);
		assert.ok(refs.length > 20);
		for (const name of refs) assert.ok((CUSTOM_TOOL_NAMES as readonly string[]).includes(name), name);
	});

	it("상대 날짜와 주문 조회·정정·취소 경로를 명시한다", () => {
		const prompt = buildSystemPrompt({ ledgerEnabled: true, member: "ms" });
		assert.match(prompt, /daysAgo: 1/);
		assert.match(prompt, /토스 미체결·종료 주문은 `order_list`/);
		assert.match(prompt, /통합 미체결 목록은\s+`order_change`/);
		assert.match(prompt, /확인 카드에서 사용자가 눌러야/);
	});
});
