/** 반복 박스권 매매 — 비용 포함 손익·상태 전이. 조회·주문 없는 순수 함수. */
import type { Condition, ProtectLevel } from "./types.ts";
import type { ChildOrder, ExecReport } from "./executor.ts";

/** 기존 NOT NULL 만료 컬럼과 호환. 화면에서는 '정지할 때까지'로 표시한다. */
export const RANGE_FOREVER = "9999-12-31T23:59:59.999Z";
export const RANGE_RISK_MS = 5_000;
export const RANGE_PHASE_LABEL = {
	buying: "매수 대기",
	holding: "매도 대기",
	liquidating: "손절 처리 중",
	stopped: "손절 후 정지",
	blocked: "확인 필요",
} as const;

export interface RangeState {
	phase: keyof typeof RANGE_PHASE_LABEL;
	/** 수수료로 차감된 기준 자산까지 반영한 전략 잔여 수량 */
	qty: number;
	/** 잔여 수량에 배분된 매수 비용 포함 원가 */
	cost: number;
	buyEstimated: boolean;
	realizedPnl: number;
	pnlEstimated: boolean;
	/** 정상 매도·손절·거래 불가 잔량 분리로 관리가 끝난 회차 */
	cycles: number;
	/** 실제 체결·결과 모름 실행 수. 보고 반영과 함께 저장해 복구 시에도 일관되게 센다. */
	executions: number;
	/** 거래소 단위 미만 잔량은 매도했다고 간주하지 않고 별도로 남긴다 */
	dustQty: number;
	dustCost: number;
	/** 보고 반영과 체결 완료 기록 사이에 죽어도 이중 반영하지 않는다 */
	lastExecId: string | null;
	pendingExecId: string | null;
	lastTradeBarT: number | null;
}

export interface RangeTrade {
	buyPrice: number;
	sellPrice: number;
	/** pct는 양수 하락률. 가격 또는 손실률 중 하나. */
	stop: ProtectLevel;
	/** % 단위. 계좌별 수수료·매도세 등 총비용률. 0도 명시적으로 입력해야 한다. */
	buyCostPct: number;
	sellCostPct: number;
	state: RangeState;
}

export function initialRangeState(): RangeState {
	return {
		phase: "buying",
		qty: 0,
		cost: 0,
		buyEstimated: false,
		realizedPnl: 0,
		pnlEstimated: false,
		cycles: 0,
		executions: 0,
		dustQty: 0,
		dustCost: 0,
		lastExecId: null,
		pendingExecId: null,
		lastTradeBarT: null,
	};
}

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
const validCostRate = (value: number): boolean => Number.isFinite(value) && value >= 0 && value < 100;

export function validateRange(range: RangeTrade): string[] {
	const errors: string[] = [];
	if (!positive(range.buyPrice) || !positive(range.sellPrice) || range.sellPrice <= range.buyPrice) {
		errors.push("매도 기준가는 매수 기준가보다 높아야 합니다");
	}
	if (!validCostRate(range.buyCostPct)) errors.push("매수 비용률(%)은 0 이상 100 미만으로 명시해야 합니다");
	if (!validCostRate(range.sellCostPct)) errors.push("매도 비용률(%)은 0 이상 100 미만으로 명시해야 합니다");

	const stop = range.stop;
	if (!stop || ("pct" in stop) === ("price" in stop)) {
		errors.push("로스컷은 가격 또는 평가손실률 중 하나만 정합니다");
	} else if ("pct" in stop && (!positive(stop.pct) || stop.pct >= 100)) {
		errors.push("로스컷 손실률은 0 초과 100 미만입니다");
	} else if ("price" in stop && (!positive(stop.price) || stop.price >= range.buyPrice)) {
		errors.push("로스컷 가격은 0보다 크고 매수 기준가보다 낮아야 합니다");
	}
	return errors;
}

export function rangeCondition(base: Pick<Condition, "market" | "interval">, range: Pick<RangeTrade, "buyPrice" | "sellPrice">): Condition {
	return {
		...base,
		when: "bar_close",
		all: [{ any: [
			{ left: "close", op: "<=", right: range.buyPrice },
			{ left: "close", op: ">=", right: range.sellPrice },
		] }],
		confirmBars: 1,
		fire: "while_true",
	};
}

/** 즉시 매도 가능한 최우선 매수호가 기준. 매도 비용은 아직 체결 전이므로 항상 추정. */
export function rangeValuation(range: RangeTrade, bid: number): { netProceeds: number; pnl: number; pnlPct: number } | null {
	const { qty, cost } = range.state;
	if (!positive(qty) || !positive(cost) || !positive(bid)) return null;
	const netProceeds = bid * qty * (1 - range.sellCostPct / 100);
	const pnl = netProceeds - cost;
	return { netProceeds, pnl, pnlPct: pnl / cost * 100 };
}

export function rangeStopHit(range: RangeTrade, bid: number): boolean {
	const valuation = rangeValuation(range, bid);
	if (!valuation) return false;
	if ("price" in range.stop) return bid <= range.stop.price;
	return valuation.pnlPct <= -range.stop.pct + 1e-9;
}

export function rangeStopText(range: Pick<RangeTrade, "stop">): string {
	if ("price" in range.stop) return `가격 ≤ ${range.stop.price.toLocaleString("en-US")}에 손절 후 정지`;
	return `비용 포함 평가손익률 ≤ −${range.stop.pct}%에 손절 후 정지`;
}

export function rangeCostText(range: Pick<RangeTrade, "buyCostPct" | "sellCostPct">): string {
	return `미확인 비용 추정률: 매수 ${range.buyCostPct}% · 매도 ${range.sellCostPct}% (세금 포함)`;
}

