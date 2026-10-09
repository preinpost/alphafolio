/**
 * 매매일지 (PLAN §42) — 한 줄 = 한 번의 매매.
 *
 * 네 경로가 같은 표에 쌓인다:
 *   manual  직접 기록 (화면·챗 journal_add) — 앱 밖에서 한 매매, 증권사 API 가 없는 곳
 *   order   앱의 확인 카드로 낸 주문 — 접수 순간 pending 으로 남고, 체결 가져오기가 수량·평단을 채운다
 *   auto    감시 자동 매매 (trigger_execs) — 체결기가 끝낸 결과 그대로 (filled)
 *   import  증권사 체결 내역에서 가져온 것 — 앱 밖(MTS)에서 낸 주문
 *
 * 증권사 주문과는 ref 로 잇는다 (refs.ts). 같은 ref 는 두 번 들어오지 않는다.
 */

export type JournalBroker = "kis" | "toss" | "binance" | "binance_stock" | "other";
export type JournalSource = "manual" | "order" | "auto" | "import";
/** pending = 접수됐지만 체결을 아직 확인하지 못했다 · canceled = 하나도 체결되지 않고 끝났다 */
export type JournalStatus = "pending" | "filled" | "canceled";
export type JournalSide = "BUY" | "SELL";

export const JOURNAL_BROKERS: readonly JournalBroker[] = ["kis", "toss", "binance", "binance_stock", "other"];

/**
 * 감정 — 자유 입력이면 통계가 흩어진다 ("불안"·"불안함"·"걱정"). 고른 것만 받는다.
 * 매매 심리 회고에서 자주 쓰는 축: 계획대로였나 · 확신 · 두려움 · 서두름(FOMO) · 욕심 · 충동(복수 매매 포함).
 */
export const JOURNAL_EMOTIONS = ["차분", "확신", "불안", "조급", "욕심", "충동"] as const;
export type JournalEmotion = (typeof JOURNAL_EMOTIONS)[number];

/** 매매 당시의 맥락 — 앱이 아는 것만 (지표·뉴스를 주문 경로에서 새로 조회하지 않는다) */
export interface JournalContext {
	orderType?: "LIMIT" | "MARKET";
	/** 지정가 */
	limitPrice?: number;
	/** 주문 수량 (체결 수량과 다를 수 있다) */
	ordered?: number;
	/** 시장가 매수 금액 (Binance quoteOrderQty·notional) */
	orderAmount?: number;
	/** 자동 매매 — 감시 이름 · 조건 한 줄 · 정상/손절/익절 */
	trigger?: string;
	condition?: string;
	leg?: "normal" | "stop" | "take";
	/** 자동 매매 — 신호 때 중간가 · 불리한 쪽 슬리피지(bp) */
	arrivalPrice?: number | null;
	slippageBps?: number | null;
}

export interface JournalEntry {
	id: string;
	/** 체결(또는 주문) 시각 epoch ms */
	at: number;
	/** at 의 KST 날짜 YYYY-MM-DD */
	date: string;
	broker: JournalBroker;
	symbol: string;
	name: string | null;
	side: JournalSide;
	/** 체결 수량 (pending 이면 주문 수량, 금액 주문이면 0) */
	quantity: number;
	/** 평균 체결가 (모르면 null — 시장가 pending · 기억이 안 나는 직접 기록) */
	price: number | null;
	/** KRW · USD · USDT · USDC … */
	currency: string;
	fee: number | null;
	status: JournalStatus;
	source: JournalSource;
	// ── 사람이 쓰는 칸 ──
	/** 진입·청산 근거 */
	thesis: string | null;
	targetPrice: number | null;
	stopPrice: number | null;
	tags: string[];
	emotion: JournalEmotion | null;
	/** 사후 회고 */
	review: string | null;
	context: JournalContext | null;
	/** 주문을 준비한 대화 */
	conversationId: string | null;
	createdAt: string;
	updatedAt: string;
}

/** 새 기록 — 직접 기록은 사람이, 나머지는 서버가 채운다 */
export interface JournalInput {
	at: number;
	broker: JournalBroker;
	symbol: string;
	name: string | null;
	side: JournalSide;
	quantity: number;
	price: number | null;
	currency: string;
	fee: number | null;
	status: JournalStatus;
	source: JournalSource;
	thesis: string | null;
	targetPrice: number | null;
	stopPrice: number | null;
	tags: string[];
	emotion: JournalEmotion | null;
	review: string | null;
	context: JournalContext | null;
	conversationId: string | null;
}

/** 사람이 쓰는 칸 — 어느 경로로 들어온 기록이든 고칠 수 있다 */
export interface JournalNotes {
	thesis: string | null;
	targetPrice: number | null;
	stopPrice: number | null;
	tags: string[];
	emotion: JournalEmotion | null;
	review: string | null;
}

/** 매매 칸 — 직접 기록만 고칠 수 있다 (증권사에서 온 숫자는 증권사가 맞다) */
export interface JournalTrade {
	at: number;
	broker: JournalBroker;
	symbol: string;
	name: string | null;
	side: JournalSide;
	quantity: number;
	price: number | null;
	currency: string;
	fee: number | null;
}

export type JournalPatch = Partial<JournalNotes & JournalTrade>;

export interface JournalFilter {
	/** epoch ms 이상 */
	from?: number;
	/** epoch ms 미만 */
	to?: number;
	symbol?: string;
	side?: JournalSide;
	/** 근거(thesis)를 아직 안 쓴 것만 */
	missingNotes?: boolean;
	limit?: number;
}

/**
 * 증권사 체결 내역 한 건 (주문 단위) — 가져오기의 입력. 브로커마다 모양이 달라 여기로 맞춘다 (history.ts).
 * open = 아직 더 체결될 수 있다 (미체결 잔량이 있다).
 */
export interface BrokerFill {
	ref: string;
	/** 정정 주문 — 원주문의 ref (원주문을 앱에서 냈으면 그 기록에 붙인다) */
	parentRef: string | null;
	broker: Exclude<JournalBroker, "other">;
	symbol: string;
	name: string | null;
	side: JournalSide;
	ordered: number;
	filled: number;
	price: number | null;
	currency: string;
	fee: number | null;
	at: number;
	open: boolean;
}

export interface JournalSyncResult {
	added: number;
	updated: number;
	/** 계좌별 결과 — 키가 없는 계좌는 빠진다 */
	sources: Array<{ broker: BrokerFill["broker"]; label: string; fills: number; error: string | null }>;
	warnings: string[];
	/** 너무 자주 눌러 이번엔 건너뛰었다 */
	skipped?: boolean;
}
