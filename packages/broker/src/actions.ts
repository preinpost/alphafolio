/**
 * 주문 동작 — 에이전트가 **준비**하고 사람이 확인 카드에서 실행하는 쓰기 작업의 전부 (PLAN §34).
 *
 * 이 값이 서명된 확인 토큰(apps/server/src/order-tokens.ts)에 그대로 담긴다. 실행기(execute.ts)는
 * 이 값만 보고 증권사·API 를 고른다 — 실행 시점에 모델 입력을 다시 읽지 않는다.
 *
 * 원주문의 수량·가격·KIS 조직번호 같은 값은 **준비 단계에서 서버가 증권사에서 조회한 값**이다
 * (모델이 준 값을 원주문 값으로 믿지 않는다).
 */
import type { BrokerId } from "./normalize.ts";
import type { Market, OrderSide, OrderType } from "./orders.ts";

export type Currency = "KRW" | "USD";
/** KIS 주문용 해외 거래소 코드 (시세 조회의 NAS/NYS/AMS 와 다르다) */
export type KisOrderExchange = "NASD" | "NYSE" | "AMEX";

export interface PlaceAction {
	kind: "place";
	broker: BrokerId;
	symbol: string;
	market: Market;
	currency: Currency;
	side: OrderSide;
	orderType: OrderType;
	quantity: number;
	/** 지정가일 때만 (호가단위 보정 후) */
	price?: number;
	/** 표시·로그용 — 실행에 쓰지 않는다 */
	estimatedAmount: number;
	/** KIS 해외 주문만 */
	excd?: KisOrderExchange;
}

/** 원주문 — 준비 단계에서 증권사 조회로 채운다 */
export interface OriginalOrder {
	orderId: string;
	side: OrderSide;
	orderType: OrderType;
	/** 정정·취소 가능한(미체결) 수량 */
	openQuantity: number;
	price: number | null;
	orderedAt: string | null;
	/** KIS 국내 정정·취소에 필요한 한국거래소전송주문조직번호 */
	kisOrgNo?: string;
}

export interface ModifyAction {
	kind: "modify";
	broker: BrokerId;
	symbol: string;
	market: Market;
	currency: Currency;
	original: OriginalOrder;
	orderType: OrderType;
	/** 바꾼 뒤 수량 — 토스 미국주식은 수량 정정 불가라 원주문 미체결 수량 그대로 */
	quantity: number;
	price?: number;
	excd?: KisOrderExchange;
}

export interface CancelAction {
	kind: "cancel";
	broker: BrokerId;
	symbol: string;
	market: Market;
	currency: Currency;
	original: OriginalOrder;
	excd?: KisOrderExchange;
}

export type ConditionalType = "SINGLE" | "OCO" | "OTO";

export interface ConditionalLeg {
	side: OrderSide;
	triggerPrice: number;
	/** 지정가일 때만 */
	orderPrice?: number;
}

export interface ConditionalSpec {
	symbol: string;
	market: Market;
	currency: Currency;
	type: ConditionalType;
	quantity: number;
	orderType: OrderType;
	/** YYYY-MM-DD */
	expireDate: string;
	first: ConditionalLeg;
	second?: ConditionalLeg;
}

export interface ConditionalCreateAction extends ConditionalSpec {
	kind: "conditional-create";
	broker: "toss";
}

export interface ConditionalModifyAction extends ConditionalSpec {
	kind: "conditional-modify";
	broker: "toss";
	conditionalOrderId: string;
}

export interface ConditionalCancelAction {
	kind: "conditional-cancel";
	broker: "toss";
	symbol: string;
	conditionalOrderId: string;
}

// ── Binance 현물 (PLAN §36) — 값은 전부 문자열 10진수 (부동소수점 오차 없이, binance/decimal.ts) ──

interface BinanceBase {
	broker: "binance";
	/** 예: BTCUSDT */
	symbol: string;
	/** 예: BTC */
	base: string;
	/** 예: USDT */
	quote: string;
}

export interface BinancePlaceAction extends BinanceBase {
	kind: "binance-place";
	side: OrderSide;
	type: OrderType;
	/** 기준 자산 수량 (거래소 stepSize 로 내림한 값). 시장가 매수를 금액으로 하면 없다 */
	quantity?: string;
	/** 시장가 매수 금액 (호가 자산, 예: USDT) */
	quoteOrderQty?: string;
	/** 지정가 (tickSize 로 내림) */
	price?: string;
	/** 표시용 예상 주문금액 (호가 자산) */
	estimatedQuote: string;
}

/** 원주문 — 서버가 Binance 미체결 조회로 채운다 */
export interface BinanceOriginal {
	orderId: number;
	side: OrderSide;
	type: string;
	price: string;
	origQty: string;
	executedQty: string;
}

export interface BinanceCancelAction extends BinanceBase {
	kind: "binance-cancel";
	original: BinanceOriginal;
}

export interface BinanceReplaceAction extends BinanceBase {
	kind: "binance-replace";
	original: BinanceOriginal;
	/** 새 수량·가격 (지정가) */
	quantity: string;
	price: string;
}

/** 익절(위: LIMIT_MAKER) + 손절(아래: STOP_LOSS_LIMIT) 매도 OCO */
export interface BinanceOcoAction extends BinanceBase {
	kind: "binance-oco";
	quantity: string;
	takeProfitPrice: string;
	stopPrice: string;
	stopLimitPrice: string;
}

/** 지정가 매수가 체결되면 지정가 매도가 걸린다 */
export interface BinanceOtoAction extends BinanceBase {
	kind: "binance-oto";
	quantity: string;
	buyPrice: string;
	sellPrice: string;
}