export function rangeText(range: RangeTrade): string {
	const prices = `${range.buyPrice.toLocaleString("en-US")} → ${range.sellPrice.toLocaleString("en-US")}`;
	return `박스권 ${prices} 반복 · ${RANGE_PHASE_LABEL[range.state.phase]} · ${rangeStopText(range)} · ${rangeCostText(range)}`;
}

interface FillCost {
	qty: number;
	amount: number;
	estimated: boolean;
}

function childFees(child: ChildOrder, fallbackPrice: number, ratePct: number) {
	const settlement = child.settlement;
	const baseFee = settlement?.baseFeeQty ?? 0;
	const quoteFee = settlement?.quoteFee;
	if (!Number.isFinite(baseFee) || baseFee < 0) throw new Error("기준 자산 체결 비용이 올바르지 않습니다");
	if (quoteFee != null) {
		if (!Number.isFinite(quoteFee) || quoteFee < 0) throw new Error("금액 체결 비용이 올바르지 않습니다");
		return { baseFee, quoteFee, estimated: false };
	}
	const knownFee = settlement?.knownQuoteFee ?? 0;
	const unpricedAmount = settlement?.unpricedQuoteAmount;
	if (!Number.isFinite(knownFee) || knownFee < 0) throw new Error("확인된 금액 비용이 올바르지 않습니다");
	if (unpricedAmount !== undefined) {
		if (!Number.isFinite(unpricedAmount) || unpricedAmount < 0) throw new Error("미확인 비용의 체결금액이 올바르지 않습니다");
		return { baseFee, quoteFee: knownFee + unpricedAmount * ratePct / 100, estimated: true };
	}
	const price = child.avgPrice ?? fallbackPrice;
	// 알려진 기준 자산 수수료는 수량에서 반영하므로 추정 금액에 중복 가산하지 않는다.
	const estimatedFee = price * child.filledQty * ratePct / 100 - baseFee * price;
	return { baseFee, quoteFee: Math.max(knownFee, estimatedFee, 0), estimated: true };
}

/** 기준 자산 수수료는 수량에서 차감하므로 금액 비용에 중복 가산하지 않는다. */
export function rangeFillCost(report: ExecReport, side: "BUY" | "SELL", ratePct: number): FillCost {
	if (!validCostRate(ratePct)) throw new Error("체결 비용 추정률이 올바르지 않습니다");
	if (report.filledQty === 0) return { qty: 0, amount: 0, estimated: false };
	if (!positive(report.filledQty) || report.avgPrice === null || !positive(report.avgPrice)) {
		throw new Error("체결 수량·평단을 확인할 수 없습니다");
	}
	const fills = report.children.filter((child) => child.filledQty > 0);
	let baseFee = 0;
	let quoteFee = 0;
	let estimated = false;
	for (const child of fills) {
		const fee = childFees(child, report.avgPrice, ratePct);
		baseFee += fee.baseFee;
		quoteFee += fee.quoteFee;
		estimated ||= fee.estimated;
	}
	if (fills.length === 0) {
		estimated = true;
		quoteFee = report.avgPrice * report.filledQty * ratePct / 100;
	}
	const qty = side === "BUY" ? report.filledQty - baseFee : report.filledQty + baseFee;
	if (!positive(qty)) throw new Error("수수료 반영 후 체결 수량이 올바르지 않습니다");
	const gross = report.avgPrice * report.filledQty;
	return { qty, amount: side === "BUY" ? gross + quoteFee : gross - quoteFee, estimated };
}

function applyBuyFill(state: RangeState, fill: FillCost): void {
	if (state.qty > 0) throw new Error("보유 중 추가 매수 보고를 받았습니다");
	state.qty = fill.qty;
	state.cost = fill.amount;
	state.buyEstimated = fill.estimated;
	state.phase = "holding";
}

function applySellFill(state: RangeState, fill: FillCost): void {
	const tolerance = Math.max(1e-10, state.qty * 1e-8);
	if (fill.qty > state.qty + tolerance) throw new Error("전략 보유 수량보다 많은 매도 보고를 받았습니다");
	const sold = Math.min(state.qty, fill.qty);
	const basis = state.cost * sold / state.qty;
	state.realizedPnl += fill.amount - basis;
	state.pnlEstimated ||= state.buyEstimated || fill.estimated;
	state.qty = Number(Math.max(0, state.qty - sold).toPrecision(14));
	state.cost = Math.max(0, state.cost - basis);
	if (state.qty <= 1e-12) {
		state.qty = 0;
		state.cost = 0;
		state.cycles++;
		state.phase = state.phase === "liquidating" ? "stopped" : "buying";
	}
}

/** 부분 매도에도 원가를 비례 배분. 로스컷은 가격이 회복해도 liquidating을 유지한다. */
export function applyRangeReport(range: RangeTrade, id: string, side: "BUY" | "SELL", report: ExecReport, barT: number): RangeTrade {
	if (range.state.lastExecId === id) return range;
	const state: RangeState = {
		...range.state,
		lastExecId: id,
		pendingExecId: null,
		lastTradeBarT: barT >= 0 ? barT : range.state.lastTradeBarT,
	};
	const fill = rangeFillCost(report, side, side === "BUY" ? range.buyCostPct : range.sellCostPct);
	if (fill.qty > 0) {
		if (side === "BUY") applyBuyFill(state, fill);
		else applySellFill(state, fill);
	}
	if (report.filledQty > 0 || report.status === "unknown") state.executions++;
	if (report.status === "unknown") state.phase = "blocked";
	return { ...range, state };
}
