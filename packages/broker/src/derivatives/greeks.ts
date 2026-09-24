/**
 * 옵션 가격·그릭스·내재변동성 — 순수 계산 (PLAN §37).
 *
 * 일반화 Black-Scholes (Haug, "The Complete Guide to Option Pricing Formulas") 하나로 두 모델을 다룬다:
 *   - bsm   : 현물 기초자산 (KOSPI200 지수·주식) — 보유비용 b = r − q (q = 배당수익률)
 *   - black76: 선물 기초자산 (해외 선물옵션) — S 자리에 선물가격 F, b = 0
 * 모든 비율은 소수(0.2 = 20%), 기간은 연 단위. 표시 단위 변환(베가 1%p, 세타 1일)은 함수가 명시한다.
 */

export type OptionType = "call" | "put";
export type OptionModel = "bsm" | "black76";

export interface OptionInput {
	type: OptionType;
	model: OptionModel;
	/** 기초자산 가격 (black76 은 선물가격) */
	underlying: number;
	strike: number;
	/** 만기까지 연 단위 (일수 / 365) */
	years: number;
	/** 무위험금리 (연, 소수) */
	rate: number;
	/** 배당수익률 (bsm 만, 연, 소수) */
	dividend?: number;
	/** 변동성 (연, 소수) */
	vol: number;
}

export interface Greeks {
	price: number;
	/** 기초자산 1 움직일 때 옵션 가격 변화 */
	delta: number;
	/** 기초자산 1 움직일 때 델타 변화 */
	gamma: number;
	/** 변동성 1%p 오를 때 가격 변화 */
	vega: number;
	/** 하루(달력일) 지날 때 가격 변화 */
	theta: number;
	/** 금리 1%p 오를 때 가격 변화 */
	rho: number;
}

const SQRT_2PI = Math.sqrt(2 * Math.PI);
export const normPdf = (x: number): number => Math.exp(-0.5 * x * x) / SQRT_2PI;

/**
 * 표준정규 누적분포.
 * |x| ≤ 3: Marsaglia(2004) 테일러 급수 — 배정밀도 끝까지 맞는다.
 * 그 밖: 꼬리를 밀스 비 연분수로 직접 구한다 — 0.5 에서 빼면 먼 외가격 옵션의 상대 오차가 커진다.
 */
export function normCdf(x: number): number {
	if (Number.isNaN(x)) return Number.NaN;
	if (Math.abs(x) <= 3) {
		let s = x;
		let t = 0;
		let b = x;
		const q = x * x;
		let i = 1;
		while (s !== t) {
			t = s;
			i += 2;
			b *= q / i;
			s = t + b;
		}
		return 0.5 + s * Math.exp(-0.5 * q - 0.91893853320467274178);
	}
	const z = Math.abs(x);
	if (z > 38) return x > 0 ? 1 : 0;
	// Q(z) = φ(z) / (z + 1/(z + 2/(z + 3/(z + …)))) — 뒤에서부터 계산
	let cf = z;
	for (let k = 80; k >= 1; k--) cf = z + k / cf;
	const tail = normPdf(z) / cf;
	return x > 0 ? 1 - tail : tail;
}

function carry(i: OptionInput): number {
	return i.model === "black76" ? 0 : i.rate - (i.dividend ?? 0);
}

function check(i: OptionInput): void {
	for (const [k, v] of Object.entries({ underlying: i.underlying, strike: i.strike, years: i.years, vol: i.vol })) {
		if (!Number.isFinite(v) || v <= 0) throw new Error(`${k} 는 0 보다 커야 합니다: ${v}`);
	}
	if (!Number.isFinite(i.rate)) throw new Error(`rate 가 올바르지 않습니다: ${i.rate}`);
}

export function optionPrice(i: OptionInput): number {
	check(i);
	const { underlying: S, strike: K, years: T, rate: r, vol: v } = i;
	const b = carry(i);
	const sq = v * Math.sqrt(T);
	const d1 = (Math.log(S / K) + (b + (v * v) / 2) * T) / sq;
	const d2 = d1 - sq;
	const df = Math.exp(-r * T);
	const fwd = S * Math.exp((b - r) * T);
	return i.type === "call" ? fwd * normCdf(d1) - K * df * normCdf(d2) : K * df * normCdf(-d2) - fwd * normCdf(-d1);
}

