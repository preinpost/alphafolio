/**
 * 조건 평가 — 순수 함수 (PLAN §40). 봉 배열 → 발동한 봉.
 *
 * 발동 규칙은 **봉 배열만으로 정해진다** (상태를 저장하지 않는다):
 *   streak(i) = i 에서 끝나는 연속 충족 봉 수 → streak(i) === confirmBars 인 봉에서 발동.
 * 조건이 계속 참이면 streak 가 confirmBars 를 넘어가므로 다시 울리지 않고(on_enter), 거짓이 됐다가 다시 참이 되면 또 울린다.
 * 그래서 감시기는 "마지막으로 평가한 봉" 만 기억하면 되고, 재기동 후 놓친 봉도 같은 규칙으로 소급 평가할 수 있다.
 *
 * 조건은 트리다 — 절(값 비교) · all(AND) · any(OR) · within(최근 N봉 안에 한 번이라도). 선언형만 받고 코드는 받지 않는다.
 * 값은 이름(\"rsi14\", 1단계 호환) 또는 매개변수 값({ ind: "sma", period: 50, mul: 1.02 }).
 * 데이터가 모자라면 null — null 은 \"판정하지 않음\" 이라 발동하지 않는다.
 */
import { atr, bollinger, ema, rsi, sma } from "../indicators.ts";
import { CRYPTO_STEP, cryptoBarStart, DAY, feedErrors, isStock, localDate, MARKETS, MIN, stockDayStart } from "./market-time.ts";
import {
	FIELDS,
	INDICATORS,
	INTERVALS,
	OPS,
	SERIES,
	VENUES,
	type Clause,
	type CondNode,
	type Condition,
	type Field,
	type IndicatorRef,
	type Interval,
	type SeriesName,
	type ValueRef,
	type WatchBar,
} from "./types.ts";

export const MAX_CLAUSES = 10;
export const MAX_DEPTH = 3;
export const MAX_CONFIRM_BARS = 10;
export const MAX_PERIOD = 500;
export const MAX_WITHIN = 50;
export const MAX_RVOL_LENGTH = 30;
/** 예전 고정 예열 — 이름 값만 쓰는 조건의 상한 (ma60 + 여유) */
export const WARMUP_BARS = 80;

/** 시장별로 한 번에 받을 수 있는 봉 수 — 예열·미리보기의 상한 (코인은 Binance 이어 받기 5번, 주식은 일봉 이어 받기) */
export function maxBarsFor(c: Pick<Condition, "market" | "interval">): number {
	if (!isStock(c.market.venue)) return 5000;
	return c.interval === "1w" ? 110 : 550;
}

/** 이름 값 → 매개변수 값 (계산을 한 곳에서) */
const NAMED: Readonly<Partial<Record<SeriesName, IndicatorRef>>> = {
	ma5: { ind: "sma", period: 5 },
	ma20: { ind: "sma", period: 20 },
	ma60: { ind: "sma", period: 60 },
	rsi14: { ind: "rsi", period: 14 },
	vol_ratio20: { ind: "vol_ratio", period: 20 },
};

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
type Ctx = Pick<Condition, "market" | "interval">;

// ── 트리 도우미 ────────────────────────────────────────────────────────

export const isClause = (n: CondNode): n is Clause => typeof n === "object" && n !== null && "op" in n;

/** 트리의 절 전부 */
export function clausesOf(nodes: CondNode[]): Clause[] {
	const out: Clause[] = [];
	const walk = (n: CondNode): void => {
		if (isClause(n)) out.push(n);
		else if ("all" in n) n.all.forEach(walk);
		else if ("any" in n) n.any.forEach(walk);
		else if ("within" in n) walk(n.cond);
	};
	nodes.forEach(walk);
	return out;
}

/** 절에 쓰인 값 전부 */
export function refsOf(nodes: CondNode[]): ValueRef[] {
	return clausesOf(nodes).flatMap((cl) => (typeof cl.right === "number" ? [cl.left] : [cl.left, cl.right]));
}

// ── 값 계산 ────────────────────────────────────────────────────────────

const field = (bars: WatchBar[], f: Field): number[] => bars.map((b) => b[f]);
const shift = (s: Series, n: number): Series => (n <= 0 ? s : s.map((_, i) => (i - n >= 0 ? (s[i - n] ?? null) : null)));

/** 거래량 ÷ 직전 N봉 평균 (자기 자신은 평균에 넣지 않는다) */
function volRatio(bars: WatchBar[], period: number): Series {
	const avg = sma(field(bars, "volume"), period);
	return bars.map((b, i) => {
		const prev = i > 0 ? avg[i - 1] : null;
		return prev ? b.volume / prev : null;
	});
}

