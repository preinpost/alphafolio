/**
 * 코인 수량·가격용 10진 계산 — **부동소수점을 쓰지 않는다.**
 *
 * Binance 수량·가격은 소수 8자리까지이고 거래소가 단위(stepSize·tickSize)에 안 맞으면 거절한다.
 * Number 로 나누고 내리면 0.3 / 0.1 = 2.9999… 처럼 한 단위가 깎인다 — 미국 호가 1센트 버그와 같은 종류 (PLAN §29).
 * 그래서 문자열을 BigInt 정수(10^scale 배)로 바꿔 계산하고 문자열로 돌려준다.
 */

export interface Dec {
	/** 10^scale 배 한 정수 */
	n: bigint;
	scale: number;
}

const DEC_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

export function parseDec(v: string | number): Dec {
	const s = typeof v === "number" ? numberToPlain(v) : v.trim();
	const m = DEC_RE.exec(s);
	if (!m) throw new Error(`숫자가 아닙니다: ${v}`);
	const frac = m[3] ?? "";
	const n = BigInt(`${m[2]}${frac}` || "0");
	return { n: m[1] ? -n : n, scale: frac.length };
}

/** 지수 표기(1e-7) 없이 */
function numberToPlain(v: number): string {
	if (!Number.isFinite(v)) throw new Error(`숫자가 아닙니다: ${v}`);
	const s = String(v);
	if (!/e/i.test(s)) return s;
	return v.toFixed(12).replace(/\.?0+$/, "");
}

function rescale(d: Dec, scale: number): bigint {
	return scale >= d.scale ? d.n * 10n ** BigInt(scale - d.scale) : d.n / 10n ** BigInt(d.scale - scale);
}

export function formatDec(d: Dec): string {
	const neg = d.n < 0n;
	const abs = (neg ? -d.n : d.n).toString().padStart(d.scale + 1, "0");
	const int = d.scale > 0 ? abs.slice(0, -d.scale) : abs;
	const frac = d.scale > 0 ? abs.slice(-d.scale).replace(/0+$/, "") : "";
	return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

export function cmpDec(a: string | number, b: string | number): number {
	const x = parseDec(a);
	const y = parseDec(b);
	const s = Math.max(x.scale, y.scale);
	const d = rescale(x, s) - rescale(y, s);
	return d > 0n ? 1 : d < 0n ? -1 : 0;
}

/** 단위(step)의 배수로 내림 — step 이 0 이면 그대로 */
export function floorToStep(v: string | number, step: string): string {
	const x = parseDec(v);
	const st = parseDec(step);
	if (st.n === 0n) return formatDec(x);
	const s = Math.max(x.scale, st.scale);
	const xv = rescale(x, s);
	const sv = rescale(st, s);
	const q = xv >= 0n ? xv / sv : -((-xv + sv - 1n) / sv);
	return formatDec({ n: q * sv, scale: s });
}

export function isMultipleOf(v: string | number, step: string): boolean {
	return cmpDec(floorToStep(v, step), v) === 0;
}

export function subDec(a: string | number, b: string | number): string {
	const x = parseDec(a);
	const y = parseDec(b);
	const s = Math.max(x.scale, y.scale);
	return formatDec({ n: rescale(x, s) - rescale(y, s), scale: s });
}

export function mulDec(a: string | number, b: string | number): string {
	const x = parseDec(a);
	const y = parseDec(b);
	return formatDec({ n: x.n * y.n, scale: x.scale + y.scale });
}

/** 표시용 비율 — (a / b - 1) × 100, 소수 1자리 (판정에는 쓰지 않는다) */
export function pctDiff(a: string, b: string): number {
	const x = Number(a);
	const y = Number(b);
	return y > 0 ? Math.round((x / y - 1) * 1000) / 10 : 0;
}
