/**
 * 서버 ↔ 클라이언트 공용 프로토콜.
 *
 * 카드(details) 계약이 여기 있는 이유: 툴이 details로 실어 보낸 구조를 UI가 렌더한다.
 * 툴 쪽 타입(@alphafolio/ledger의 LedgerSummaryDetails 등)과 모양이 같아야 하므로
 * 양쪽이 이 파일을 기준으로 맞춘다.
 */

// ── 카드 (툴 결과 details) ──────────────────────────────────────────────

import type { BinanceOrderCard, ConditionalOrderCard, OrderChangeCard } from "./orders.ts";
export type { BinanceOrderCard, ConditionalLegView, ConditionalOrderCard, OrderChangeCard } from "./orders.ts";

export interface LedgerTxCard {
	kind: "ledger-tx";
	/** 실제로 쓴·읽은 가계부 이름 (가계부 분리 이전 세션의 카드에는 없다) */
	ledgerName?: string;
	tx: {
		id: string;
		date: string;
		amount: number;
		category: string | null;
		merchant: string | null;
		memo: string | null;
		account: string | null;
	};
}

export interface LedgerSummaryCard {
	kind: "ledger-summary";
	/** 실제로 쓴·읽은 가계부 이름 (가계부 분리 이전 세션의 카드에는 없다) */
	ledgerName?: string;
	from: string;
	to: string;
	groupBy: "category" | "month" | "member";
	rows: Array<{ key: string; income: number; expense: number; net: number; count: number }>;
}

export interface LedgerTableCard {
	kind: "ledger-table";
	/** 실제로 쓴·읽은 가계부 이름 (가계부 분리 이전 세션의 카드에는 없다) */
	ledgerName?: string;
	rows: Array<{
		id: string;
		date: string;
		amount: number;
		category: string | null;
		merchant: string | null;
	}>;
}

export interface LedgerBudgetCard {
	kind: "ledger-budget";
	/** 실제로 쓴·읽은 가계부 이름 (가계부 분리 이전 세션의 카드에는 없다) */
	ledgerName?: string;
	action: "set" | "status";
	month: string;
	rows: Array<{ category: string; limit_amt: number; spent: number; remaining: number; usedPct: number }>;
}

/**
 * 기술적 지표 카드 — market_technical 결과.
 * 캔들을 그리지 않는다 (차트 UI 를 두지 않기로 한 결정 — PLAN.md §19).
 */
export interface IndicatorSnapshotDto {
	bars: number;
	lastDate: string;
	price: number;
	ma5: number | null;
	ma20: number | null;
	ma60: number | null;
	trend: "정배열" | "역배열" | "혼조";
	rsi: number | null;
	macdHistogram: number | null;
	bollingerUpper: number | null;
	bollingerLower: number | null;
	bollingerPct: number | null;
	atr: number | null;
	atrPct: number | null;
	support: number | null;
	resistance: number | null;
	periodHigh: number;
	periodLow: number;
	periodChangePct: number;
	signals: string[];
}

export interface TechnicalCard {
	kind: "technical-card";
	symbol: string;
	name: string;
	period: string;
	currency: "KRW" | "USD";
	snapshot: IndicatorSnapshotDto | null;
	note?: string;
}

/** 재무·컨센서스 카드 — market_financials 결과 (국내 전용). */
export interface FinancialsCard {
	kind: "financials-card";
	symbol: string;
	name: string;
	periods: Array<{
		period: string;
		revenue: number | null;
		operatingProfit: number | null;
		netIncome: number | null;
		roe: number | null;
		eps: number | null;
		bps: number | null;
		debtRatio: number | null;
	}>;
	consensus: {
		covered: boolean;
		/** 조회 실패 사유 — 있으면 "미커버"라고 말하면 안 된다 */
		error: string | null;
		rating: string | null;
		analyst: string | null;
		estimatedAt: string | null;
	};
	yoy: { revenue: number | null; operatingProfit: number | null; netIncome: number | null } | null;
}

