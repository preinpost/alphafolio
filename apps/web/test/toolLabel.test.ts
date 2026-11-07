/**
 * 툴 진행 줄 문구 — "<무엇> · <대상>", 비유 없이.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KNOWN_TOOLS, parseCodemodeCalls, toolLabel, toolLabelText } from "../src/lib/toolLabel.ts";

/** 서버·확장이 등록하는 툴 전부 (packages/broker·ledger·mcp, pi-web-access) */
const ALL_TOOLS = [
	"market_price", "market_technical", "market_timing", "market_financials", "stock_research",
	"market_movers", "market_news", "market_overseas_news", "derivatives_greeks", "kis_stream",
	"kis_find", "kis_call", "toss_query", "data_find", "data_call",
	"portfolio_holdings", "portfolio_signals", "finance_overview",
	"order_prepare", "order_list", "order_change", "order_conditional",
	"watch_alert", "range_trade",
	"binance_wallet", "binance_order", "binance_futures", "binance_stock_account", "binance_stock_order",
	"ledger_add", "ledger_list", "ledger_summary", "ledger_update", "ledger_delete", "ledger_budget",
	"journal_add", "journal_update", "journal_list",
	"web_enable", "web_search", "fetch_content", "get_search_content",
	"source_check",
	"mcp_call",
	// pi 메타 툴 (agent-config/settings.json defaultTools)
	"codemode", "tool_search",
];

describe("toolLabel", () => {
	it("모든 툴에 전용 문구가 있다", () => {
		for (const name of ALL_TOOLS) assert.ok(KNOWN_TOOLS.includes(name), name);
	});

	it("비유·'~하는 중' 문구를 쓰지 않는다", () => {
		for (const name of ALL_TOOLS) {
			for (const state of ["running", "done", "error", "stopped"] as const) {
				const text = toolLabelText(name, {}, state);
				assert.doesNotMatch(text, /중…|는 중|…$/, `${name} ${state}: ${text}`);
			}
		}
	});

	it("인자에서 대상을 뽑는다", () => {
		assert.equal(toolLabelText("market_price", { symbol: "NVDA" }, "done"), "시세 조회 · NVDA");
		assert.equal(toolLabelText("journal_add", { symbol: "005930", name: "삼성전자", side: "BUY", quantity: 1 }, "done"), "매매일지 기록 · 삼성전자(005930) 매수");
		assert.equal(toolLabelText("web_search", { query: "어제 미국 증시 마감" }, "running"), "웹 검색 · '어제 미국 증시 마감'");
		assert.equal(toolLabelText("web_search", { queries: ["a", "b", "c"] }, "running"), "웹 검색 · 'a' 외 2건");
		assert.equal(toolLabelText("market_news", { query: "나스닥" }, "done"), "뉴스 검색 · 나스닥");
		assert.equal(toolLabelText("portfolio_holdings", {}, "done"), "보유 종목 불러오기");
		assert.equal(toolLabelText("ledger_list", { from: "2026-11-01", to: "2026-11-30" }, "done"), "가계부 내역 조회 · 2026-11-01~2026-11-30");
		assert.equal(toolLabelText("ledger_summary", { period: "this_month" }, "done"), "가계부 집계 · 이번 달");
		assert.equal(toolLabelText("market_movers", { market: "US", type: "gainers" }, "done"), "시장 순위 조회 · 미국 상승률 상위");
		assert.equal(toolLabelText("fetch_content", { url: "https://www.reuters.com/markets/x" }, "done"), "웹 페이지 읽기 · reuters.com");
		assert.equal(toolLabelText("watch_alert", { action: "list" }, "done"), "감시 알림 목록");
		assert.equal(toolLabelText("binance_futures", { action: "open", symbol: "BTCUSDT" }, "done"), "바이낸스 선물 진입 준비 · BTCUSDT");
	});

	it("외부 MCP 는 서버·툴 이름을 그대로", () => {
		assert.equal(toolLabelText("mcp_call", { server: "notion", tool: "search" }, "done"), "외부 도구 실행 · notion / search");
		assert.equal(toolLabelText("mcp_call", {}, "done"), "외부 도구 목록 조회");
	});

	it("실패·중단을 분명히", () => {
		assert.equal(toolLabelText("market_price", { symbol: "NVDA" }, "error"), "시세 조회 실패 · NVDA");
		assert.equal(toolLabelText("market_price", { symbol: "NVDA" }, "stopped"), "시세 조회 중단됨 · NVDA");
	});

	it("긴 대상은 자른다", () => {
		const t = toolLabel("web_search", { query: "가".repeat(100) }).target ?? "";
		assert.ok(t.length <= 40 && t.endsWith("…"));
	});

	it("모르는 툴은 내부 이름 대신 중립 문구", () => {
		assert.equal(toolLabelText("someNew_tool", { x: 1 }, "done"), "도구 실행");
		assert.equal(toolLabelText("market_price", null, "done"), "시세 조회");
	});
});

