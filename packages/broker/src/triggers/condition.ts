/**
 * 조건 평가 — 순수 함수 (PLAN §40). 봉 배열 → 발동한 봉.
 *
 * 발동 규칙은 **봉 배열만으로 정해진다** (상태를 저장하지 않는다):
 *   streak(i) = i 에서 끝나는 연속 충족 봉 수 → streak(i) === confirmBars 인 봉에서 발동.
 * 조건이 계속 참이면 streak 가 confirmBars 를 넘어가므로 다시 울리지 않고(on_enter), 거짓이 됐다가 다시 참이 되면 또 울린다.
 * 그래서 감시기는 "마지막으로 평가한 봉" 만 기억하면 되고, 재기동 후 놓친 봉도 같은 규칙으로 소급 평가할 수 있다.
 */
import { atr, bollinger, rsi, sma } from "../indicators.ts";
import { isStock } from "./market-time.ts";
import { INTERVALS, OPS, SERIES, VENUES, type Clause, type Condition, type Interval, type SeriesName, type WatchBar } from "./types.ts";

export const MAX_CLAUSES = 5;
export const MAX_CONFIRM_BARS = 10;
/** 예열 봉 수 상한 (ma60 + 여유) — 조건에 쓰인 값에 맞춰 줄인다 (warmupFor) */
export const WARMUP_BARS = 80;

/** 값마다 안정되려면 필요한 봉 수 (RSI·ATR 은 평활이라 기간의 3배쯤) */
const WARMUP: Readonly<Record<SeriesName, number>> = {
	close: 1,
	open: 1,
	high: 1,
	low: 1,
	volume: 1,
	vol_chg_pct: 2,
	ma5: 5,
	ma20: 20,
	ma60: 60,
	rsi14: 45,
	bb_upper: 20,
	bb_lower: 20,
	atr14: 45,
	vol_ratio20: 21,
};

/** 조건에 쓰인 값 기준 예열 봉 수 (+ 교차 1봉 + 연속 봉) — 주식 조회량을 줄인다 */
export function warmupFor(c: Condition): number {
	let need = 1;
	for (const cl of c.all) {
		need = Math.max(need, WARMUP[cl.left] ?? WARMUP_BARS);
		if (typeof cl.right !== "number") need = Math.max(need, WARMUP[cl.right] ?? WARMUP_BARS);
	}
	const cross = c.all.some((cl) => cl.op === "crosses_above" || cl.op === "crosses_below") ? 1 : 0;
	return Math.min(WARMUP_BARS, need + cross + Math.max(0, c.confirmBars - 1));
}

/** 시장별로 지금 되는 봉 간격 */
export const SUPPORTED: Readonly<Record<Condition["market"]["venue"], readonly Interval[]>> = {
	binance: INTERVALS,
	krx: ["1d", "1w"],
	us: ["1d", "1w"],
};

const SYMBOL_RE: Readonly<Record<Condition["market"]["venue"], RegExp>> = {
	binance: /^[A-Z0-9]{5,20}$/,
	krx: /^[0-9A-Z]{6}$/,
	us: /^[A-Z][A-Z0-9.-]{0,9}$/,
};
const SYMBOL_EXAMPLE = { binance: "ETHUSDT", krx: "005930", us: "AAPL" } as const;

export type Series = Array<number | null>;

