/**
 * 읽기/쓰기 판정 — 모델이 바로 부를 수 있는 툴(읽기)과 사람의 확인이 필요한 툴(그 외 전부)을 가른다 (PLAN §38·§39).
 *
 * 원칙은 주문과 같다: 에이전트는 **조회만 직접** 한다. 외부 계정의 상태를 바꾸는 툴(알림 생성·삭제, 관심목록 추가·삭제 등)은
 * 준비만 하고 확인 카드를 띄운다 — 사람이 [확인] 을 눌러야 실행된다. 뉴스·웹 본문에 심긴 지시문으로 계정이 바뀌는 일을 막는다.
 *
 *   - 프리셋(TradingView)은 **명시 읽기 목록** — 이름을 아는 서버는 추측하지 않는다. 목록 밖(쓰기·새로 생긴 툴)은 전부 확인
 *   - 그 외 서버는 이름으로 판정: 쓰기 동사·destructiveHint → 확인, readOnlyHint·읽기 동사 → 읽기, 나머지(모르는 것)는 확인
 */
import type { McpTool } from "./client.ts";

/** TradingView 가격 알림 조건 (규격 설명에만 적혀 있다 — enum 없음) */
const TV_CONDITIONS: Readonly<Record<string, string>> = {
	cross: "교차 (위·아래 어느 쪽이든)",
	cross_up: "위로 돌파",
	cross_down: "아래로 이탈",
	greater: "이상",
	less: "이하",
};
const TV_RESOLUTIONS: Readonly<Record<string, string>> = {
	"1": "1분", "3": "3분", "5": "5분", "15": "15분", "30": "30분", "45": "45분",
	"60": "1시간", "120": "2시간", "180": "3시간", "240": "4시간",
	"1D": "일봉", D: "일봉", "1W": "주봉", W: "주봉", "1M": "월봉", M: "월봉",
};

export interface SummaryLine {
	label: string;
	value: string;
}

/**
 * TradingView 알림 응답(create·update 는 알림 전체, get 은 { alerts: [...] }) → 요약 줄.
 * 알림 모양이 아니면 null (일반 요약으로).
 */
function summarizeTvAlert(data: unknown): SummaryLine[] | null {
	const obj = data as Record<string, unknown> | null;
	const alert = (Array.isArray(obj?.alerts) && obj.alerts.length === 1 ? obj.alerts[0] : obj) as Record<string, unknown> | null;
	if (!alert || typeof alert !== "object" || alert.alert_id === undefined) return null;
	const out: SummaryLine[] = [{ label: "알림 id", value: String(alert.alert_id) }];
	if (typeof alert.name === "string" && alert.name) out.push({ label: "이름", value: alert.name });
	if (typeof alert.symbol === "string") out.push({ label: "종목", value: alert.symbol });
	const cond = alert.condition as { type?: string; series?: Array<{ type?: string; value?: unknown }> } | undefined;
	if (cond?.type) {
		const value = cond.series?.find((s) => s.type === "value")?.value;
		const how = TV_CONDITIONS[cond.type] ?? cond.type;
		out.push({ label: "조건", value: value !== undefined ? `${Number(value).toLocaleString("en-US")} ${how}` : how });
	}
	if (typeof alert.active === "boolean") out.push({ label: "상태", value: alert.active ? "켜짐" : "꺼짐" });
	if (typeof alert.expiration === "string" && alert.expiration) out.push({ label: "만료", value: kstTime(alert.expiration) });
	const via = [
		alert.mobile_push === true && "모바일 푸시",
		alert.popup === true && "팝업",
		alert.email === true && "이메일",
		(alert.has_webhook === true || (typeof alert.webhook === "string" && alert.webhook)) && "웹훅",
	].filter(Boolean);
	if (via.length) out.push({ label: "알림 방법", value: via.join(" · ") });
	if (alert.auto_deactivate === true) out.push({ label: "반복", value: "한 번 울리면 꺼짐" });
	return out;
}

/** ISO 시각 → "2026-10-31 15:00 (KST)" — 해석이 안 되면 원문 */
function kstTime(iso: string): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	const k = new Date(t + 9 * 3600_000).toISOString();
	return `${k.slice(0, 10)} ${k.slice(11, 16)} (KST)`;
}

