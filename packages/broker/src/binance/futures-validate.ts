/**
 * 선물 주문 검증 (순수) — binance_futures 가 준비 단계에서 부른다. 네트워크 없음.
 *
 * 거래소 규칙(가격·수량 단위, 최소 주문금액, 지정가 허용 범위)·레버리지 구간·주문 가능 증거금·익절/손절 방향을 본다.
 * 단위에 안 맞는 값은 내림 보정하고 경고로 알린다 (현물 validateBinance 와 같은 방식).
 */
import type { FuturesMarginType } from "../actions.ts";
import { cmpDec, divToStep, floorToStep, mulDec, pctDiff } from "./decimal.ts";
import { bracketFor, isolatedLiqPrice, maxNotionalAt, type Bracket, type FuturesPosition, type FuturesRules } from "./futures.ts";

export const trim = (v: string): string => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);

/** 이 레버리지 이상이면 카드에 경고 */
export const HIGH_LEVERAGE = 20;

interface Sink {
	errors: string[];
	warnings: string[];
}

const round2 = (n: number): string => String(Math.round(n * 100) / 100);

/** 단위 보정·범위 검사 묶음 — rules·표시가격에 묶는다 */
function checks(rules: FuturesRules, mark: string, s: Sink) {
	const positive = (label: string, v: string | undefined): v is string => {
		if (v === undefined || v === "") return false;
		if (!/^\d+(\.\d+)?$/.test(v) || !(Number(v) > 0)) {
			s.errors.push(`${label}이(가) 올바르지 않습니다: ${v}`);
			return false;
		}
		return true;
	};
	/** band: 지정가 허용 범위(표시가격 × multiplierDown ~ × multiplierUp)도 본다 — 트리거 가격은 범위가 없다 */
	const price = (label: string, v: string | undefined, band: boolean): string | undefined => {
		if (!positive(label, v)) return undefined;
		const p = floorToStep(v, rules.tickSize);
		if (cmpDec(p, v) !== 0) s.warnings.push(`${label} 가격 단위(${trim(rules.tickSize)})로 내림: ${v} → ${p}`);
		if (cmpDec(rules.minPrice, "0") > 0 && cmpDec(p, rules.minPrice) < 0) s.errors.push(`${label} ${p} 이(가) 최소 가격 ${trim(rules.minPrice)} 보다 낮습니다.`);
		if (cmpDec(rules.maxPrice, "0") > 0 && cmpDec(p, rules.maxPrice) > 0) s.errors.push(`${label} ${p} 이(가) 최대 가격 ${trim(rules.maxPrice)} 보다 높습니다.`);
		if (band && cmpDec(rules.multiplierUp, "0") > 0) {
			const hi = mulDec(mark, rules.multiplierUp);
			const lo = mulDec(mark, rules.multiplierDown);
			if (cmpDec(p, hi) > 0 || cmpDec(p, lo) < 0) {
				s.errors.push(`${label} ${p} 이(가) 지정가 허용 범위(표시가격 ${trim(mark)} 기준 ${trim(floorToStep(lo, rules.tickSize))} ~ ${trim(floorToStep(hi, rules.tickSize))}) 밖입니다.`);
			}
		}
		const dev = Math.abs(pctDiff(p, mark));
		if (!band && dev >= 50) s.errors.push(`${label} ${p} 이(가) 표시가격 ${trim(mark)} 와 ${dev}% 차이납니다 — 자릿수를 확인하세요.`);
		return p;
	};
	const qty = (v: string, market: boolean): string | undefined => {
		const step = market ? rules.marketStepSize : rules.stepSize;
		const q = floorToStep(v, step);
		if (cmpDec(q, v) !== 0) s.warnings.push(`수량 단위(${trim(step)})로 내림: ${v} → ${q}`);
		const min = market ? rules.marketMinQty : rules.minQty;
		const max = market ? rules.marketMaxQty : rules.maxQty;
		if (cmpDec(q, "0") <= 0 || cmpDec(q, min) < 0) {
			s.errors.push(`수량 ${q} ${rules.base} 이(가) 최소 ${trim(min)} 보다 적습니다.`);
			return undefined;
		}
		if (cmpDec(max, "0") > 0 && cmpDec(q, max) > 0) s.errors.push(`수량 ${q} 이(가) ${market ? "시장가 " : ""}최대 ${trim(max)} 보다 많습니다.`);
		return q;
	};
	return { positive, price, qty };
}

