/** 가계부 도메인 타입. 금액은 전부 정수(원 단위) — 부동소수점 금지. */

export type TxType = "expense" | "income";

/** DB에 저장되는 행. amount는 부호로 수입(+)/지출(-)을 구분한다. */
export interface Transaction {
	id: string;
	date: string; // YYYY-MM-DD
	amount: number; // 부호 있음
	currency: string;
	category: string | null;
	merchant: string | null;
	memo: string | null;
	account: string | null;
	source: "manual" | "import" | "agent";
	/** 기록한 사람. 가계부는 공유하되 귀속은 남긴다 (null = 구 데이터). */
	member: string | null;
	dedupe_key: string | null;
	created_at: string; // ISO 8601
}

/** 입력 — 사람이 쓰는 방식(양수 금액 + 타입)으로 받고 내부에서 부호로 변환한다. */
export interface TxInput {
	date: string;
	amount: number; // 양수
	type: TxType;
	currency?: string;
	category?: string;
	merchant?: string;
	memo?: string;
	account?: string;
	source?: Transaction["source"];
	/** 기록한 사람. */
	member?: string;
	/** 임포트 중복 방지 키. 지정하지 않으면 자동 생성하지 않는다(수기 입력은 중복 허용). */
	dedupeKey?: string;
}

export interface TxFilter {
	from?: string; // YYYY-MM-DD
	to?: string;
	category?: string;
	/** 특정 사람이 기록한 건만 (미지정 = 가구 전체) */
	member?: string;
	type?: TxType;
	limit?: number;
	offset?: number;
}

export interface TxPatch {
	date?: string;
	amount?: number; // 양수
	type?: TxType;
	category?: string;
	merchant?: string;
	memo?: string;
	account?: string;
}

export interface SummaryRow {
	key: string; // 카테고리명 또는 YYYY-MM
	income: number;
	expense: number;
	net: number;
	count: number;
}

export interface Budget {
	month: string; // YYYY-MM
	category: string;
	limit_amt: number;
}

export interface BudgetStatus extends Budget {
	spent: number;
	remaining: number;
	usedPct: number;
}