export interface McpPreset {
	id: string;
	name: string;
	url: string;
	auth: "oauth";
	/** 바로 부를 수 있는 읽기 툴 (정확한 이름). 여기 없는 툴은 전부 확인 카드 */
	allow: readonly string[];
	/** 쓰기 툴의 한글 이름 — 확인 카드 제목 */
	writeLabels: Readonly<Record<string, string>>;
	/** 확인 카드의 인자 이름 (한글) */
	argLabels?: Readonly<Record<string, string>>;
	/** 확인 카드의 값 표시 — null 이면 원래 값 그대로 */
	formatArg?: (tool: string, name: string, value: unknown) => string | null;
	/** 카드를 만들기 전 검사 — 규격이 설명으로만 적어 둔 규칙 (틀리면 모델이 고쳐서 다시 준비) */
	validate?: (tool: string, args: Record<string, unknown>) => string | null;
	/** 카드에 붙일 안내 (생략한 값의 기본값 등) */
	notes?: Readonly<Record<string, string>>;
	/** 카드에 붙일 경고 — 외부로 데이터가 나가는 설정 등 */
	warn?: (tool: string, args: Record<string, unknown>) => string[];
	/** 카드의 인자 순서 (없는 이름은 뒤에 원래 순서로) */
	argOrder?: readonly string[];
	/** 실행 결과(JSON) → 사람이 볼 요약 줄. null 이면 일반 요약 */
	summarize?: (tool: string, data: unknown) => SummaryLine[] | null;
	/** 모델에게 보여 줄 역할 안내 — 기존 KIS·토스·네이버 툴과 겹치는 영역을 피한다 */
	role: string;
}

/**
 * TradingView 공식 MCP (35개, 2026-09-23 목록 기준).
 * 읽기 25개는 바로, 쓰기 10개(알림 생성·수정·삭제·중지·재시작, 관심목록 생성·수정·추가·제거·삭제)는 확인 카드.
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
	writeLabels: {
		"mcp-tv-create-alert": "TradingView 알림 만들기",
		"mcp-tv-update-alert": "TradingView 알림 수정",
		"mcp-tv-delete-alert": "TradingView 알림 삭제",
		"mcp-tv-stop-alerts": "TradingView 알림 일시 중지",
		"mcp-tv-restart-alerts": "TradingView 알림 다시 켜기",
		"mcp-watchlist-create-watchlist": "관심목록 만들기",
		"mcp-watchlist-update-watchlist": "관심목록 이름·설명 바꾸기",
		"mcp-watchlist-add-to-watchlist": "관심목록에 종목 추가",
		"mcp-watchlist-remove-from-watchlist": "관심목록에서 종목 빼기",
		"mcp-watchlist-delete-watchlist": "관심목록 삭제",
	},
	argLabels: {
		symbol: "종목",
		symbols: "종목들",
		price: "가격",
		condition: "조건",
		message: "알림 메시지",
		name: "이름",
		description: "설명",
		resolution: "차트 주기",
		expiration: "만료",
		auto_deactivate: "한 번 울리면 끄기",
		email: "이메일",
		mobile_push: "모바일 푸시",
		popup: "팝업",
		webhook: "웹훅 주소",
		monitor: "모니터링 웹훅",
		conditions: "원시 조건",
		alert_id: "알림 id",
		alert_ids: "알림 id",
		watchlist_id: "관심목록 id",
	},
	formatArg: (_tool, name, value) => {
		if (typeof value === "boolean") return value ? "켬" : "끔";
		if (name === "condition" && typeof value === "string") return TV_CONDITIONS[value] ? `${TV_CONDITIONS[value]} (${value})` : null;
		if (name === "resolution" && typeof value === "string") return TV_RESOLUTIONS[value] ? `${TV_RESOLUTIONS[value]} (${value})` : null;
		if (name === "expiration" && typeof value === "string" && value) return kstTime(value);
		return null;
	},
	validate: (tool, args) => {
		if (tool !== "mcp-tv-create-alert") return null;
		const symbol = args.symbol;
		if (typeof symbol !== "string" || !/^[A-Z0-9_.!]+:[A-Z0-9_.!/&-]+$/i.test(symbol)) {
			return `symbol 은 EXCHANGE:TICKER 형식이어야 합니다 (예: NASDAQ:AAPL, KRX:005930) — 모르면 mcp-tv-search-symbols 로 찾으세요`;
		}
		if (args.conditions != null) return null; // 원시 조건은 서버가 검사한다
		if (typeof args.price !== "number" || !Number.isFinite(args.price) || args.price <= 0) return "price(0보다 큰 숫자)가 필요합니다";
		if (args.condition !== undefined && !(typeof args.condition === "string" && args.condition in TV_CONDITIONS)) {
			return `condition 은 ${Object.keys(TV_CONDITIONS).join(" · ")} 중 하나입니다`;
		}
		if (typeof args.expiration === "string" && Number.isNaN(Date.parse(args.expiration))) return "expiration 은 ISO 시각이어야 합니다 (예: 2026-10-31T15:00:00+09:00)";
		return null;
	},
	notes: {
		"mcp-tv-create-alert": "생략한 값은 TradingView 기본값 — 조건 교차(어느 방향이든), 차트 주기 1분, 만료 30일 뒤, 모바일 푸시·팝업 켬. 알림은 주문이 아닙니다.",
		"mcp-tv-update-alert": "조건·종목·차트 주기는 바꿀 수 없습니다 (지우고 새로 만들어야 한다). 수정하면 알림이 다시 켜집니다.",
	},
	argOrder: ["alert_id", "alert_ids", "watchlist_id", "symbol", "symbols", "condition", "price", "name", "description", "message", "resolution", "expiration", "auto_deactivate", "mobile_push", "popup", "email", "webhook", "monitor", "conditions"],
	summarize: (_tool, data) => summarizeTvAlert(data),
	warn: (_tool, args) => [
		...(typeof args.webhook === "string" && args.webhook ? [`알림이 울리면 이 주소로 데이터가 전송됩니다: ${args.webhook} — 직접 입력한 주소가 맞는지 확인하세요.`] : []),
		...(args.monitor === true ? ["모니터링 웹훅을 켭니다 (알림이 울리면 TradingView 가 분석용으로 외부에 전송)."] : []),
		...(Array.isArray(args.conditions) ? ["원시 조건(conditions)이 price·condition 을 덮어씁니다."] : []),
	],
	role:
		"경제 캘린더·실적/배당 캘린더·스크리너·해외 종목 재무·애널리스트 예측치·기술 평가(참고용)·SEC 공시/실적 발표 원문·내 TradingView 알림·관심목록 조회. " +
		"시세·일봉·국내 뉴스는 KIS·토스·네이버 전용 툴이 먼저다.",
};

/** 인자 값이 외부 주소면 카드에 알린다 (프리셋 없는 서버 포함) */
export function urlWarnings(args: Record<string, unknown>): string[] {
	const out: string[] = [];
	const walk = (v: unknown, path: string): void => {
		if (typeof v === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(v.trim())) out.push(`${path} 에 외부 주소가 있습니다: ${v.trim().slice(0, 200)}`);
		else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
		else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
	};
	for (const [k, v] of Object.entries(args)) walk(v, k);
	return out;
}

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