/** N봉 최고·최저 — offset 봉 전까지 (offset 1 = 지금 봉 제외) */
function extreme(values: number[], period: number, offset: number, pick: "max" | "min"): Series {
	return values.map((_, i) => {
		const end = i - offset;
		const start = end - period + 1;
		if (start < 0) return null;
		let v = values[start] as number;
		for (let j = start + 1; j <= end; j++) v = pick === "max" ? Math.max(v, values[j] as number) : Math.min(v, values[j] as number);
		return v;
	});
}

/** 기준 구간(그날)의 시작 — 코인 분·시간봉은 UTC 00:00, 주식 분·시간봉은 그날 장 시작. 일봉 이상은 null (봉 하나가 구간) */
function anchorOf(ctx: Ctx): ((t: number) => number) | null {
	if (ctx.interval === "1d" || ctx.interval === "1w") return null;
	const v = ctx.market.venue;
	if (!isStock(v)) return (t) => cryptoBarStart(t, "1d");
	return (t) => stockDayStart(v, localDate(t, MARKETS[v].tz).ymd);
}

/**
 * 같은 시각 대비 거래량 (TradingView Relative Volume at Time 정의).
 * 지금 봉이 기준 구간 시작에서 얼마나 지났는지(오프셋)를 구하고, 지난 length 개 구간에서 같은 오프셋(없으면 그 직전 봉)의 값 평균과 비교한다.
 * cumulative: 구간 시작부터 누적 / regular: 그 봉 하나. 기준 구간이 봉보다 짧거나 같으면(일봉 이상) 직전 length 봉 평균 대비.
 */
function rvol(bars: WatchBar[], ctx: Ctx, length: number, mode: "cumulative" | "regular"): Series {
	const anchor = anchorOf(ctx);
	if (!anchor) {
		const avg = sma(field(bars, "volume"), length);
		return bars.map((b, i) => {
			const prev = i > 0 ? avg[i - 1] : null;
			return prev ? b.volume / prev : null;
		});
	}
	// 구간별로 (오프셋, 값) 목록
	type Pt = { off: number; vol: number; cum: number };
	const groups: Pt[][] = [];
	const where: Array<{ g: number; k: number }> = [];
	let key = Number.NaN;
	for (const b of bars) {
		const a = anchor(b.t);
		if (a !== key) {
			groups.push([]);
			key = a;
		}
		const g = groups[groups.length - 1] as Pt[];
		const cum = (g.at(-1)?.cum ?? 0) + b.volume;
		where.push({ g: groups.length - 1, k: g.length });
		g.push({ off: b.t - a, vol: b.volume, cum });
	}
	const pick = (p: Pt) => (mode === "regular" ? p.vol : p.cum);
	return where.map(({ g, k }) => {
		if (g - length < 0) return null;
		const me = (groups[g] as Pt[])[k] as Pt;
		let sum = 0;
		for (let h = g - length; h < g; h++) {
			const prev = groups[h] as Pt[];
			let hit: Pt | undefined;
			for (const p of prev) if (p.off <= me.off) hit = p;
			if (!hit) return null;
			sum += pick(hit);
		}
		const avg = sum / length;
		return avg > 0 ? pick(me) / avg : null;
	});
}

function indicatorSeries(bars: WatchBar[], r: IndicatorRef, ctx: Ctx): Series {
	switch (r.ind) {
		case "sma":
			return sma(field(bars, r.of ?? "close"), r.period);
		case "ema":
			return ema(field(bars, r.of ?? "close"), r.period);
		case "rsi":
			return rsi(field(bars, "close"), r.period);
		case "highest":
			return extreme(field(bars, r.of ?? "high"), r.period, r.offset ?? 1, "max");
		case "lowest":
			return extreme(field(bars, r.of ?? "low"), r.period, r.offset ?? 1, "min");
		case "change_pct": {
			const x = field(bars, r.of ?? "close");
			return x.map((v, i) => {
				const base = i - r.period >= 0 ? (x[i - r.period] as number) : null;
				return base ? (v / base - 1) * 100 : null;
			});
		}
		case "vol_ratio":
			return volRatio(bars, r.period);
		case "rvol":
			return rvol(bars, ctx, r.length ?? 10, r.mode ?? "cumulative");
		case "value":
			return shift(namedSeries(bars, r.of, ctx), r.offset ?? 0);
	}
}