/**
 * 타점 판정 카드 — market_timing 결과.
 * 판정은 규칙 기반이며 매매 권유가 아니다 (카드에 고정 표시).
 */
export interface TimingCard {
	kind: "timing-card";
	symbol: string;
	name: string;
	currency: "KRW" | "USD";
	/** 먼저 보여줄 판정 */
	result: TimingCardResult;
	/** 기간을 정하지 않아 스윙·단기를 둘 다 돌렸을 때 나머지 하나 — 카드에서 전환한다 (없으면 한 모드만) */
	alt?: TimingCardResult;
	notes: string[];
}

export type TimingCardResult = {
	/** 없으면 swing (단기 모드 이전에 저장된 대화) */
	horizon?: "swing" | "short";
	verdict: "매수" | "매도" | "관망";
	summary: string;
	layers: Array<{ name: string; state: "우호" | "비우호" | "중립"; reasons: string[] }>;
	scenarios: Array<{
		id: string;
		title: string;
		trigger: string;
		triggerPrice: number | null;
		action: string;
		weightPct: number;
	}>;
	price: number;
	/** 진입 기준가 — breakout 이면 현재가보다 높다 (돌파 확인 후 진입). 없으면 현재가 */
	entry?: { price: number; type: "now" | "breakout" };
	stopLoss: number | null;
	target1: number | null;
	target2: number | null;
	riskReward: number | null;
	breakeven: number;
	roundTripCostPct: number;
	sizing: { riskPct: number; riskBudgetKrw: number; quantity: number } | null;
	holding: { quantity: number; avgPrice: number; pnlPct: number } | null;
	snapshot: { lastDate: string; bars: number; rsi: number | null; trend: string };
};

/** 리서치 섹션 — 성공 / 조회 실패 / 해당 없음을 구분한다. */
export type ResearchSection<T> =
	| { status: "ok"; data: T }
	| { status: "failed"; error: string }
	| { status: "skipped"; reason: string };

/** 종목 리서치 카드 — stock_research 결과. */
export interface ResearchCard {
	kind: "research-card";
	symbol: string;
	name: string;
	currency: "KRW" | "USD";
	quote: ResearchSection<{
		price: number;
		change: number;
		changePct: number;
		per: number | null;
		pbr: number | null;
		high52: number | null;
		low52: number | null;
		pos52: number | null;
		source: string;
	}>;
	technical: ResearchSection<{
		lastDate: string;
		trend: string;
		rsi: number | null;
		ma20: number | null;
		ma60: number | null;
		support: number | null;
		resistance: number | null;
		periodChangePct: number;
		signals: string[];
	}>;
	financials: ResearchSection<{
		latest: {
			period: string;
			revenue: number | null;
			operatingProfit: number | null;
			netIncome: number | null;
			roe: number | null;
			debtRatio: number | null;
		} | null;
		yoy: { revenue: number | null; operatingProfit: number | null; netIncome: number | null } | null;
		consensus: { covered: boolean; error: string | null; rating: string | null; analyst: string | null; estimatedAt: string | null };
	}>;
	news: ResearchSection<Array<{ title: string; date: string; link: string }>>;
	holding: ResearchSection<{ quantity: number; avgPrice: number; profitPct: number; valueKrw: number } | null>;
}

/** 보유 종목 일괄 점검 카드 — portfolio_signals 결과. */
export interface PortfolioSignalsCard {
	kind: "portfolio-signals-card";
	rows: Array<{
		symbol: string;
		name: string;
		currency: "KRW" | "USD";
		price: number;
		avgPrice: number;
		vsAvgPct: number;
		trend: string;
		rsi: number | null;
		signals: string[];
	}>;
	skipped: string[];
}

/** 현재가 카드 — market_price 결과. */
export interface QuoteCard {
	kind: "quote-card";
	quote: {
		symbol: string;
		name: string;
		market: "domestic" | "overseas";
		exchange?: string;
		currency: "KRW" | "USD";
		price: number;
		change: number;
		changePct: number;
		volume: number | null;
		per: number | null;
		pbr: number | null;
		high52: number | null;
		low52: number | null;
		/** 어느 증권사 시세인지 — 토스는 전일대비를 주지 않아 표시가 달라진다 */
		source: "kis" | "toss";
	};
}