/**
 * 익절·손절 방향 — 롱은 익절 > 기준가 > 손절, 숏은 반대. 손절이 청산가 너머면 손절 전에 청산된다.
 * ref = 진입가(지정가) 또는 표시가격.
 */
function tpslChecks(long: boolean, ref: string, tp: string | undefined, sl: string | undefined, liq: number | null, s: Sink): void {
	const dir = long ? "롱" : "숏";
	if (tp && (long ? cmpDec(tp, ref) <= 0 : cmpDec(tp, ref) >= 0)) s.errors.push(`${dir} 익절가 ${tp} 는 기준가 ${trim(ref)} 보다 ${long ? "높아야" : "낮아야"} 합니다.`);
	if (sl && (long ? cmpDec(sl, ref) >= 0 : cmpDec(sl, ref) <= 0)) s.errors.push(`${dir} 손절가 ${sl} 는 기준가 ${trim(ref)} 보다 ${long ? "낮아야" : "높아야"} 합니다.`);
	if (sl && liq !== null && (long ? Number(sl) <= liq : Number(sl) >= liq)) {
		s.errors.push(`손절가 ${sl} 이(가) 예상 청산가 ${round2(liq)} 너머입니다 — 손절 전에 청산됩니다.`);
	}
}

// ── 진입 ────────────────────────────────────────────────────

export interface OpenRequest {
	/** BUY = 롱, SELL = 숏 */
	side: "BUY" | "SELL";
	type: "LIMIT" | "MARKET";
	/** 기준 자산 수량 — 셋 중 하나 */
	quantity?: string;
	/** 포지션 크기 (증거금 자산, 예 USDT) */
	notional?: string;
	/** 넣을 증거금 — 포지션 크기 = 증거금 × 레버리지 */
	margin?: string;
	price?: string;
	leverage: number;
	marginType: FuturesMarginType;
	takeProfitPrice?: string;
	stopLossPrice?: string;
}

export interface OpenContext {
	rules: FuturesRules;
	/** 표시가격 */
	mark: string;
	/** 주문 가능 증거금 (조회 실패면 null — 검사를 건너뛴다) */
	available: string | null;
	brackets: readonly Bracket[];
	current: { leverage: number; marginType: FuturesMarginType };
	/** 이 종목에 열린 포지션이 있는가 (방향 무관) — 증거금 방식을 바꿀 수 없다 */
	hasPosition: boolean;
	/** 이 종목에 미체결이 있는가 — 증거금 방식을 바꿀 수 없다 */
	hasOpenOrders: boolean;
}

export interface OpenValidated extends Sink {
	quantity?: string;
	price?: string;
	/** 포지션 크기 (증거금 자산) */
	notional?: string;
	/** 필요한 증거금 (표시용) */
	margin?: string;
	/** 격리일 때만 예상 청산가 */
	liqPrice: string | null;
	takeProfitPrice?: string;
	stopLossPrice?: string;
}

