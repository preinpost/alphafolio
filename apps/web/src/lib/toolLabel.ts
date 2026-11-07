/**
 * 툴 진행 줄의 문구 — "<무엇> · <대상>".
 *
 * 비유 없이 실제 하는 일을 쓴다 (예: "시세 조회 · NVDA", "웹 검색 · '어제 미국 증시'").
 * 대상은 툴 인자에서만 뽑는다 — 인자에 없는 정보(종목명 등)는 지어내지 않는다.
 */

/** stopped — 턴이 끝났는데 결과가 없다 (중지 등) */
export type ToolState = "running" | "done" | "error" | "stopped";

export interface ToolLabel {
	/** 하는 일 (예: "시세 조회") */
	action: string;
	/** 대상 (예: "NVDA") — 없으면 생략 */
	target?: string;
}

type Args = Record<string, unknown>;

const TARGET_MAX = 40;

function str(v: unknown): string | undefined {
	if (typeof v === "string") {
		const s = v.trim().replace(/\s+/g, " ");
		return s || undefined;
	}
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	return undefined;
}

function clip(s: string): string {
	return s.length > TARGET_MAX ? `${s.slice(0, TARGET_MAX - 1)}…` : s;
}

function quoted(s: string | undefined): string | undefined {
	return s ? `'${s}'` : undefined;
}

/** 종목명이 인자에 있으면 "삼성전자(005930)", 없으면 코드만 */
function symbolOf(a: Args): string | undefined {
	const symbol = str(a.symbol);
	const name = str(a.name);
	if (symbol && name && name !== symbol) return `${name}(${symbol})`;
	return symbol ?? name;
}

function join(...parts: (string | undefined)[]): string | undefined {
	const s = parts.filter(Boolean).join(" ");
	return s || undefined;
}

const SIDE: Record<string, string> = { BUY: "매수", SELL: "매도" };

const PERIOD: Record<string, string> = {
	today: "오늘",
	yesterday: "어제",
	this_week: "이번 주",
	this_month: "이번 달",
	last_month: "지난달",
	last_7d: "최근 7일",
	last_30d: "최근 30일",
	this_year: "올해",
};

function periodOf(a: Args): string | undefined {
	const p = str(a.period);
	if (p) return PERIOD[p] ?? p;
	const from = str(a.from);
	const to = str(a.to);
	if (from && to) return `${from}~${to}`;
	return from ?? to ?? str(a.month);
}

const MOVERS: Record<string, string> = {
	trading_amount: "거래대금 상위",
	trading_volume: "거래량 상위",
	gainers: "상승률 상위",
	losers: "하락률 상위",
};

function firstQuery(a: Args): string | undefined {
	const q = str(a.query);
	if (q) return quoted(q);
	if (Array.isArray(a.queries)) {
		const qs = a.queries.map(str).filter((x): x is string => !!x);
		if (qs.length === 1) return quoted(qs[0]);
		if (qs.length > 1) return `${quoted(qs[0])} 외 ${qs.length - 1}건`;
	}
	return undefined;
}

function urlTarget(a: Args): string | undefined {
	const host = (u: string): string => {
		try {
			return new URL(u).host.replace(/^www\./, "");
		} catch {
			return u;
		}
	};
	const u = str(a.url);
	if (u) return host(u);
	if (Array.isArray(a.urls)) {
		const us = a.urls.map(str).filter((x): x is string => !!x);
		if (us.length === 1) return host(us[0]!);
		if (us.length > 1) return `${host(us[0]!)} 외 ${us.length - 1}건`;
	}
	return undefined;
}

/** action 인자로 동작이 갈리는 툴 */
function byAction(a: Args, map: Record<string, string>, fallback: string): string {
	const act = str(a.action);
	return (act && map[act]) || fallback;
}

type Labeler = (a: Args) => ToolLabel;