function namedSeries(bars: WatchBar[], name: SeriesName, ctx: Ctx): Series {
	const mapped = NAMED[name];
	if (mapped) return indicatorSeries(bars, mapped, ctx);
	const closes = field(bars, "close");
	switch (name) {
		case "close":
		case "open":
		case "high":
		case "low":
		case "volume":
			return field(bars, name);
		case "vol_chg_pct":
			// 직전 봉이 0 (거래정지·빈 봉) 이면 판정하지 않는다
			return bars.map((b, i) => {
				const prev = i > 0 ? (bars[i - 1] as WatchBar).volume : 0;
				return prev > 0 ? (b.volume / prev - 1) * 100 : null;
			});
		case "bb_upper":
			return bollinger(closes, 20, 2).upper;
		case "bb_lower":
			return bollinger(closes, 20, 2).lower;
		case "atr14":
			return atr(
				bars.map((b) => ({ date: String(b.t), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
				14,
			);
		default:
			return bars.map(() => null);
	}
}

const DEFAULT_CTX: Ctx = { market: { venue: "binance", symbol: "" }, interval: "1h" };

/** 값 → 봉마다의 값 (모자란 구간은 null). mul 은 여기서 곱한다 */
export function seriesOf(bars: WatchBar[], ref: ValueRef, ctx: Ctx = DEFAULT_CTX): Series {
	const raw = typeof ref === "string" ? namedSeries(bars, ref, ctx) : indicatorSeries(bars, ref, ctx);
	const mul = typeof ref === "string" ? undefined : ref.mul;
	return mul === undefined ? raw : raw.map((v) => (v == null ? null : v * mul));
}

// ── 예열 ───────────────────────────────────────────────────────────────

/** 값마다 안정되려면 필요한 봉 수 (RSI·EMA·ATR 은 평활이라 기간의 3배쯤) */
const NAMED_WARMUP: Readonly<Record<SeriesName, number>> = {
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

/** 기준 구간(그날) 하나에 봉이 몇 개인가 — rvol 예열 */
function barsPerAnchor(ctx: Ctx): number {
	if (ctx.interval === "1d" || ctx.interval === "1w") return 1;
	const v = ctx.market.venue;
	if (!isStock(v)) return Math.ceil(DAY / CRYPTO_STEP[ctx.interval]);
	const m = MARKETS[v];
	const [oh, om] = m.open.split(":").map(Number) as [number, number];
	const [ch, cm] = m.close.split(":").map(Number) as [number, number];
	return Math.ceil(((ch - oh) * 60 + (cm - om)) * MIN / CRYPTO_STEP[ctx.interval]);
}

export function refWarmup(ref: ValueRef, ctx: Ctx): number {
	if (typeof ref === "string") return NAMED_WARMUP[ref] ?? WARMUP_BARS;
	switch (ref.ind) {
		case "sma":
			return ref.period;
		case "ema":
		case "rsi":
			return Math.min(MAX_PERIOD * 3, ref.period * 3 + 1);
		case "highest":
		case "lowest":
			return ref.period + (ref.offset ?? 1);
		case "change_pct":
		case "vol_ratio":
			return ref.period + 1;
		case "rvol":
			return ((ref.length ?? 10) + 1) * barsPerAnchor(ctx);
		case "value":
			return refWarmup(ref.of, ctx) + (ref.offset ?? 0);
	}
}

function nodeWarmup(n: CondNode, ctx: Ctx): number {
	if (isClause(n)) {
		const cross = n.op === "crosses_above" || n.op === "crosses_below" ? 1 : 0;
		return Math.max(refWarmup(n.left, ctx), typeof n.right === "number" ? 0 : refWarmup(n.right, ctx)) + cross;
	}
	if ("all" in n) return Math.max(1, ...n.all.map((x) => nodeWarmup(x, ctx)));
	if ("any" in n) return Math.max(1, ...n.any.map((x) => nodeWarmup(x, ctx)));
	return nodeWarmup(n.cond, ctx) + n.within - 1;
}

/** 조건 기준 예열 봉 수 (+ 연속 봉) — 조회량을 조건에 맞춘다 */
export function warmupFor(c: Condition): number {
	return Math.max(1, ...c.all.map((n) => nodeWarmup(n, c))) + Math.max(0, c.confirmBars - 1);
}

// ── 검증 ───────────────────────────────────────────────────────────────

const intIn = (v: unknown, lo: number, hi: number): boolean => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

function refErrors(ref: unknown, at: string): string[] {
	if (typeof ref === "string") return SERIES.includes(ref as SeriesName) ? [] : [`${at}: 모르는 값 ${ref} — ${SERIES.join(", ")} 또는 { ind: ${INDICATORS.join("|")} }`];
	if (!ref || typeof ref !== "object") return [`${at}: 값이 올바르지 않습니다`];
	const r = ref as Record<string, unknown>;
	const e: string[] = [];
	if (!INDICATORS.includes(r.ind as never)) return [`${at}: 모르는 지표 ${String(r.ind)} — ${INDICATORS.join(", ")}`];
	if (r.mul !== undefined && !(typeof r.mul === "number" && r.mul > 0 && r.mul <= 100)) e.push(`${at}: mul 은 0보다 크고 100 이하`);
	if (r.of !== undefined && r.ind !== "value" && !FIELDS.includes(r.of as Field)) e.push(`${at}: of 는 ${FIELDS.join(" · ")}`);
	const needPeriod = ["sma", "ema", "rsi", "highest", "lowest", "change_pct", "vol_ratio"];
	if (needPeriod.includes(r.ind as string) && !intIn(r.period, r.ind === "rsi" ? 2 : 1, MAX_PERIOD)) e.push(`${at}: period 는 ${r.ind === "rsi" ? 2 : 1}~${MAX_PERIOD} 정수`);
	if (r.offset !== undefined && !intIn(r.offset, 0, 100)) e.push(`${at}: offset 은 0~100 정수`);
	if (r.ind === "rvol") {
		if (r.length !== undefined && !intIn(r.length, 1, MAX_RVOL_LENGTH)) e.push(`${at}: rvol length 는 1~${MAX_RVOL_LENGTH}일`);
		if (r.mode !== undefined && r.mode !== "cumulative" && r.mode !== "regular") e.push(`${at}: rvol mode 는 cumulative · regular`);
	}
	if (r.ind === "value") e.push(...refErrors(r.of, `${at}.of`));
	return e;
}

function nodeErrors(n: unknown, at: string, depth: number): string[] {
	if (!n || typeof n !== "object") return [`${at}: 조건이 올바르지 않습니다`];
	const o = n as Record<string, unknown>;
	if (depth > MAX_DEPTH) return [`${at}: 묶음은 ${MAX_DEPTH}단계까지`];
	if ("op" in o) {
		const e = [...refErrors(o.left, `${at} 왼쪽`)];
		if (!OPS.includes(o.op as never)) e.push(`${at}: 모르는 비교 ${String(o.op)} — ${OPS.join(", ")}`);
		if (typeof o.right === "number") {
			if (!Number.isFinite(o.right)) e.push(`${at}: 비교할 숫자가 올바르지 않습니다`);
		} else e.push(...refErrors(o.right, `${at} 오른쪽`));
		if (JSON.stringify(o.left) === JSON.stringify(o.right)) e.push(`${at}: 같은 값끼리 비교합니다`);
		return e;
	}
	for (const k of ["all", "any"] as const) {
		if (k in o) {
			const list = o[k];
			if (!Array.isArray(list) || list.length === 0) return [`${at}: ${k} 에 조건이 하나 이상 필요합니다`];
			return list.flatMap((x, i) => nodeErrors(x, `${at}.${k}[${i + 1}]`, depth + 1));
		}
	}
	if ("within" in o) {
		const e = intIn(o.within, 1, MAX_WITHIN) ? [] : [`${at}: within 은 1~${MAX_WITHIN}봉`];
		return [...e, ...nodeErrors(o.cond, `${at}.cond`, depth + 1)];
	}
	return [`${at}: 절({left, op, right}) · all · any · within 중 하나여야 합니다`];
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
	if (c.market.feed) {
		if (!isStock(venue)) errors.push("코인은 시세 출처를 고르지 않습니다 (Binance 공개 시세)");
		else errors.push(...feedErrors(venue, c.market.feed));
	}
	if (c.when !== "bar_close") errors.push("판정 시점은 봉 마감(bar_close)만 됩니다");
	if (c.fire !== "on_enter") errors.push("발동 방식은 on_enter 만 됩니다");
	if (!intIn(c.confirmBars, 1, MAX_CONFIRM_BARS)) errors.push(`연속 봉 수는 1~${MAX_CONFIRM_BARS} 입니다`);
	if (!Array.isArray(c.all) || c.all.length === 0) {
		errors.push("조건이 하나 이상 필요합니다");
		return errors;
	}
	const treeErrors = c.all.flatMap((n, i) => nodeErrors(n, `조건 ${i + 1}`, 1));
	errors.push(...treeErrors);
	if (treeErrors.length === 0) {
		const count = clausesOf(c.all).length;
		if (count > MAX_CLAUSES) errors.push(`조건은 모두 합쳐 ${MAX_CLAUSES}개까지입니다 (지금 ${count}개)`);
		if (INTERVALS.includes(c.interval)) {
			const warm = warmupFor(c);
			const max = maxBarsFor(c);
			if (warm >= max) errors.push(`지표 기간이 너무 깁니다 — 이 시장·봉에서는 예열 ${warm}봉이 필요한데 ${max}봉까지만 받을 수 있습니다`);
		}
	}
	return errors;
}

// ── 판정 ───────────────────────────────────────────────────────────────

type Cache = Map<string, Series>;
type Hits = Array<boolean | null>;

function cachedSeries(bars: WatchBar[], ref: ValueRef, ctx: Ctx, cache: Cache): Series {
	const k = typeof ref === "string" ? ref : JSON.stringify(ref);
	let s = cache.get(k);
	if (!s) {
		s = seriesOf(bars, ref, ctx);
		cache.set(k, s);
	}
	return s;
}

function clauseHits(cl: Clause, bars: WatchBar[], ctx: Ctx, cache: Cache): Hits {
	const left = cachedSeries(bars, cl.left, ctx, cache);
	const right: Series = typeof cl.right === "number" ? bars.map(() => cl.right as number) : cachedSeries(bars, cl.right, ctx, cache);
	return bars.map((_, i) => {
		const l = left[i];
		const r = right[i];
		if (l == null || r == null) return null;
		switch (cl.op) {
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
				return cl.op === "crosses_above" ? pl <= pr && l > r : pl >= pr && l < r;
			}
		}
	});
}

function nodeHits(n: CondNode, bars: WatchBar[], ctx: Ctx, cache: Cache): Hits {
	if (isClause(n)) return clauseHits(n, bars, ctx, cache);
	if ("all" in n) {
		const per = n.all.map((x) => nodeHits(x, bars, ctx, cache));
		// 하나라도 거짓이면 거짓, 모르는 게 있으면 모름
		return bars.map((_, i) => {
			let unknown = false;
			for (const h of per) {
				const v = h[i];
				if (v === false) return false;
				if (v == null) unknown = true;
			}
			return unknown ? null : true;
		});
	}
	if ("any" in n) {
		const per = n.any.map((x) => nodeHits(x, bars, ctx, cache));
		// 하나라도 참이면 참, 모르는 게 있으면 모름
		return bars.map((_, i) => {
			let unknown = false;
			for (const h of per) {
				const v = h[i];
				if (v === true) return true;
				if (v == null) unknown = true;
			}
			return unknown ? null : false;
		});
	}
	// within: 최근 N봉(지금 포함) 안에 한 번이라도 참. 창이 다 모름이면 모름
	const inner = nodeHits(n.cond, bars, ctx, cache);
	return bars.map((_, i) => {
		if (i - n.within + 1 < 0) return null;
		let known = false;
		for (let j = i - n.within + 1; j <= i; j++) {
			if (inner[j] === true) return true;
			if (inner[j] === false) known = true;
		}
		return known ? false : null;
	});
}

/** 봉별 전체 판정 (최상위는 AND) */
export function evaluate(c: Condition, bars: WatchBar[]): Hits {
	return nodeHits({ all: c.all }, bars, c, new Map());
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
	return evaluate(c, bars).at(-1) ?? null;
}

/** 값 표시용 키 — 이름은 그대로, 매개변수 값은 짧은 이름 (\"sma50\", \"highest20\") */
export function refKey(ref: ValueRef): string {
	if (typeof ref === "string") return ref;
	switch (ref.ind) {
		case "rvol":
			return `rvol${ref.length ?? 10}${ref.mode === "regular" ? "r" : ""}`;
		case "value":
			return `${ref.of}[-${ref.offset ?? 0}]`;
		default:
			return `${ref.ind}${ref.period}${"of" in ref && ref.of ? `_${ref.of}` : ""}`;
	}
}

/** 평가할 때 쓴 값 — 이벤트 기록·알림용. 키는 refKey, 배수 전 값이 아니라 배수를 곱한 값 */
export function valuesAt(c: Condition, bars: WatchBar[], i: number): Record<string, number> {
	const refs: ValueRef[] = ["close", ...refsOf(c.all)];
	const out: Record<string, number> = {};
	for (const r of refs) {
		const v = seriesOf(bars, r, c)[i];
		if (v != null) out[refKey(r) + (typeof r !== "string" && r.mul !== undefined ? `x${r.mul}` : "")] = Math.round(v * 1e6) / 1e6;
	}
	return out;
}