describe("codemode", () => {
	const code = (s: string) => ({ code: s });

	it("'codemode' 라는 이름을 절대 보여주지 않는다", () => {
		for (const args of [{}, null, code(""), code("return 1"), code("syntax error ((("), code("await tools.unknown_x({})")]) {
			for (const state of ["running", "done", "error", "stopped"] as const) {
				assert.doesNotMatch(toolLabelText("codemode", args, state), /codemode|unknown_x/i);
			}
		}
	});

	it("스크립트에서 툴 호출과 리터럴 인자를 읽는다", () => {
		assert.deepEqual(
			parseCodemodeCalls(`const r = await tools.market_price({ symbol: "NVDA" });\nconst n = await tools["market_news"]({query:'나스닥', limit: 5});`),
			[
				{ name: "market_price", args: { symbol: "NVDA" } },
				{ name: "market_news", args: { query: "나스닥", limit: 5 } },
			],
		);
		// 변수 인자는 버린다 — 지어내지 않는다
		assert.deepEqual(parseCodemodeCalls("for (const s of xs) await tools.market_price({ symbol: s })"), [{ name: "market_price", args: {} }]);
		assert.deepEqual(parseCodemodeCalls(42), []);
	});

	it("같은 동작이면 대상을 모은다", () => {
		const c = code(["NVDA", "AAPL", "TSLA", "MSFT"].map((s) => `await tools.market_price({symbol: "${s}"})`).join(";"));
		assert.equal(toolLabelText("codemode", c, "running"), "시세 조회 · NVDA, AAPL 외 2건");
		assert.equal(toolLabelText("codemode", code(`await tools.market_price({symbol:"NVDA"})`), "done"), "시세 조회 · NVDA");
		assert.equal(toolLabelText("codemode", code(`await tools.market_price({symbol:"NVDA"})`), "error"), "시세 조회 실패 · NVDA");
	});

	it("다른 동작이 섞이면 동작을 나열한다", () => {
		const c = code(`await tools.market_price({symbol:"NVDA"}); await tools.market_news({query:"x"}); await tools.web_search({query:"y"})`);
		assert.equal(toolLabelText("codemode", c, "done"), "시세 조회 · 뉴스 검색 외 1건");
		assert.equal(toolLabelText("codemode", code(`tools.market_price({symbol:"A"}); tools.market_news({})`), "error"), "시세 조회 · 뉴스 검색 실패");
	});

	it("실제로 부른 툴(calls)이 있으면 그걸 쓴다", () => {
		assert.equal(
			toolLabelText("codemode", code("const x = helper(); return x"), "done", [
				{ name: "portfolio_holdings", args: {} },
				{ name: "portfolio_holdings", args: {} },
			]),
			"보유 종목 불러오기",
		);
	});

	it("툴 호출을 못 찾으면 중립 문구", () => {
		assert.equal(toolLabelText("codemode", code("return 1 + 1"), "done"), "데이터 조회·계산");
		assert.equal(toolLabelText("codemode", undefined, "running"), "데이터 조회·계산");
		assert.equal(toolLabelText("codemode", code("await tools.mystery({})"), "done"), "도구 실행");
		assert.equal(toolLabelText("codemode", code(`return await searchTools("price")`), "done"), "사용할 기능 찾기");
		assert.equal(toolLabelText("tool_search", { query: "select:market_price" }, "done"), "사용할 기능 찾기");
	});
});