export function validateOpen(req: OpenRequest, ctx: OpenContext): OpenValidated {
	const out: OpenValidated = { errors: [], warnings: [], liqPrice: null };
	const { rules, mark } = ctx;
	const c = checks(rules, mark, out);
	const long = req.side === "BUY";
	const market = req.type === "MARKET";

	if (rules.status !== "TRADING") out.errors.push(`${rules.symbol} 은(는) 지금 거래할 수 없습니다 (상태 ${rules.status}).`);
	if (rules.orderTypes.length > 0 && !rules.orderTypes.includes(req.type)) out.errors.push(`${rules.symbol} 은(는) ${req.type} 주문을 지원하지 않습니다.`);

	// 레버리지 — 정수, 종목 최대(첫 구간) 이하
	const maxLev = ctx.brackets[0]?.initialLeverage ?? 125;
	if (!Number.isInteger(req.leverage) || req.leverage < 1) out.errors.push(`레버리지는 1 이상 정수여야 합니다: ${req.leverage}`);
	else if (req.leverage > maxLev) out.errors.push(`${rules.symbol} 최대 레버리지는 ${maxLev}x 입니다 (요청 ${req.leverage}x).`);
	if (req.marginType !== ctx.current.marginType && (ctx.hasPosition || ctx.hasOpenOrders)) {
		out.errors.push(`포지션·미체결이 있는 동안은 증거금 방식을 바꿀 수 없습니다 (지금 ${ctx.current.marginType === "ISOLATED" ? "격리" : "교차"}).`);
	}

	// 기준가 — 지정가면 그 가격, 시장가면 표시가격
	if (!market) {
		out.price = c.price("지정가", req.price, true);
		if (!req.price) out.errors.push("지정가 주문에는 price 가 필요합니다.");
	}
	const ref = out.price ?? (market ? mark : undefined);

	// 수량 — quantity · notional · margin 중 하나
	const given = [req.quantity, req.notional, req.margin].filter((v) => v !== undefined && v !== "").length;
	if (given !== 1) out.errors.push("quantity(수량)·notional(포지션 크기)·margin(증거금) 중 하나만 주세요.");
	else if (ref) {
		const step = market ? rules.marketStepSize : rules.stepSize;
		let raw: string | undefined;
		if (c.positive("수량", req.quantity)) raw = req.quantity;
		else if (c.positive("포지션 크기", req.notional)) raw = divToStep(req.notional, ref, step);
		else if (c.positive("증거금", req.margin)) raw = divToStep(mulDec(req.margin, req.leverage), ref, step);
		const byAmount = raw !== undefined && raw !== req.quantity;
		const minQty = market ? rules.marketMinQty : rules.minQty;
		if (byAmount && cmpDec(raw!, minQty) < 0) {
			// 금액으로 말했는데 최소 수량에 못 미친다 — "수량 0" 대신 금액으로 알린다
			const minSize = Number(mulDec(minQty, ref));
			out.errors.push(
				`${req.notional ? `포지션 크기 ${req.notional}` : `증거금 ${req.margin} × ${req.leverage}x`} ${rules.marginAsset} 로는 최소 수량 ${trim(minQty)} ${rules.base}` +
					` (크기 약 ${round2(minSize)} · ${req.leverage}x 증거금 약 ${round2(minSize / Math.max(1, req.leverage))} ${rules.marginAsset}) 에 못 미칩니다.`,
			);
		} else if (raw !== undefined) out.quantity = c.qty(raw, market);
	}

	if (out.quantity && ref) {
		const notional = mulDec(ref, out.quantity);
		out.notional = notional;
		const n = Number(notional);
		if (cmpDec(rules.minNotional, "0") > 0 && cmpDec(notional, rules.minNotional) < 0) {
			out.errors.push(`포지션 크기 ${round2(n)} ${rules.marginAsset} 이(가) 최소 주문금액 ${trim(rules.minNotional)} 보다 적습니다.`);
		}
		const cap = maxNotionalAt(ctx.brackets, req.leverage);
		if (cap > 0 && n > cap) out.errors.push(`${req.leverage}x 로는 포지션 크기 최대 ${cap.toLocaleString("en-US")} ${rules.marginAsset} 까지입니다 — 레버리지를 낮추세요.`);
		if (req.leverage >= 1) {
			const need = n / req.leverage;
			out.margin = round2(need);
			if (ctx.available !== null) {
				const have = Number(ctx.available);
				if (need > have) out.errors.push(`증거금 부족 — 필요 약 ${round2(need)} > 주문 가능 ${trim(ctx.available)} ${rules.marginAsset}. 선물 지갑으로 옮기거나(binance_wallet) 크기를 줄이세요.`);
				else if (need > have * 0.95) out.warnings.push("주문 가능 증거금을 거의 다 씁니다 — 수수료·가격 변동으로 거절될 수 있습니다.");
			}
		}
		if (req.marginType === "ISOLATED") {
			const b = bracketFor(ctx.brackets, n);
			const liq = b ? isolatedLiqPrice(long, Number(ref), Number(out.quantity), req.leverage, b) : null;
			out.liqPrice = liq !== null ? round2(liq) : null;
		}
	}

	out.takeProfitPrice = c.price("익절", req.takeProfitPrice, false);
	out.stopLossPrice = c.price("손절", req.stopLossPrice, false);
	if (ref) tpslChecks(long, ref, out.takeProfitPrice, out.stopLossPrice, out.liqPrice !== null ? Number(out.liqPrice) : null, out);

	if (req.leverage >= HIGH_LEVERAGE) out.warnings.push(`레버리지 ${req.leverage}x — 가격이 약 ${round2(100 / req.leverage)}% 만 반대로 가도 증거금을 거의 다 잃습니다.`);
	if (!out.stopLossPrice) out.warnings.push("손절가가 없습니다 — 급변동 때 청산될 수 있습니다.");
	if (req.marginType === "CROSSED") out.warnings.push("교차 증거금 — 선물 지갑 전체가 이 포지션의 증거금입니다 (청산가는 지갑 잔고에 따라 달라 표시하지 않습니다).");
	if (market) out.warnings.push("시장가 — 표시가격과 다르게 체결될 수 있습니다.");
	return out;
}

