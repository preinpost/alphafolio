/** 브로커 툴의 의존성·결과 계약. 런타임 코드는 포함하지 않는다. */
import type { D1Config } from "@alphafolio/ledger";
import type { OrderAction } from "../actions.ts";
import type { BrokerAccess } from "../portfolio.ts";
import type { NaverCredentials, NewsItem } from "../news.ts";
import type { OverseasNewsItem } from "../overseas-news.ts";
import type { Consensus, FinancialPeriod } from "../financials.ts";
import type { IndicatorSnapshot } from "../indicators.ts";
import type { TimingResult } from "../timing.ts";
import type { Section } from "../research.ts";
import type { OrderSide, OrderType } from "../orders.ts";
import type { CryptoHolding, Holding, ManualHolding, Quote } from "../normalize.ts";
import type { Mover } from "../movers.ts";
import type { PortfolioSignalRow } from "../portfolio-signals.ts";

export interface BrokerToolDeps {
	/** 증권사 접근자 — 설정된 곳만 실제로 호출된다 (KIS·토스 병행 가능). */
	brokers: BrokerAccess;
	/** 가계부 D1 — finance_overview 에서 현금흐름을 함께 본다. */
	ledger: () => D1Config;
	/** 현재 사용자 (가계부 귀속 판단용). */
	member: string;
	/** 네이버 뉴스 자격증명 — 미설정이면 throw 해서 설정 안내가 가게 한다. */
	naver?: () => NaverCredentials;
	/**
	 * 주문 확인 토큰 발급 (서버가 제공). **툴은 주문을 실행하지 않는다** —
	 * 준비된 주문은 사람이 화면에서 확인해야 나간다. 없으면 주문 기능이 비활성이다.
	 */
	prepareOrder?: (action: OrderAction) => { token: string; expiresAt: number };
}

export interface QuoteDetails {
	kind: "quote-card";
	quote: Quote & { source: "kis" | "toss" };
}

/** 기술적 지표 — 캔들 없이 **숫자와 라벨**만 (이 앱은 차트 UI 를 두지 않기로 했다 — PLAN.md §19). */
export interface TechnicalDetails {
	kind: "technical-card";
	symbol: string;
	name: string;
	period: string;
	/** KRW · USD · 코인은 호가 자산 (USDT 등, 모르면 "") */
	currency: string;
	snapshot: IndicatorSnapshot | null;
	note?: string;
}

export interface FinancialsDetails {
	kind: "financials-card";
	symbol: string;
	name: string;
	periods: FinancialPeriod[];
	consensus: Consensus;
	yoy: { revenue: number | null; operatingProfit: number | null; netIncome: number | null } | null;
}

/** 타점 판정. 판정은 **규칙 기반**이며 매매 권유가 아니다 — 텍스트에 고정 표시한다. */
export type TimingCardResult = Omit<TimingResult, "snapshot"> & {
	snapshot: Pick<IndicatorSnapshot, "lastDate" | "bars" | "rsi" | "trend" | "ma20" | "support" | "resistance">;
};

export interface TimingDetails {
	kind: "timing-card";
	symbol: string;
	name: string;
	currency: "KRW" | "USD";
	/** 먼저 보여줄 판정 */
	result: TimingCardResult;
	/** 기간을 정하지 않아 두 모드를 다 돌렸을 때 나머지 하나 */
	alt?: TimingCardResult;
	/** 판정에 쓰지 못한 입력 (재무 조회 실패 등) */
	notes: string[];
}

export interface ResearchFinancials {
	latest: FinancialPeriod | null;
	yoy: { revenue: number | null; operatingProfit: number | null; netIncome: number | null } | null;
	consensus: Consensus;
}

export type ResearchNews = Array<{ title: string; date: string; link: string }>;

/**
 * 종목 리서치 카드 — 섹션마다 성공(ok)·실패(failed)·해당 없음(skipped) 을 구분한다.
 */
export interface ResearchDetails {
	kind: "research-card";
	symbol: string;
	name: string;
	currency: "KRW" | "USD";
	quote: Section<{
		price: number;
		change: number;
		changePct: number;
		per: number | null;
		pbr: number | null;
		high52: number | null;
		low52: number | null;
		/** 52주 범위 내 위치 0~100 */
		pos52: number | null;
		source: string;
	}>;
	technical: Section<{
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
	financials: Section<ResearchFinancials>;
	news: Section<ResearchNews>;
	/** ok 인데 data 가 null 이면 "보유하지 않음" */
	holding: Section<{ quantity: number; avgPrice: number; profitPct: number; valueKrw: number } | null>;
}

export interface PortfolioSignalsDetails {
	kind: "portfolio-signals-card";
	rows: PortfolioSignalRow[];
	skipped: string[];
	/** 보유·예수금 등 포트폴리오 조회 경고 — 미보유와 조회 실패를 구분한다 */
	warnings: string[];
}

export interface HoldingsDetails {
	kind: "holdings-card";
	holdings: Holding[];
	brokers: string[];
	stockValueKrw: number;
	cashKrw: number;
	cashUsd: number;
	profitKrw: number;
	usdKrw: number;
	crypto: CryptoHolding[];
	manual: ManualHolding[];
	cryptoValueKrw: number;
	/** 원화 환산 총자산 — 주식·예수금·달러·코인 */
	netWorthKrw: number;
}

export interface MoversDetails {
	kind: "movers-card";
	title: string;
	market: "KR" | "US";
	rankedAt: string | null;
	movers: Mover[];
}

export interface NewsDetails {
	kind: "news-card";
	query: string;
	items: NewsItem[];
}

export interface OverseasNewsDetails {
	kind: "overseas-news";
	symbol: string | null;
	excd: string | null;
	items: OverseasNewsItem[];
}

/**
 * 주문 확인 카드. 거절된 경우도 같은 모양으로 돌려준다 (`ok: false`, `token: null`) —
 * defineTool 이 첫 반환 분기로 details 타입을 추론하므로 분기마다 모양이 달라지면 안 된다.
 */
export interface OrderPreviewDetails {
	kind: "order-preview-card";
	ok: boolean;
	/** 서명된 확인 토큰 — 화면의 [확인] 버튼이 이 값을 서버로 보낸다. 거절 시 null. */
	token: string | null;
	expiresAt: number | null;
	broker: "toss" | "kis";
	symbol: string;
	name: string;
	side: OrderSide;
	orderType: OrderType;
	quantity: number;
	price: number | null;
	estimatedAmount: number;
	currency: "KRW" | "USD";
	warnings: string[];
	errors: string[];
}

export interface OverviewDetails {
	kind: "overview-card";
	from: string;
	to: string;
	investKrw: number;
	cashKrw: number;
	cashUsd: number;
	profitKrw: number;
	/** 코인 평가 (원화 환산) — investKrw 에는 들어가지 않는다 */
	cryptoKrw: number;
	netWorthKrw: number;
	income: number;
	expense: number;
	surplus: number;
}