export interface BinanceCancelAllAction extends BinanceBase {
	kind: "binance-cancel-all";
	/** 준비 시점의 미체결 건수 (표시용) */
	count: number;
}

// ── Binance 미국 주식 직접 거래 (Nest·Alpaca, `/sapi/v1/equity`) — 값은 문자열 10진수 ──

export interface BinanceStockPlaceAction {
	kind: "binance-stock-place";
	broker: "binance_stock";
	/** 미국 티커 (AAPL) */
	symbol: string;
	/** 대금 자산 (USDC) */
	quote: string;
	side: OrderSide;
	type: OrderType;
	/** 주 수 (소수점 가능 — stepSize 로 내림). 시장가 매수면 없다 */
	quantity?: string;
	/** 시장가 매수 금액 (USDC) */
	notional?: string;
	/** 지정가 (소수 2자리) */
	price?: string;
	/** 지정가 세션 — RTH(정규장) · EXTENDED(프리·애프터) · 24H */
	session?: "RTH" | "EXTENDED" | "24H";
	estimatedQuote: string;
}

/** 원주문 — 서버가 미체결 조회로 채운다 (주문번호는 UUID) */
export interface BinanceStockOriginal {
	orderId: string;
	side: OrderSide;
	type: string;
	price: string;
	qty: string;
	filledQty: string;
}

export interface BinanceStockCancelAction {
	kind: "binance-stock-cancel";
	broker: "binance_stock";
	symbol: string;
	original: BinanceStockOriginal;
}

export type BinanceStockAction = BinanceStockPlaceAction | BinanceStockCancelAction;

// ── Binance 지갑 간 이동 (같은 계정 내부 — 외부 출금 아님, binance/wallet.ts) ──

export type WalletName = "SPOT" | "FUNDING" | "EARN";

/** 지갑 쌍으로 정해지는 API — 준비 단계에서 서버가 고른다 */
export type TransferRoute =
	| { kind: "universal"; type: "MAIN_FUNDING" | "FUNDING_MAIN" }
	| { kind: "redeem"; destAccount: "SPOT" | "FUND" }
	| { kind: "subscribe"; sourceAccount: "SPOT" | "FUND" };

export interface BinanceTransferAction {
	kind: "binance-transfer";
	broker: "binance";
	from: WalletName;
	to: WalletName;
	/** 예: USDT */
	asset: string;
	/** 옮길 수량 (문자열 10진수). all 이면 준비 시점의 이동 가능 전량 */
	amount: string;
	/** 전량 — Earn 환매는 redeemAll (이자가 붙어 준비 시점보다 많다) */
	all: boolean;
	route: TransferRoute;
	/** Earn 유연 상품 ID — 환매는 보유 내역, 예치는 상품 목록에서 서버가 찾은 값 */
	productId?: string;
}

export type BinanceAction =
	| BinancePlaceAction
	| BinanceCancelAction
	| BinanceReplaceAction
	| BinanceOcoAction
	| BinanceOtoAction
	| BinanceCancelAllAction;

export type OrderAction =
	| PlaceAction
	| ModifyAction
	| CancelAction
	| ConditionalCreateAction
	| ConditionalModifyAction
	| ConditionalCancelAction
	| BinanceAction
	| BinanceStockAction
	| BinanceTransferAction;

/** 로그 한 줄 — 금액·계좌 없이 무엇을 하는지만 */
export function describeAction(a: OrderAction): string {
	switch (a.kind) {
		case "place":
			return `${a.broker} 주문 ${a.symbol} ${a.side} ${a.quantity}주 ${a.orderType}`;
		case "modify":
			return `${a.broker} 정정 ${a.symbol} ${a.original.orderId.slice(0, 12)} → ${a.quantity}주 ${a.orderType}`;
		case "cancel":
			return `${a.broker} 취소 ${a.symbol} ${a.original.orderId.slice(0, 12)}`;
		case "conditional-create":
			return `toss 조건주문 ${a.type} ${a.symbol} ${a.quantity}주`;
		case "conditional-modify":
			return `toss 조건주문 수정 ${a.conditionalOrderId.slice(0, 12)}`;
		case "conditional-cancel":
			return `toss 조건주문 취소 ${a.conditionalOrderId.slice(0, 12)}`;
		case "binance-place":
			return `binance 주문 ${a.symbol} ${a.side} ${a.type} ${a.quantity ?? `${a.quoteOrderQty} ${a.quote}`}`;
		case "binance-cancel":
			return `binance 취소 ${a.symbol} #${a.original.orderId}`;
		case "binance-replace":
			return `binance 재주문 ${a.symbol} #${a.original.orderId} → ${a.quantity}@${a.price}`;
		case "binance-oco":
			return `binance OCO ${a.symbol} ${a.quantity}`;
		case "binance-oto":
			return `binance OTO ${a.symbol} ${a.quantity}`;
		case "binance-cancel-all":
			return `binance 전체 취소 ${a.symbol} (${a.count}건)`;
		case "binance-stock-place":
			return `binance 미국 주식 ${a.symbol} ${a.side} ${a.type} ${a.quantity ? `${a.quantity}주` : `${a.notional} ${a.quote}`}`;
		case "binance-stock-cancel":
			return `binance 미국 주식 취소 ${a.symbol} ${a.original.orderId.slice(0, 12)}`;
		case "binance-transfer":
			return `binance 지갑 이동 ${a.from}→${a.to} ${a.asset} ${a.all ? "전량" : a.amount}`;
	}
}