const LABELERS: Record<string, Labeler> = {
	// 시세·분석
	market_price: (a) => ({ action: "시세 조회", target: symbolOf(a) }),
	market_technical: (a) => ({ action: "기술적 분석", target: symbolOf(a) }),
	market_timing: (a) => ({ action: "매매 타점 분석", target: symbolOf(a) }),
	market_financials: (a) => ({ action: "재무·실적 조회", target: symbolOf(a) }),
	stock_research: (a) => ({ action: "종목 리서치", target: symbolOf(a) }),
	market_movers: (a) => ({
		action: "시장 순위 조회",
		target: join(a.market === "US" ? "미국" : a.market === "KR" ? "국내" : undefined, MOVERS[str(a.type) ?? ""]),
	}),
	market_news: (a) => ({ action: "뉴스 검색", target: str(a.query) }),
	market_overseas_news: (a) => ({ action: "해외 뉴스 조회", target: symbolOf(a) }),
	derivatives_greeks: (a) => ({ action: "옵션 그릭스 계산", target: str(a.code) }),
	kis_stream: (a) => {
		const subs = Array.isArray(a.subscribe) ? a.subscribe : [];
		const keys = subs.map((s) => (s && typeof s === "object" ? str((s as Args).key) : undefined)).filter(Boolean);
		if (keys.length) return { action: "실시간 시세 받기", target: keys.join(", ") };
		return { action: "실시간 시세 찾기", target: quoted(str(a.find)) };
	},

	// 범용 조회 게이트웨이
	kis_find: (a) => ({ action: "한국투자증권 API 찾기", target: quoted(str(a.query)) ?? str(a.api) }),
	kis_call: (a) => ({ action: "한국투자증권 조회", target: str(a.api) }),
	toss_query: (a) => ({ action: "토스증권 조회", target: str(a.api) }),
	data_find: (a) => ({ action: "데이터 API 찾기", target: join(str(a.provider), quoted(str(a.query)) ?? str(a.api)) }),
	data_call: (a) => ({ action: "데이터 조회", target: join(str(a.provider), str(a.api)) }),

	// 계좌·자산
	portfolio_holdings: () => ({ action: "보유 종목 불러오기" }),
	portfolio_signals: () => ({ action: "보유 종목 점검" }),
	finance_overview: (a) => ({ action: "자산 현황 조회", target: periodOf(a) }),

	// 주문
	order_prepare: (a) => ({ action: "주문 준비", target: join(symbolOf(a), SIDE[str(a.side) ?? ""]) }),
	order_list: (a) => ({ action: "주문 내역 조회", target: a.status === "OPEN" ? "미체결" : a.status === "CLOSED" ? "체결" : undefined }),
	order_change: (a) => ({ action: a.action === "cancel" ? "주문 취소 준비" : "주문 정정 준비", target: str(a.orderId) }),
	order_conditional: (a) => ({ action: "조건주문 취소 준비", target: str(a.conditionalOrderId) }),

	// 감시·자동매매
	watch_alert: (a) => ({
		action: byAction(a, { prepare: "감시 알림 만들기", protect: "손절·익절 설정", list: "감시 알림 목록", pause: "감시 알림 끄기" }, "감시 알림"),
		target: a.action === "list" ? undefined : (str(a.name) ?? symbolOf(a) ?? str(a.id)),
	}),
	range_trade: (a) => ({
		action: byAction(a, { prepare: "박스권 매매 만들기", list: "박스권 매매 목록", pause: "박스권 매매 끄기" }, "박스권 매매"),
		target: a.action === "list" ? undefined : (str(a.name) ?? symbolOf(a) ?? str(a.id)),
	}),

	// Binance
	binance_wallet: (a) => ({
		action: a.action === "transfer" ? "바이낸스 지갑 이체 준비" : "바이낸스 잔고 조회",
		target: a.action === "transfer" ? join(str(a.asset), str(a.amount)) : undefined,
	}),
	binance_order: (a) => ({
		action: byAction(
			a,
			{ place: "바이낸스 주문 준비", cancel: "바이낸스 주문 취소 준비", replace: "바이낸스 주문 정정 준비", oco: "바이낸스 OCO 주문 준비", oto: "바이낸스 OTO 주문 준비", cancel_all: "바이낸스 전체 취소 준비" },
			"바이낸스 주문",
		),
		target: join(str(a.symbol), SIDE[str(a.side) ?? ""]),
	}),
	binance_futures: (a) => ({
		action: byAction(
			a,
			{
				account: "바이낸스 선물 계좌 조회",
				history: "바이낸스 선물 내역 조회",
				open: "바이낸스 선물 진입 준비",
				close: "바이낸스 선물 청산 준비",
				tpsl: "바이낸스 선물 익절·손절 준비",
				cancel: "바이낸스 선물 주문 취소 준비",
				cancel_all: "바이낸스 선물 전체 취소 준비",
				settings: "바이낸스 선물 설정",
			},
			"바이낸스 선물",
		),
		target: str(a.symbol),
	}),
	binance_stock_account: (a) => ({ action: "바이낸스 미국주식 계좌 조회", target: str(a.symbols) }),
	binance_stock_order: (a) => ({
		action: a.action === "cancel" ? "바이낸스 미국주식 주문 취소 준비" : "바이낸스 미국주식 주문 준비",
		target: join(str(a.symbol), SIDE[str(a.side) ?? ""]),
	}),

	// 가계부
	ledger_add: (a) => ({ action: "가계부 기록", target: join(str(a.merchant) ?? str(a.category), typeof a.amount === "number" ? `${a.amount.toLocaleString("ko-KR")}원` : undefined) }),
	ledger_list: (a) => ({ action: "가계부 내역 조회", target: join(periodOf(a), str(a.category)) }),
	ledger_summary: (a) => ({ action: "가계부 집계", target: periodOf(a) }),
	ledger_update: () => ({ action: "가계부 수정" }),
	ledger_delete: (a) => ({ action: a.confirm === true ? "가계부 삭제" : "가계부 삭제 미리보기" }),
	ledger_budget: (a) => ({ action: a.action === "set" ? "예산 설정" : "예산 현황 조회", target: join(str(a.month), str(a.category)) }),

	// 매매일지
	journal_add: (a) => ({ action: "매매일지 기록", target: join(symbolOf(a), SIDE[str(a.side) ?? ""]) }),
	journal_update: () => ({ action: "매매일지 수정" }),
	journal_list: (a) => ({ action: "매매일지 조회", target: symbolOf(a) ?? periodOf(a) }),

	// 웹 (pi-web-access 확장)
	web_enable: () => ({ action: "웹 검색 준비" }),
	web_search: (a) => ({ action: "웹 검색", target: firstQuery(a) }),
	fetch_content: (a) => ({ action: "웹 페이지 읽기", target: urlTarget(a) }),
	get_search_content: (a) => ({ action: "검색 결과 본문 읽기", target: quoted(str(a.query)) ?? urlTarget(a) }),
	code_search: (a) => ({ action: "코드 검색", target: firstQuery(a) }),
	source_check: (a) => ({ action: "출처 확인", target: quoted(str(a.claim)) ?? firstQuery(a) }),

	// pi 메타 툴 — 툴을 찾거나 스크립트로 다른 툴을 부른다. 내부 이름(검색어 "select:…" 등)은 내보내지 않는다
	tool_search: () => ({ action: "사용할 기능 찾기" }),

	// 외부 MCP — 서버·툴 이름 그대로
	mcp_call: (a) => {
		const server = str(a.server);
		const tool = str(a.tool);
		if (!tool) return { action: "외부 도구 목록 조회", target: server };
		return { action: a.describe === true ? "외부 도구 확인" : "외부 도구 실행", target: server ? `${server} / ${tool}` : tool };
	},
};