export function greeks(i: OptionInput): Greeks {
	check(i);
	const { underlying: S, strike: K, years: T, rate: r, vol: v } = i;
	const b = carry(i);
	const sqT = Math.sqrt(T);
	const d1 = (Math.log(S / K) + (b + (v * v) / 2) * T) / (v * sqT);
	const d2 = d1 - v * sqT;
	const df = Math.exp(-r * T);
	const ebr = Math.exp((b - r) * T);
	const call = i.type === "call";
	const price = optionPrice(i);
	const delta = call ? ebr * normCdf(d1) : ebr * (normCdf(d1) - 1);
	const gamma = (ebr * normPdf(d1)) / (S * v * sqT);
	const vega = S * ebr * normPdf(d1) * sqT;
	const decay = -(S * ebr * normPdf(d1) * v) / (2 * sqT);
	const thetaYear = call
		? decay - (b - r) * S * ebr * normCdf(d1) - r * K * df * normCdf(d2)
		: decay + (b - r) * S * ebr * normCdf(-d1) + r * K * df * normCdf(-d2);
	// 선물옵션은 금리가 할인에만 들어간다 (∂/∂r = −T·가격). 현물옵션은 보유비용에도 들어간다.
	const rho = i.model === "black76" ? -T * price : call ? T * K * df * normCdf(d2) : -T * K * df * normCdf(-d2);
	return { price, delta, gamma, vega: vega / 100, theta: thetaYear / 365, rho: rho / 100 };
}

export interface IvResult {
	vol: number | null;
	/** vol 이 null 인 까닭 */
	reason?: string;
}

/**
 * 시장가격에서 내재변동성을 역산한다 — 이분법 (가격이 변동성에 대해 단조 증가라 항상 수렴한다).
 * 무차익 범위를 벗어난 가격(시간가치가 음수 등)은 변동성이 없다고 답한다.
 */
export function impliedVol(i: Omit<OptionInput, "vol">, marketPrice: number): IvResult {
	if (!Number.isFinite(marketPrice) || marketPrice <= 0) return { vol: null, reason: "가격이 0 이하입니다" };
	const at = (vol: number): number => optionPrice({ ...i, vol });
	const lo0 = 1e-4;
	const hi0 = 5;
	const lo = at(lo0);
	const hi = at(hi0);
	if (marketPrice < lo - 1e-9 * Math.max(1, lo)) return { vol: null, reason: `가격 ${marketPrice} 이(가) 내재가치(약 ${round(lo, 4)})보다 낮습니다 — 호가 공백이거나 체결이 오래됐을 수 있습니다` };
	if (marketPrice > hi) return { vol: null, reason: `가격 ${marketPrice} 이(가) 변동성 500% 가격보다 높습니다` };
	let a = lo0;
	let z = hi0;
	for (let k = 0; k < 200 && z - a > 1e-10; k++) {
		const m = (a + z) / 2;
		if (at(m) < marketPrice) a = m;
		else z = m;
	}
	return { vol: (a + z) / 2 };
}

export const round = (x: number, d: number): number => {
	const p = 10 ** d;
	return Math.round(x * p) / p;
};

export interface ScenarioCell {
	move: number;
	days: number;
	price: number;
	/** 계약 1개 기준 손익 (승수 반영), 보유 수량 반영은 호출자가 */
	change: number;
}

/**
 * 기초자산 변화 × 경과일 시나리오 — 변동성은 그대로 둔다.
 * moves 는 비율(0.01 = +1%), 만기를 넘는 경과일은 하루 남은 것으로 본다(만기 직전 가치).
 */
export function scenarioGrid(i: OptionInput, moves: number[], days: number[], multiplier: number): ScenarioCell[] {
	const now = optionPrice(i);
	const out: ScenarioCell[] = [];
	for (const d of days) {
		const years = Math.max(1 / 365, i.years - d / 365);
		for (const m of moves) {
			const p = optionPrice({ ...i, underlying: i.underlying * (1 + m), years });
			out.push({ move: m, days: d, price: p, change: (p - now) * multiplier });
		}
	}
	return out;
}