/** 값 이름 → 봉마다의 값 (모자란 구간은 null) */
export function seriesOf(bars: WatchBar[], name: SeriesName): Series {
	const closes = bars.map((b) => b.close);
	switch (name) {
		case "close":
		case "open":
		case "high":
		case "low":
		case "volume":
			return bars.map((b) => b[name]);
		case "vol_chg_pct":
			// 직전 봉이 0 (거래정지·빈 봉) 이면 판정하지 않는다
			return bars.map((b, i) => {
				const prev = i > 0 ? (bars[i - 1] as WatchBar).volume : 0;
				return prev > 0 ? (b.volume / prev - 1) * 100 : null;
			});
		case "ma5":
			return sma(closes, 5);
		case "ma20":
			return sma(closes, 20);
		case "ma60":
			return sma(closes, 60);
		case "rsi14":
			return rsi(closes, 14);
		case "bb_upper":
			return bollinger(closes, 20, 2).upper;
		case "bb_lower":
			return bollinger(closes, 20, 2).lower;
		case "atr14":
			return atr(
				bars.map((b) => ({ date: String(b.t), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
				14,
			);
		case "vol_ratio20": {
			const avg = sma(
				bars.map((b) => b.volume),
				20,
			);
			// 직전 20봉 평균과 비교 (자기 자신을 평균에 넣지 않는다)
			return bars.map((b, i) => {
				const prev = i > 0 ? avg[i - 1] : null;
				return prev ? b.volume / prev : null;
			});
		}
	}
}

/** 사람이 고칠 수 있는 오류 목록. 비면 통과 */
export function validateCondition(c: Condition): string[] {
	const errors: string[] = [];
	const venue = c.market?.venue;
	if (!VENUES.includes(venue)) {
		errors.push(`시장은 ${VENUES.join(" · ")} 중 하나입니다 (binance=코인, krx=국장, us=미장)`);
		return errors;
	}
	if (!SYMBOL_RE[venue].test(c.market.symbol ?? "")) errors.push(`종목 형식이 아닙니다: ${c.market.symbol} (예: ${SYMBOL_EXAMPLE[venue]})`);
	if (!INTERVALS.includes(c.interval)) errors.push(`봉 간격은 ${INTERVALS.join(" · ")} 중 하나입니다`);
	else if (!SUPPORTED[venue].includes(c.interval)) {
		errors.push(`${venue === "krx" ? "국장" : "미장"}은 지금 일봉(1d)·주봉(1w)만 됩니다 — 분봉·시간봉(5분~4시간)은 다음 단계`);
	}
	if (c.session === "extended") {
		if (!isStock(venue)) errors.push("코인은 24시간이라 세션 구분이 없습니다");
		else if (c.interval === "1d" || c.interval === "1w") errors.push("일봉·주봉은 정규장 기준입니다 — 프리·애프터는 분봉·시간봉에서만");
	}
	if (c.interval === "1m" && isStock(venue)) errors.push("1분봉은 코인만 됩니다");
	if (c.when !== "bar_close") errors.push("판정 시점은 봉 마감(bar_close)만 됩니다");
	if (c.fire !== "on_enter") errors.push("발동 방식은 on_enter 만 됩니다");
	if (!Number.isInteger(c.confirmBars) || c.confirmBars < 1 || c.confirmBars > MAX_CONFIRM_BARS) errors.push(`연속 봉 수는 1~${MAX_CONFIRM_BARS} 입니다`);
	if (!Array.isArray(c.all) || c.all.length === 0) errors.push("조건이 하나 이상 필요합니다");
	else if (c.all.length > MAX_CLAUSES) errors.push(`조건은 ${MAX_CLAUSES}개까지입니다`);
	for (const [i, cl] of (c.all ?? []).entries()) {
		const at = `조건 ${i + 1}`;
		if (!SERIES.includes(cl.left)) errors.push(`${at}: 모르는 값 ${cl.left} — ${SERIES.join(", ")}`);
		if (!OPS.includes(cl.op)) errors.push(`${at}: 모르는 비교 ${cl.op} — ${OPS.join(", ")}`);
		if (typeof cl.right === "number") {
			if (!Number.isFinite(cl.right)) errors.push(`${at}: 비교할 숫자가 올바르지 않습니다`);
		} else if (!SERIES.includes(cl.right)) errors.push(`${at}: 모르는 값 ${cl.right}`);
		if (cl.left === cl.right) errors.push(`${at}: 같은 값끼리 비교합니다`);
	}
	return errors;
}

/** 한 조건절의 봉별 판정 — 데이터가 모자라면 null */
function clauseHits(clause: Clause, bars: WatchBar[], cache: Map<SeriesName, Series>): Array<boolean | null> {
	const get = (n: SeriesName): Series => {
		let s = cache.get(n);
		if (!s) {
			s = seriesOf(bars, n);
			cache.set(n, s);
		}
		return s;
	};
	const left = get(clause.left);
	const right: Series = typeof clause.right === "number" ? bars.map(() => clause.right as number) : get(clause.right);
	return bars.map((_, i) => {
		const l = left[i];
		const r = right[i];
		if (l == null || r == null) return null;
		switch (clause.op) {
			case "<":
				return l < r;
			case ">":
				return l > r;
			case "<=":
				return l <= r;
			case ">=":
				return l >= r;
			case "crosses_above":
			case "crosses_below": {
				const pl = left[i - 1];
				const pr = right[i - 1];
				if (pl == null || pr == null) return null;
				return clause.op === "crosses_above" ? pl <= pr && l > r : pl >= pr && l < r;
			}
		}
	});
}

/** 봉별 전체 판정 (AND). 하나라도 데이터가 모자라면 null */
export function evaluate(c: Condition, bars: WatchBar[]): Array<boolean | null> {
	const cache = new Map<SeriesName, Series>();
	const per = c.all.map((cl) => clauseHits(cl, bars, cache));
	return bars.map((_, i) => {
		let all = true;
		for (const h of per) {
			const v = h[i];
			if (v == null) return null;
			if (!v) all = false;
		}
		return all;
	});
}

/** 발동한 봉의 인덱스 — streak(i) === confirmBars */
export function fireIndices(c: Condition, bars: WatchBar[]): number[] {
	const hits = evaluate(c, bars);
	const out: number[] = [];
	let streak = 0;
	for (const [i, h] of hits.entries()) {
		streak = h ? streak + 1 : 0;
		if (h && streak === c.confirmBars) out.push(i);
	}
	return out;
}

/** 마지막 봉에서 조건이 참인가 (on_enter 라 켜는 순간 이미 참이면 울리지 않는다 — 카드에 알린다) */
export function holdsNow(c: Condition, bars: WatchBar[]): boolean | null {
	const hits = evaluate(c, bars);
	return hits.at(-1) ?? null;
}

/** 평가할 때 쓴 값 — 이벤트 기록·알림용 (\"종가 2,594.2 · RSI 28.1\") */
export function valuesAt(c: Condition, bars: WatchBar[], i: number): Partial<Record<SeriesName, number>> {
	const names = new Set<SeriesName>(["close"]);
	for (const cl of c.all) {
		names.add(cl.left);
		if (typeof cl.right !== "number") names.add(cl.right);
	}
	const out: Partial<Record<SeriesName, number>> = {};
	for (const n of names) {
		const v = seriesOf(bars, n)[i];
		if (v != null) out[n] = Math.round(v * 1e6) / 1e6;
	}
	return out;
}