export interface BrokerHolding {
	/** 어느 증권사 계좌인가 (KIS·토스를 함께 쓰면 합산되므로 구분이 필요하다) */
	broker: "kis" | "toss";
	symbol: string;
	name: string;
	market: "domestic" | "overseas";
	currency: "KRW" | "USD";
	quantity: number;
	avgPrice: number;
	price: number;
	value: number;
	profit: number;
	profitPct: number;
	valueKrw: number;
}

/** 보유종목 카드 — portfolio_holdings 결과. */
export interface HoldingsCard {
	kind: "holdings-card";
	holdings: BrokerHolding[];
	/** 실제로 조회에 성공한 증권사 */
	brokers: string[];
	stockValueKrw: number;
	cashKrw: number;
	/** 달러 예수금 (환산 안 함). 이전에 저장된 대화에는 없다 */
	cashUsd?: number;
	profitKrw: number;
	usdKrw: number;
}

/** 시장 랭킹 카드 — market_movers 결과. */
export interface MoversCard {
	kind: "movers-card";
	title: string;
	market: "KR" | "US";
	rankedAt: string | null;
	movers: Array<{
		rank: number;
		symbol: string;
		name: string;
		currency: "KRW" | "USD";
		price: number;
		changePct: number;
		tradingAmount: number;
		tradingVolume: number;
	}>;
}

/** 뉴스 카드 — market_news 결과. */
export interface NewsCard {
	kind: "news-card";
	query: string;
	items: Array<{ title: string; summary: string; link: string; date: string }>;
}

/**
 * 주문 확인 카드 — order_prepare 결과.
 *
 * ⚠️ 이 카드의 [확인] 버튼이 **실제 주문이 나가는 유일한 경로**다.
 *    ok=false 면 token 이 null 이고 errors 만 표시한다.
 */
export interface OrderPreviewCard {
	kind: "order-preview-card";
	ok: boolean;
	token: string | null;
	expiresAt: number | null;
	broker: "toss" | "kis";
	symbol: string;
	name: string;
	side: "BUY" | "SELL";
	orderType: "LIMIT" | "MARKET";
	quantity: number;
	price: number | null;
	estimatedAmount: number;
	currency: "KRW" | "USD";
	warnings: string[];
	errors: string[];
}

export interface BrokerOrder {
	orderId: string;
	symbol: string;
	side: "BUY" | "SELL";
	orderType: "LIMIT" | "MARKET";
	status: string;
	price: string | null;
	quantity: string;
	currency: string;
	orderedAt: string;
	execution?: { filledQuantity: string; averageFilledPrice: string | null };
}

/** 주문 목록 카드 — order_list 결과. */
export interface OrderListCard {
	kind: "order-list-card";
	status: "OPEN" | "CLOSED";
	orders: BrokerOrder[];
}

/** 자산 현황 카드 — finance_overview 결과 (투자 + 가계부). */
export interface OverviewCard {
	kind: "overview-card";
	from: string;
	to: string;
	investKrw: number;
	cashKrw: number;
	cashUsd?: number;
	profitKrw: number;
	income: number;
	expense: number;
	surplus: number;
}

/**
 * 외부 MCP 쓰기 확인 카드 (PLAN §39) — mcp_call 이 쓰기 툴을 **준비만** 한 결과.
 * [확인] 을 눌러야 서버가 그 MCP 서버에 tools/call 을 보낸다 (토큰에 서버·툴·인자가 서명돼 있다).
 */
