/**
 * 기술적 지표 — 순수 함수.
 *
 * **모델에게 숫자 계산을 시키지 않는다.** 저비용 모델은 이동평균·RSI 같은 걸
 * 자주 틀리고, 틀려도 그럴듯해서 발견이 늦다. 계산은 전부 여기서 하고 모델은
 * 해석만 한다.
 *
 * 차트를 그리지 않는 앱이라 출력도 **숫자와 라벨** 중심이다.
 */

export interface Bar {
	date: string; // YYYYMMDD
	open: number;
	high: number;
	low: number;
	close: number;
	volume?: number;
}

// ── 기본 ────────────────────────────────────────────────────────────────

/** 단순이동평균. 데이터가 모자란 구간은 null. */
export function sma(values: number[], period: number): Array<number | null> {
	const out: Array<number | null> = [];
	let sum = 0;
	for (let i = 0; i < values.length; i++) {
		sum += values[i] as number;
		if (i >= period) sum -= values[i - period] as number;
		out.push(i >= period - 1 ? sum / period : null);
	}
	return out;
}

/** 지수이동평균. 초기값은 첫 period 개의 단순평균(표준 관행). */
export function ema(values: number[], period: number): Array<number | null> {
	const out: Array<number | null> = new Array(values.length).fill(null);
	if (values.length < period) return out;

	const k = 2 / (period + 1);
	let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
	out[period - 1] = prev;

	for (let i = period; i < values.length; i++) {
		prev = (values[i] as number) * k + prev * (1 - k);
		out[i] = prev;
	}
	return out;
}

/**
 * RSI — Wilder 평활 (단순평균이 아니다).
 * 첫 값은 period 개 변화량의 평균, 이후 `(이전*(n-1) + 현재)/n`.
 */
export function rsi(closes: number[], period = 14): Array<number | null> {
	const out: Array<number | null> = new Array(closes.length).fill(null);
	if (closes.length <= period) return out;

	let gain = 0;
	let loss = 0;
	for (let i = 1; i <= period; i++) {
		const diff = (closes[i] as number) - (closes[i - 1] as number);
		if (diff >= 0) gain += diff;
		else loss -= diff;
	}
	gain /= period;
	loss /= period;
	out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);

	for (let i = period + 1; i < closes.length; i++) {
		const diff = (closes[i] as number) - (closes[i - 1] as number);
		gain = (gain * (period - 1) + Math.max(diff, 0)) / period;
		loss = (loss * (period - 1) + Math.max(-diff, 0)) / period;
		out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
	}
	return out;
}

export interface MacdResult {
	macd: Array<number | null>;
	signal: Array<number | null>;
	histogram: Array<number | null>;
}

/** MACD(12, 26, 9). signal 은 macd 계열의 EMA 라 앞쪽 null 을 건너뛰고 계산한다. */
export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
	const fastLine = ema(closes, fast);
	const slowLine = ema(closes, slow);

	const macdLine: Array<number | null> = closes.map((_, i) => {
		const f = fastLine[i];
		const s = slowLine[i];
		return f !== null && f !== undefined && s !== null && s !== undefined ? f - s : null;
	});

	const firstValid = macdLine.findIndex((v) => v !== null);
	const signal: Array<number | null> = new Array(closes.length).fill(null);
	const histogram: Array<number | null> = new Array(closes.length).fill(null);

	if (firstValid >= 0) {
		const dense = macdLine.slice(firstValid) as number[];
		const signalDense = ema(dense, signalPeriod);
		for (let i = 0; i < signalDense.length; i++) {
			const v = signalDense[i];
			if (v === null || v === undefined) continue;
			const idx = firstValid + i;
			signal[idx] = v;
			histogram[idx] = (macdLine[idx] as number) - v;
		}
	}

	return { macd: macdLine, signal, histogram };
}

export interface BollingerBand {
	upper: Array<number | null>;
	middle: Array<number | null>;
	lower: Array<number | null>;
}