// ── 청산 ────────────────────────────────────────────────────

export interface CloseRequest {
	type: "LIMIT" | "MARKET";
	/** 비우면 전량 */
	quantity?: string;
	price?: string;
}

export interface CloseValidated extends Sink {
	/** 롱 청산 SELL · 숏 청산 BUY */
	side: "BUY" | "SELL";
	quantity?: string;
	price?: string;
}

export function validateClose(req: CloseRequest, rules: FuturesRules, mark: string, pos: FuturesPosition): CloseValidated {
	const long = Number(pos.amt) > 0;
	const out: CloseValidated = { errors: [], warnings: [], side: long ? "SELL" : "BUY" };
	const c = checks(rules, mark, out);
	const market = req.type === "MARKET";
	const held = pos.amt.replace(/^-/, "");

	if (!market) {
		out.price = c.price("지정가", req.price, true);
		if (!req.price) out.errors.push("지정가 청산에는 price 가 필요합니다.");
	}
	const raw = req.quantity === undefined || req.quantity === "" ? held : c.positive("수량", req.quantity) ? req.quantity : undefined;
	if (raw !== undefined) {
		out.quantity = c.qty(raw, market);
		if (out.quantity && cmpDec(out.quantity, held) > 0) {
			out.errors.push(`청산 수량 ${out.quantity} 이(가) 포지션 ${trim(held)} ${rules.base} 보다 많습니다.`);
		}
	}
	if (out.price && (long ? cmpDec(out.price, mark) < 0 : cmpDec(out.price, mark) > 0)) {
		out.warnings.push("지정가가 표시가격보다 불리해 바로 체결될 수 있습니다.");
	}
	if (market) out.warnings.push("시장가 — 표시가격과 다르게 체결될 수 있습니다.");
	return out;
}

// ── 열린 포지션에 익절·손절 ─────────────────────────────────

export interface TpslValidated extends Sink {
	takeProfitPrice?: string;
	stopLossPrice?: string;
}

export function validateTpsl(req: { takeProfitPrice?: string; stopLossPrice?: string }, rules: FuturesRules, mark: string, pos: FuturesPosition): TpslValidated {
	const out: TpslValidated = { errors: [], warnings: [] };
	const c = checks(rules, mark, out);
	if (!req.takeProfitPrice && !req.stopLossPrice) out.errors.push("takeProfitPrice·stopLossPrice 중 하나 이상이 필요합니다.");
	out.takeProfitPrice = c.price("익절", req.takeProfitPrice, false);
	out.stopLossPrice = c.price("손절", req.stopLossPrice, false);
	const liq = Number(pos.liquidationPrice) > 0 ? Number(pos.liquidationPrice) : null;
	// 트리거는 표시가격 기준 — 이미 넘어 있으면 Binance 가 -2021(바로 트리거)로 거절한다
	tpslChecks(Number(pos.amt) > 0, mark, out.takeProfitPrice, out.stopLossPrice, liq, out);
	out.warnings.push("트리거되면 이 방향 포지션 전체를 시장가로 닫습니다 (표시가격 기준).");
	return out;
}