export interface McpConfirmCard {
	kind: "mcp-confirm-card";
	token: string;
	expiresAt: number;
	/** 서버 이름 (TradingView 등) */
	server: string;
	tool: string;
	/** 한글 동작 이름 (프리셋이 아는 툴만) */
	label: string | null;
	/** 툴 설명 한 줄 (서버가 준 영문 그대로일 수 있다) */
	description: string;
	/** 되돌리기 어려운 동작 (삭제 등) — 경고색 */
	destructive: boolean;
	/** label: 한글 인자 이름 (프리셋이 아는 것만), value: 표시용 (조건·주기는 한글, 시각은 KST) */
	args: Array<{ name: string; label: string | null; value: string; description: string | null }>;
	/** 안내 — 생략한 값의 기본값 등 */
	notes: string[];
	warnings: string[];
}

/**
 * 감시 켜기 확인 카드 (PLAN §40) — watch_alert 가 **준비만** 한 결과. [켜기] 를 눌러야 감시가 시작된다.
 * broker/src/triggers/tool.ts 의 WatchConfirmCard 와 같은 모양.
 */
export interface WatchConfirmCard {
	kind: "watch-confirm-card";
	token: string;
	expiresAt: number;
	name: string;
	/** 조건 한 줄 ("ETHUSDT · 1시간봉 마감 · 종가 < 2,600") */
	text: string;
	/** 배지 — Binance · 국장 · 미장 */
	venue: string;
	/** 프리셋으로 만들었으면 이름 (\"거래량 급증 돌파\") */
	preset?: string | null;
	/** 주식 시세 출처 — 켤 때 고정 (\"KRX 정규장 · 한국투자 (15:30 마감)\") */
	feed?: string | null;
	interval: string;
	limits: { maxFires: number | null; cooldownSec: number; expiresAt: string };
	lastClose: number | null;
	lastBarAt: number | null;
	holdsNow: boolean | null;
	/** 지난 기간에 이 조건이었다면 울렸을 횟수·마지막 몇 번 (at = 봉 마감 시각) */
	preview: { days: number; count: number; recent: Array<{ at: number; close: number }> };
	channels: string[];
	warnings: string[];
}

export type UICard =
	| LedgerTxCard
	| LedgerSummaryCard
	| LedgerTableCard
	| LedgerBudgetCard
	| TechnicalCard
	| PortfolioSignalsCard
	| TimingCard
	| ResearchCard
	| FinancialsCard
	| QuoteCard
	| HoldingsCard
	| MoversCard
	| NewsCard
	| OrderPreviewCard
	| OrderListCard
	| OrderChangeCard
	| ConditionalOrderCard
	| BinanceOrderCard
	| McpConfirmCard
	| WatchConfirmCard
	| OverviewCard;

// ── 메시지 ──────────────────────────────────────────────────────────────

export interface UIToolResult {
	text: string;
	isError: boolean;
	card?: UICard;
}

export type UIContentBlock =
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; args: unknown; result?: UIToolResult }
	| { type: "image"; dataUrl?: string };

export interface UIMessage {
	role: "user" | "assistant" | "custom";
	content: UIContentBlock[];
	errorMessage?: string;
}

// ── WebSocket ───────────────────────────────────────────────────────────

/**
 * 채팅 이미지 첨부 — base64 (data: 접두사 없음).
 * 앱이 긴 변 1600px JPEG 로 줄여서 보낸다. 최대 4장·장당 4MB (서버 images.ts 가 검증).
 */
export interface ImageAttachment {
	mimeType: string;
	data: string;
}

/**
 * 한 소켓은 한 번에 **대화 하나**에 붙는다 (PLAN §24). prompt·steer·abort 는 그 대화에 간다.
 * sessionId 가 null/없음이면 새 대화.
 */
export type ClientMessage =
	| { type: "auth"; token: string; sessionId?: string | null }
	/** 다른 대화로 옮기기 (사이드바 클릭·뒤로 가기). null 이면 새 대화 */
	| { type: "open"; sessionId: string | null }
	| { type: "prompt"; text: string; images?: ImageAttachment[] }
	| { type: "steer"; text: string; images?: ImageAttachment[] }
	| { type: "abort" }
	/** open(null) 과 같다 — 이전 클라이언트 호환 */
	| { type: "new_session" }
	| { type: "ping" };

export interface ReadyMessage {
	type: "ready";
	sessionId: string;
	model: string;
	ledgerEnabled: boolean;
	isStreaming: boolean;
	messages: UIMessage[];
}