/** 볼린저 밴드. 표준편차는 모집단 기준(관행). */
export function bollinger(closes: number[], period = 20, mult = 2): BollingerBand {
	const middle = sma(closes, period);
	const upper: Array<number | null> = new Array(closes.length).fill(null);
	const lower: Array<number | null> = new Array(closes.length).fill(null);

	for (let i = period - 1; i < closes.length; i++) {
		const mean = middle[i];
		if (mean === null || mean === undefined) continue;
		const window = closes.slice(i - period + 1, i + 1);
		const variance = window.reduce((acc, v) => acc + (v - mean) ** 2, 0) / period;
		const sd = Math.sqrt(variance);
		upper[i] = mean + mult * sd;
		lower[i] = mean - mult * sd;
	}

	return { upper, middle, lower };
}

/** ATR — Wilder 평활. 변동성(손절 폭 산정) 용도. */
export function atr(bars: Bar[], period = 14): Array<number | null> {
	const out: Array<number | null> = new Array(bars.length).fill(null);
	if (bars.length <= period) return out;

	const trs: number[] = [0];
	for (let i = 1; i < bars.length; i++) {
		const cur = bars[i] as Bar;
		const prevClose = (bars[i - 1] as Bar).close;
		trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose)));
	}

	let value = trs.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
	out[period] = value;
	for (let i = period + 1; i < bars.length; i++) {
		value = (value * (period - 1) + (trs[i] as number)) / period;
		out[i] = value;
	}
	return out;
}

/** 최근 구간의 지지/저항 (직전 저점·고점). 마지막 봉은 제외한다. */
export function supportResistance(
	bars: Bar[],
	lookback = 20,
): { support: number | null; resistance: number | null } {
	if (bars.length < 2) return { support: null, resistance: null };
	const window = bars.slice(Math.max(0, bars.length - 1 - lookback), bars.length - 1);
	if (window.length === 0) return { support: null, resistance: null };
	return {
		support: Math.min(...window.map((b) => b.low)),
		resistance: Math.max(...window.map((b) => b.high)),
	};
}

export type Trend = "정배열" | "역배열" | "혼조";

/** MA 배열로 추세를 판정한다 (5 > 20 > 60 = 정배열). */
export function trendOf(ma5: number | null, ma20: number | null, ma60: number | null): Trend {
	if (ma5 === null || ma20 === null || ma60 === null) return "혼조";
	if (ma5 > ma20 && ma20 > ma60) return "정배열";
	if (ma5 < ma20 && ma20 < ma60) return "역배열";
	return "혼조";
}

// ── 종합 ────────────────────────────────────────────────────────────────

export interface IndicatorSnapshot {
	/** 분석에 쓴 봉 수 */
	bars: number;
	lastDate: string;
	price: number;
	ma5: number | null;
	ma20: number | null;
	ma60: number | null;
	trend: Trend;
	rsi: number | null;
	macd: number | null;
	macdSignal: number | null;
	macdHistogram: number | null;
	bollingerUpper: number | null;
	bollingerLower: number | null;
	/** 밴드 내 위치 0~100 (%B × 100). 100 초과면 상단 돌파. */
	bollingerPct: number | null;
	atr: number | null;
	/** ATR 을 가격 대비 %로 — 종목 간 변동성 비교용 */
	atrPct: number | null;
	support: number | null;
	resistance: number | null;
	periodHigh: number;
	periodLow: number;
	/** 기간 시작 대비 등락률 % */
	periodChangePct: number;
	/** 사람이 읽는 신호 라벨 */
	signals: string[];
}

const last = <T>(arr: Array<T | null>): T | null => {
	for (let i = arr.length - 1; i >= 0; i--) {
		const v = arr[i];
		if (v !== null && v !== undefined) return v;
	}
	return null;
};

/**
 * 교차로 인정할 최소 간격 — 가격의 0.01% (최소 1e-8).
 * 종목 가격대가 1,000원부터 200만원까지라 절대값 고정 임계치는 쓸 수 없다.
 */
function crossEpsilon(price: number): number {
	return Math.max(Math.abs(price) * 1e-4, 1e-8);
}

/** 마지막 두 유효값 (교차 판정용) */
function lastTwo(arr: Array<number | null>): [number | null, number | null] {
	const vals = arr.filter((v): v is number => v !== null && v !== undefined);
	return [vals[vals.length - 2] ?? null, vals[vals.length - 1] ?? null];
}