/** 모르는 툴 — 내부 이름은 보여주지 않는다 */
export const UNKNOWN_ACTION = "도구 실행";

/** 스크립트로 다른 툴을 부르는 메타 툴 (pi codemode) — 안에서 부르는 툴로 문구를 만든다 */
export const CODEMODE_TOOL = "codemode";
const CODEMODE_GENERIC = "데이터 조회·계산";
const DISCOVERY = "사용할 기능 찾기";

/** codemode 안에서 실제로 부른 툴 (서버가 결과 details.calls 에서 넘긴다) */
export interface InnerCall {
	name: string;
	args: unknown;
}

/** JS 문자열·숫자 리터럴 하나 */
const LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$\\]*`|-?\d+(?:\.\d+)?/.source;
const CALL_RE = /\btools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["'`]([A-Za-z_$][\w$]*)["'`]\s*\])\s*\(\s*(\{[^{}]*\})?/g;
const PROP_RE = new RegExp(String.raw`([A-Za-z_$][\w$]*|"[^"]*"|'[^']*')\s*:\s*(${LITERAL}|\[(?:\s*(?:${LITERAL})\s*,?)*\])`, "g");

function literalValue(src: string): unknown {
	const t = src.trim();
	if (t.startsWith("[")) {
		const items = [...t.matchAll(new RegExp(LITERAL, "g"))].map((m) => literalValue(m[0]));
		return items;
	}
	if (/^["'`]/.test(t)) return t.slice(1, -1).replace(/\\(.)/g, "$1");
	const n = Number(t);
	return Number.isFinite(n) ? n : undefined;
}

/** 객체 리터럴에서 문자열·숫자 값만 뽑는다 (변수·식은 버린다 — 지어내지 않는다) */
function literalArgs(obj: string | undefined): Args {
	const out: Args = {};
	if (!obj) return out;
	for (const m of obj.matchAll(PROP_RE)) {
		const key = m[1]!.replace(/^["']|["']$/g, "");
		const v = literalValue(m[2]!);
		if (v !== undefined) out[key] = v;
	}
	return out;
}

/** codemode 스크립트에서 `tools.<이름>({...})` 호출을 정적으로 찾는다 */
export function parseCodemodeCalls(code: unknown): InnerCall[] {
	if (typeof code !== "string") return [];
	const calls: InnerCall[] = [];
	for (const m of code.matchAll(CALL_RE)) {
		calls.push({ name: (m[1] ?? m[2])!, args: literalArgs(m[3]) });
	}
	return calls;
}

function summarize(labels: ToolLabel[]): ToolLabel | undefined {
	if (labels.length === 0) return undefined;
	const actions = [...new Set(labels.map((l) => l.action))];
	if (actions.length === 1) {
		const targets = [...new Set(labels.map((l) => l.target).filter((t): t is string => !!t))];
		if (targets.length === 0) return { action: actions[0]! };
		const shown = targets.slice(0, 2).join(", ");
		return { action: actions[0]!, target: targets.length > 2 ? `${shown} 외 ${targets.length - 2}건` : shown };
	}
	const shown = actions.slice(0, 2).join(" · ");
	return { action: actions.length > 2 ? `${shown} 외 ${actions.length - 2}건` : shown };
}

function codemodeLabel(a: Args, calls?: readonly InnerCall[]): ToolLabel {
	const inner = calls && calls.length > 0 ? calls : parseCodemodeCalls(a.code);
	const labels = inner
		.filter((c) => c.name !== CODEMODE_TOOL)
		.map((c) => toolLabel(c.name, c.args));
	// 아는 툴이 하나라도 있으면 모르는 툴("도구 실행")은 빼고 요약한다
	const known = labels.filter((l) => l.action !== UNKNOWN_ACTION);
	const summary = summarize(known.length > 0 ? known : labels);
	if (summary) return summary;
	if (typeof a.code === "string" && /\b(searchTools|describeTool|describeNamespace|ALL_TOOLS)\b/.test(a.code)) return { action: DISCOVERY };
	return { action: CODEMODE_GENERIC };
}

/**
 * calls — codemode 안에서 실제로 부른 툴 (끝난 뒤 서버가 넘긴다). 없으면 스크립트를 읽어 짐작한다.
 */
export function toolLabel(name: string, args: unknown, calls?: readonly InnerCall[]): ToolLabel {
	const a: Args = args && typeof args === "object" && !Array.isArray(args) ? (args as Args) : {};
	const key = name.trim();
	const labeler = LABELERS[key];
	const label = key === CODEMODE_TOOL ? codemodeLabel(a, calls) : labeler ? labeler(a) : { action: UNKNOWN_ACTION };
	return label.target ? { action: label.action, target: clip(label.target) } : { action: label.action };
}

/** 화면·aria 에 쓰는 한 줄. 실패·중단이면 동작 뒤에 표시 */
export function toolLabelText(name: string, args: unknown, state: ToolState, calls?: readonly InnerCall[]): string {
	const { action, target } = toolLabel(name, args, calls);
	const head = state === "error" ? `${action} 실패` : state === "stopped" ? `${action} 중단됨` : action;
	return target ? `${head} · ${target}` : head;
}

/** 이름이 등록된 툴인지 — 테스트용 */
export const KNOWN_TOOLS: readonly string[] = [...Object.keys(LABELERS), CODEMODE_TOOL];
