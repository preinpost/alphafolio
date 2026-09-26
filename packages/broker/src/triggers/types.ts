/**
 * 감시 트리거 타입 (PLAN §40).
 *
 * 트리거 = 조건(소스) + 동작. 1단계는 소스 = 자체 감시(봉 마감), 동작 = 알림만.
 * 조건은 **선언형**이다 — 에이전트가 자연어를 이 모양으로 바꾸고, 사람이 확인 카드에서 켠다. 코드를 받지 않는다.
 */

/** 봉 — 시각은 봉 시작(epoch ms). 일봉 날짜 문자열을 쓰는 indicators.Bar 와 달리 분·시간봉도 담는다 */
export interface WatchBar {
	t: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

/** 봉 간격 — 1m 은 코인만 (1단계 호환). 주식 분봉(5m~4h)은 다음 단계, 지금은 1d·1w */
export const INTERVALS = ["1m", "5m", "10m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"] as const;
export type Interval = (typeof INTERVALS)[number];

/**
 * 비교할 수 있는 값 — indicators.ts 가 계산하는 것만.
 * vol_ratio20 = 거래량 ÷ 직전 20봉 평균 거래량. vol_chg_pct = (거래량 ÷ 직전 봉 거래량 − 1) × 100.
 */
export const SERIES = ["close", "open", "high", "low", "volume", "vol_chg_pct", "ma5", "ma20", "ma60", "rsi14", "bb_upper", "bb_lower", "atr14", "vol_ratio20"] as const;
export type SeriesName = (typeof SERIES)[number];

export const OPS = ["<", ">", "<=", ">=", "crosses_above", "crosses_below"] as const;
export type Op = (typeof OPS)[number];

/** 봉에서 바로 읽는 값 — 지표의 재료 */
export const FIELDS = ["close", "open", "high", "low", "volume"] as const;
export type Field = (typeof FIELDS)[number];

/**
 * 매개변수가 있는 값. 모든 값에 mul(배수)을 붙일 수 있다 — "20봉 이평 × 1.02".
 *   sma·ema      N봉 이동평균 (of 기본 close)
 *   rsi          RSI(N)
 *   highest·lowest  N봉 최고·최저 (of 기본 high·low, offset 기본 1 = 지금 봉을 빼고 "직전 N봉" — 돌파 판정용)
 *   change_pct   N봉 전 대비 변동률 %
 *   vol_ratio    거래량 ÷ 직전 N봉 평균
 *   rvol         같은 시각 대비 거래량 (TradingView Relative Volume at Time) — 기준 = 그날(코인 UTC 00:00, 주식 장), 지난 length 일 평균 대비.
 *                일봉 이상이면 기준 구간이 봉 하나라 "직전 length 봉 평균 대비" 가 된다 (TradingView 와 같다)
 *   value        이름 값을 offset 봉 전으로 (예: 직전 봉 종가)
 */
export type IndicatorRef =
	| { ind: "sma" | "ema"; period: number; of?: Field; mul?: number }
	| { ind: "rsi"; period: number; mul?: number }
	| { ind: "highest" | "lowest"; period: number; of?: Field; offset?: number; mul?: number }
	| { ind: "change_pct"; period: number; of?: Field; mul?: number }
	| { ind: "vol_ratio"; period: number; mul?: number }
	| { ind: "rvol"; length?: number; mode?: "cumulative" | "regular"; mul?: number }
	| { ind: "value"; of: SeriesName; offset?: number; mul?: number };

export const INDICATORS = ["sma", "ema", "rsi", "highest", "lowest", "change_pct", "vol_ratio", "rvol", "value"] as const;

/** 이름("rsi14" — 1단계 호환) 또는 매개변수 값 */
export type ValueRef = SeriesName | IndicatorRef;

export interface Clause {
	left: ValueRef;
	op: Op;
	/** 숫자 또는 다른 값 (예: close crosses_above ma20) */
	right: number | ValueRef;
}

/** 조건 트리 — 절, 모두(AND), 하나라도(OR), 최근 N봉 안에 한 번이라도 */
export type CondNode = Clause | { all: CondNode[] } | { any: CondNode[] } | { within: number; cond: CondNode };

/** binance = 코인(24시간), krx = 국장, us = 미장 */
export const VENUES = ["binance", "krx", "us"] as const;
export type Venue = (typeof VENUES)[number];

/**
 * 주식 시세 출처 — 켤 때 고정하고 감시기는 이 출처로만 조회한다 (출처마다 거래량·가격 기준이 달라 섞이면 가짜로 울린다).
 *   krx: basis "krx" = KRX 정규장만 (KIS 만 가능, 15:30 마감) / "integrated" = KRX+NXT 통합 (KIS UN · 토스, NXT 애프터 20:00 마감 — 종가도 20시 체결가)
 *   us: 두 출처 거래량이 같다 — 출처만 고정
 * 없으면(예전 트리거) KIS → 토스 순으로 아무거나.
 */
export interface StockFeed {
	provider: "kis" | "toss";
	basis?: "krx" | "integrated";
}

export interface Condition {
	market: { venue: Venue; symbol: string; feed?: StockFeed };
	interval: Interval;
	/** 주식 분봉만 — extended = 프리·애프터(미장)·NXT(국장) 포함. 일봉·주봉은 항상 정규장. 없으면 regular */
	session?: "regular" | "extended";
	/** 1단계는 봉 마감 판정만 — 꼬리(피뢰침)가 아니라 마감가로 본다 */
	when: "bar_close";
	/** 모두 충족 (AND). 안에 any(OR)·within(최근 N봉) 을 둘 수 있다 */
	all: CondNode[];
	/** 프리셋으로 만들었으면 — 표시용 (평가는 all 만 본다) */
	preset?: { id: string; params: Record<string, number | string> };
	/** N봉 연속 충족해야 발동 (기본 1) */
	confirmBars: number;
	/** 거짓 → 참이 될 때만 (조건이 유지되는 동안 매 봉 울리지 않는다) */
	fire: "on_enter";
}

export interface TriggerLimits {
	/** null = 만료까지 무제한 (알림 동작만). 주문 동작은 필수가 된다 (2단계) */
	maxFires: number | null;
	/** 발동 후 다시 울리기까지 최소 간격 */
	cooldownSec: number;
	/** ISO — 필수 */
	expiresAt: string;
}

export type TriggerAction = { kind: "notify" };

/** 켜기 전 사람이 확인하는 내용 전부 — 확인 토큰에 이대로 서명된다 */
export interface TriggerSpec {
	name: string;
	condition: Condition;
	action: TriggerAction;
	limits: TriggerLimits;
	/** 결과를 기록할 대화 (있으면) */
	conversationId: string | null;
}

export type TriggerState = "armed" | "paused" | "done" | "expired" | "off";