/**
 * 서버가 보내는 스트리밍 이벤트 — pi 이벤트를 UI가 쓰는 최소 형태로 좁힌 것.
 * 원본 이벤트를 그대로 흘리지 않는 이유: 사고 토큰 노출 방지 + 페이로드 축소.
 */
export type StreamMessage =
	| ReadyMessage
	| { type: "text_delta"; delta: string }
	| { type: "message_end"; messages: UIMessage[] }
	| { type: "tool_start"; id: string; name: string; args: unknown }
	| { type: "tool_end"; id: string; name: string; isError: boolean }
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "error"; message: string }
	/** 요청한 대화가 없다 (삭제됨·다른 사용자 것·저장 전에 서버 재시작) — 클라이언트는 새 대화로 */
	| { type: "session_missing"; sessionId: string }
	/**
	 * 같은 사용자의 **다른 대화**가 응답을 시작·끝냄 — 사이드바의 "응답 중"·"새 답" 표시용.
	 * 지금 보고 있지 않은 대화의 내용은 보내지 않는다.
	 */
	| { type: "activity"; sessionId: string; streaming: boolean }
	/** 감시 트리거 발동·만료·상태 변경 (PLAN §40) — 떠 있는 모든 화면에. path 는 결과를 볼 곳 */
	| { type: "watch_event"; triggerId: string; name: string; kind: string; title: string; lines: string[]; path: string | null; at: number }
	| { type: "pong" };

/** GET /api/sessions — 사이드바 대화 목록 (최근 순) */
export interface ConversationListItem {
	id: string;
	title: string;
	modified: string;
	messageCount: number;
	/** 서버에서 응답을 만들고 있는가 — 앱을 꺼도 계속 돈다 */
	streaming: boolean;
}

// ── 가계부 REST ─────────────────────────────────────────────────────────

export interface LedgerTransaction {
	id: string;
	date: string;
	amount: number;
	currency: string;
	category: string | null;
	merchant: string | null;
	memo: string | null;
	account: string | null;
	source: string;
	/** 기록한 사람 (가계부는 멤버끼리 공유) */
	member: string | null;
	created_at: string;
}

export interface LedgerSummaryRow {
	key: string;
	income: number;
	expense: number;
	net: number;
	count: number;
}

export interface LedgerBudgetRow {
	month: string;
	category: string;
	limit_amt: number;
	spent: number;
	remaining: number;
	usedPct: number;
}

// ── 가계부 관리 · 초대 REST (PLAN §23) ─────────────────────────────────

export interface MyLedgerDto {
	id: string;
	name: string;
	owner: string;
	created_at: string;
	role: "owner" | "member";
	memberCount: number;
	isDefault: boolean;
}

export interface LedgerMemberDto {
	member: string;
	role: "owner" | "member";
	joined_at: string;
}

export interface LedgerInviteDto {
	id: string;
	ledger_id: string;
	ledger_name: string;
	inviter: string;
	invitee: string;
	status: "pending" | "accepted" | "declined" | "revoked" | "expired";
	created_at: string;
	expires_at: string;
	responded_at: string | null;
}

// ── 계정 · 관리자 REST (PLAN §25) ──────────────────────────────────────

export interface MeDto {
	user: string;
	groups: string[];
	/** env 계정 = 슈퍼관리자 */
	admin: boolean;
	/** env = 서버 설정 계정(비밀번호를 앱에서 못 바꾼다), db = 가입 계정 */
	source: "env" | "db" | null;
}

export interface SignupInviteDto {
	id: string;
	note: string | null;
	createdBy: string;
	createdAt: string;
	expiresAt: string;
	usedBy: string | null;
	usedAt: string | null;
	revokedAt: string | null;
	status: "pending" | "used" | "expired" | "revoked";
}

export interface AccountDto {
	name: string;
	source: "env" | "db";
	admin: boolean;
	invitedBy: string | null;
	createdAt: string | null;
	disabled: boolean;
}
