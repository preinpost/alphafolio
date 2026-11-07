/**
 * 툴 진행 줄 문구 — "<무엇> · <대상>", 비유 없이.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { humanizeToolName, KNOWN_TOOLS, toolLabel, toolLabelText } from "../src/lib/toolLabel.ts";

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
	"mcp_call",
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

	it("모르는 툴은 이름을 풀어 쓴다", () => {
		assert.equal(humanizeToolName("someNew_tool"), "some new tool");
		assert.equal(toolLabelText("someNew_tool", { x: 1 }, "done"), "some new tool");
		assert.equal(toolLabelText("market_price", null, "done"), "시세 조회");
	});
});