/** 되돌리기 어려운 동작 — 카드를 경고색으로 */
const DESTRUCTIVE_WORDS = new Set(["delete", "del", "remove", "rm", "purge", "clear", "destroy", "drop", "erase", "wipe", "revoke", "reset"]);

export type Verdict =
	| { mode: "read" }
	/** 사람이 확인 카드에서 눌러야 실행 */
	| { mode: "confirm"; reason: string; destructive: boolean; label: string | null };

export function judgeTool(tool: Pick<McpTool, "name" | "annotations">, preset?: McpPreset): Verdict {
	const words = nameWords(tool.name);
	const destructive = tool.annotations?.destructiveHint === true || words.some((w) => DESTRUCTIVE_WORDS.has(w));
	if (preset) {
		if (preset.allow.includes(tool.name)) return { mode: "read" };
		const label = preset.writeLabels[tool.name];
		return label
			? { mode: "confirm", reason: "쓰기", destructive, label }
			: { mode: "confirm", reason: "목록에 없는 툴 (새로 생긴 툴 — 무엇을 하는지 확인)", destructive, label: null };
	}
	const write = words.find((w) => WRITE_WORDS.has(w));
	if (write) return { mode: "confirm", reason: `쓰기 동작 (${write})`, destructive, label: null };
	if (tool.annotations?.destructiveHint === true) return { mode: "confirm", reason: "서버가 파괴적 동작으로 표시", destructive: true, label: null };
	if (tool.annotations?.readOnlyHint === true) return { mode: "read" };
	if (words.some((w) => READ_WORDS.has(w))) return { mode: "read" };
	return { mode: "confirm", reason: "읽기 툴인지 알 수 없음", destructive, label: null };
}
