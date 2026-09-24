/**
 * 읽기 전용 정책 — 외부 MCP 툴 중 모델이 부를 수 있는 것만 고른다.
 *
 * 원칙은 증권 게이트웨이와 같다: 에이전트는 **조회만**. 외부 계정의 상태를 바꾸는 툴(알림 생성·삭제,
 * 관심목록 추가·삭제 등)은 확인 카드 경로가 없으므로 아예 부르지 않는다 — 목록에는 "차단" 으로만 보인다.
 * 모델 입력(뉴스·웹 본문의 프롬프트 주입)으로 남의 계정이 바뀌는 일을 구조적으로 막는다.
 *
 *   - 프리셋(TradingView)은 **명시 허용목록** — 이름을 아는 서버는 추측하지 않는다. 새 툴이 생기면 목록 밖이라 차단된다
 *   - 그 외 서버는 이름으로 판정: 쓰기 동사가 하나라도 있으면 차단 → readOnlyHint → 읽기 동사 → 나머지는 차단 (모르면 막는다)
 */
import type { McpTool } from "./client.ts";

export interface McpPreset {
	id: string;
	name: string;
	url: string;
	auth: "oauth";
	/** 읽기 툴 허용목록 (정확한 이름) */
	allow: readonly string[];
	/** 모델에게 보여 줄 역할 안내 — 기존 KIS·토스·네이버 툴과 겹치는 영역을 피한다 */
	role: string;
}

/**
 * TradingView 공식 MCP (35개, 2026-09-23 목록 기준).
 * 쓰기 12개(알림 생성·수정·삭제·중지·재시작, 관심목록 생성·수정·추가·제거·삭제)는 목록에 없다.
 */
export const TRADINGVIEW: McpPreset = {
	id: "tradingview",
	name: "TradingView",
	url: "https://mcp.tradingview.com/mcp",
	auth: "oauth",
	allow: [
		"mcp-tv-get-economic-calendar",
		"mcp-tv-get-economic-data",
		"mcp-tv-get-economic-symbols",
		"mcp-tv-get-earnings-calendar",
		"mcp-tv-get-dividends-calendar",
		"mcp-tv-run-screener",
		"mcp-tv-get-screener-columns",
		"mcp-tv-get-symbol-data",
		"mcp-tv-get-symbol-data-batch",
		"mcp-tv-search-symbols",
		"mcp-tv-get-financials",
		"mcp-tv-get-financial-history",
		"mcp-tv-get-forecasts",
		"mcp-tv-get-technicals-rating",
		"mcp-tv-get-documents",
		"mcp-tv-get-document-view",
		"mcp-tv-get-ohlcv",
		"mcp-tv-get-news",
		"mcp-tv-get-news-story",
		"mcp-tv-list-alerts",
		"mcp-tv-get-alerts",
		"mcp-tv-get-alerts-log",
		"mcp-watchlist-list-watchlists",
		"mcp-watchlist-get-watchlist",
		"mcp-watchlist-get-active-watchlist",
	],
	role:
		"경제 캘린더·실적/배당 캘린더·스크리너·해외 종목 재무·애널리스트 예측치·기술 평가(참고용)·SEC 공시/실적 발표 원문·내 TradingView 알림·관심목록 조회. " +
		"시세·일봉·국내 뉴스는 KIS·토스·네이버 전용 툴이 먼저다.",
};

export const PRESETS: Readonly<Record<string, McpPreset>> = { [TRADINGVIEW.id]: TRADINGVIEW };

/** 이름을 단어로 — kebab·snake·점·camelCase 모두 */
export function nameWords(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

const WRITE_WORDS = new Set([
	"create", "update", "delete", "del", "remove", "rm", "add", "insert", "set", "put", "post", "patch", "send", "write",
	"edit", "modify", "change", "rename", "move", "copy", "upload", "publish", "submit", "approve", "reject",
	"start", "stop", "restart", "pause", "resume", "enable", "disable", "activate", "deactivate", "toggle",
	"cancel", "execute", "exec", "run", "invoke", "trigger", "schedule", "subscribe", "unsubscribe",
	"order", "trade", "buy", "sell", "transfer", "withdraw", "deposit", "pay", "swap", "mint", "burn",
	"archive", "restore", "reset", "revoke", "grant", "invite", "share", "sync", "import", "clear", "purge",
	"save", "store", "mark", "assign", "close", "open", "merge", "commit", "push", "deploy", "install",
]);

const READ_WORDS = new Set([
	"get", "list", "search", "find", "fetch", "read", "query", "lookup", "describe", "show", "view", "browse",
	"retrieve", "inspect", "info", "status", "count", "summarize", "summary", "resolve", "explain",
]);

export type Verdict = { allowed: true } | { allowed: false; reason: string };

export function judgeTool(tool: Pick<McpTool, "name" | "annotations">, preset?: McpPreset): Verdict {
	if (preset) {
		return preset.allow.includes(tool.name) ? { allowed: true } : { allowed: false, reason: "허용목록 밖 (읽기 전용만)" };
	}
	const words = nameWords(tool.name);
	const write = words.find((w) => WRITE_WORDS.has(w));
	if (write) return { allowed: false, reason: `쓰기 동작 (${write})` };
	if (tool.annotations?.destructiveHint === true) return { allowed: false, reason: "서버가 파괴적 동작으로 표시" };
	if (tool.annotations?.readOnlyHint === true) return { allowed: true };
	if (words.some((w) => READ_WORDS.has(w))) return { allowed: true };
	return { allowed: false, reason: "읽기 툴인지 알 수 없음" };
}
