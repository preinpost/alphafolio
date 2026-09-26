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

export const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;
export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_MS: Readonly<Record<Interval, number>> = {
	"1m": 60_000,
	"5m": 5 * 60_000,
	"15m": 15 * 60_000,
	"30m": 30 * 60_000,
	"1h": 3_600_000,
	"4h": 4 * 3_600_000,
	"1d": 86_400_000,
};

/**
 * 비교할 수 있는 값 — indicators.ts 가 계산하는 것만.
 * vol_ratio20 = 거래량 ÷ 직전 20봉 평균 거래량.
 */
export const SERIES = ["close", "open", "high", "low", "volume", "ma5", "ma20", "ma60", "rsi14", "bb_upper", "bb_lower", "atr14", "vol_ratio20"] as const;
export type SeriesName = (typeof SERIES)[number];

export const OPS = ["<", ">", "<=", ">=", "crosses_above", "crosses_below"] as const;
export type Op = (typeof OPS)[number];

export interface Clause {
	left: SeriesName;
	op: Op;
	/** 숫자 또는 다른 값 (예: close crosses_above ma20) */
	right: number | SeriesName;
}

export type Venue = "binance";

export interface Condition {
	market: { venue: Venue; symbol: string };
	interval: Interval;
	/** 1단계는 봉 마감 판정만 — 꼬리(피뢰침)가 아니라 마감가로 본다 */
	when: "bar_close";
	/** 모두 충족 (AND). OR 가 필요하면 트리거를 둘 만든다 */
	all: Clause[];
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