export function analyze(bars: Bar[]): IndicatorSnapshot | null {
	if (bars.length === 0) return null;

	const closes = bars.map((b) => b.close);
	const price = closes[closes.length - 1] as number;

	const ma5Series = sma(closes, 5);
	const ma20Series = sma(closes, 20);
	const ma60Series = sma(closes, 60);
	const rsiSeries = rsi(closes, 14);
	const macdRes = macd(closes);
	const bb = bollinger(closes, 20, 2);
	const atrSeries = atr(bars, 14);

	const ma5 = last(ma5Series);
	const ma20 = last(ma20Series);
	const ma60 = last(ma60Series);
	const rsiValue = last(rsiSeries);
	const upper = last(bb.upper);
	const lower = last(bb.lower);
	const atrValue = last(atrSeries);
	const { support, resistance } = supportResistance(bars, 20);

	const bollingerPct =
		upper !== null && lower !== null && upper > lower
			? Math.round(((price - lower) / (upper - lower)) * 1000) / 10
			: null;

	const first = closes[0] as number;
	const signals: string[] = [];

	// ── 신호 라벨 (해석이 아니라 사실 기술) ──────────────────
	if (rsiValue !== null) {
		if (rsiValue >= 70) signals.push(`RSI ${rsiValue.toFixed(1)} 과매수권`);
		else if (rsiValue <= 30) signals.push(`RSI ${rsiValue.toFixed(1)} 과매도권`);
	}

	// 교차 판정에는 여유값을 둔다. 횡보장에서는 두 선의 차이가 부동소수점 노이즈
	// 수준(1e-15)까지 좁혀지는데, 그대로 부호만 보면 **가짜 골든/데드크로스**가 뜬다.
	const [prevHist, curHist] = lastTwo(macdRes.histogram);
	if (prevHist !== null && curHist !== null) {
		const eps = crossEpsilon(price);
		if (prevHist < -eps && curHist > eps) signals.push("MACD 골든크로스");
		else if (prevHist > eps && curHist < -eps) signals.push("MACD 데드크로스");
	}

	const [prevMa5, curMa5] = lastTwo(ma5Series);
	const [prevMa20, curMa20] = lastTwo(ma20Series);
	if (prevMa5 !== null && curMa5 !== null && prevMa20 !== null && curMa20 !== null) {
		const eps = crossEpsilon(price);
		const prevDiff = prevMa5 - prevMa20;
		const curDiff = curMa5 - curMa20;
		if (prevDiff < -eps && curDiff > eps) signals.push("5·20일선 골든크로스");
		else if (prevDiff > eps && curDiff < -eps) signals.push("5·20일선 데드크로스");
	}

	if (bollingerPct !== null) {
		if (bollingerPct >= 100) signals.push("볼린저 상단 돌파");
		else if (bollingerPct <= 0) signals.push("볼린저 하단 이탈");
	}

	if (resistance !== null && price > resistance) signals.push("최근 20봉 저항 돌파");
	if (support !== null && price < support) signals.push("최근 20봉 지지 이탈");

	return {
		bars: bars.length,
		lastDate: (bars[bars.length - 1] as Bar).date,
		price,
		ma5,
		ma20,
		ma60,
		trend: trendOf(ma5, ma20, ma60),
		rsi: rsiValue === null ? null : Math.round(rsiValue * 10) / 10,
		macd: last(macdRes.macd),
		macdSignal: last(macdRes.signal),
		macdHistogram: curHist,
		bollingerUpper: upper,
		bollingerLower: lower,
		bollingerPct,
		atr: atrValue,
		atrPct: atrValue !== null && price > 0 ? Math.round((atrValue / price) * 1000) / 10 : null,
		support,
		resistance,
		periodHigh: Math.max(...bars.map((b) => b.high)),
		periodLow: Math.min(...bars.map((b) => b.low)),
		periodChangePct: first > 0 ? Math.round(((price - first) / first) * 1000) / 10 : 0,
		signals,
	};
}
