/**
 * 호가 단위 — 체결기가 가격을 맞추고 한 호가씩 움직일 때 (PLAN §40 2단계).
 *
 * 단위는 주문 검증과 같은 표(`orders.tickSize`): 국장 2023 개편 표, 미장 $0.01.
 * 국장 ETF 는 실제 단위가 더 촘촘하지만(5원) 표의 단위가 늘 그 배수라, 표로 맞춘 가격은 항상 유효하다 (조금 거칠 뿐).
 * 국장 구간 경계(2,000 · 5,000 · …)는 모두 윗 구간 단위의 배수라 경계를 넘어도 유효한 가격이 된다.
 */
import { tickSize, type Market } from "../../orders.ts";

/** 미장은 센트 정수로 — 4.35 / 0.01 = 434.999… 같은 부동소수점 잡음을 피한다 */
const cents = (p: number): number => Math.round(p * 1_000_000) / 10_000;

/**
 * 유효한 가격으로 맞춘다. down = 그 이하에서 가장 가까운 값, up = 그 이상에서 가장 가까운 값.
 * 매수 상한(최악 허용가)은 down, 매도 하한은 up — 허용 범위 밖으로 나가지 않게.
 */
export function roundPrice(market: Market, price: number, dir: "down" | "up"): number {
	if (!(price > 0)) return 0;
	if (market === "US") {
		const c = cents(price);
		const r = dir === "down" ? Math.floor(c + 1e-6) : Math.ceil(c - 1e-6);
		return r / 100;
	}
	const t = tickSize(market, price);
	const q = price / t;
	return (dir === "down" ? Math.floor(q + 1e-9) : Math.ceil(q - 1e-9)) * t;
}

/** 한 호가 위(+1)·아래(−1). 아래로 갈 때는 바로 아래 구간의 단위를 쓴다 (50,000 → 49,950) */
export function stepPrice(market: Market, price: number, dir: 1 | -1): number {
	if (market === "US") return (Math.round(cents(price)) + dir) / 100;
	if (dir === 1) return roundPrice(market, price + tickSize(market, price), "down");
	return roundPrice(market, price - tickSize(market, price - 1), "down");
}

/** 증권사에 보낼 가격 문자열 — 국장 정수, 미장 소수 둘째 자리 */
export function priceText(market: Market, price: number): string {
	return market === "US" ? price.toFixed(2) : String(Math.round(price));
}
