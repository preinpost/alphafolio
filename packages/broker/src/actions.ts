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

// ── Binance USDⓈ-M 선물 (binance/futures.ts) — 값은 문자열 10진수 ──

/** 단방향 모드는 BOTH, 양방향(Hedge) 모드는 LONG·SHORT — 준비 단계에서 계정 모드를 읽어 정한다 */
export type FuturesPositionSide = "BOTH" | "LONG" | "SHORT";
export type FuturesMarginType = "ISOLATED" | "CROSSED";

interface FuturesBase {
	broker: "binance";
	/** 예: BTCUSDT (무기한) */
	symbol: string;
	/** 예: BTC */
	base: string;
	/** 증거금 자산 — 예: USDT */
	marginAsset: string;
}

/** 추가로 거는 익절·손절 — 포지션 전체를 시장가로 닫는 조건부 주문 (Algo, closePosition) */
export interface FuturesTpsl {
	takeProfitPrice?: string;
	stopLossPrice?: string;
}

/**
 * 진입·추가 — 포지션을 늘린다. 실행기는 주문 전에 종목 설정을 이 값으로 맞추고(준비 시점 설정과 다를 때만),
 * 주문이 접수되면 익절·손절을 건다.
 */
export interface BinanceFuturesOpenAction extends FuturesBase, FuturesTpsl {
	kind: "binance-futures-open";
	/** BUY = 롱, SELL = 숏 */
	side: OrderSide;
	positionSide: FuturesPositionSide;
	type: "LIMIT" | "MARKET";
	/** 기준 자산 수량 (stepSize 로 내림) */
	quantity: string;
	/** 지정가 (tickSize 로 내림) */
	price?: string;
	leverage: number;
	marginType: FuturesMarginType;
	/** 준비 시점의 종목 설정 — 다른 것만 바꾼다 */
	current: { leverage: number; marginType: FuturesMarginType };
	/** 표시용 예상 포지션 크기 (증거금 자산) */
	estimatedNotional: string;
}

/** 청산 — 포지션을 줄인다 (단방향은 reduceOnly, 양방향은 positionSide 로 줄어들기만 한다) */
export interface BinanceFuturesCloseAction extends FuturesBase {
	kind: "binance-futures-close";
	/** 롱 청산 = SELL, 숏 청산 = BUY */
	side: OrderSide;
	positionSide: FuturesPositionSide;
	type: "LIMIT" | "MARKET";
	quantity: string;
	price?: string;
	/** 준비 시점 포지션 수량 (부호 포함, 표시용) */
	positionAmt: string;
}

/** 열린 포지션에 익절·손절 — 트리거되면 포지션 전체를 시장가로 닫는다 */
export interface BinanceFuturesTpslAction extends FuturesBase, FuturesTpsl {
	kind: "binance-futures-tpsl";
	/** 청산 방향 (롱이면 SELL) */
	side: OrderSide;
	positionSide: FuturesPositionSide;
}

/** 원주문 — 서버가 미체결 조회로 채운다. algo = 조건부 주문(익절·손절 등, 번호는 algoId) */
export interface FuturesOriginal {
	source: "order" | "algo";
	id: number;
	side: OrderSide;
	type: string;
	/** 지정가 — 없으면 "0" */
	price: string;
	/** 조건부 주문의 트리거 가격 */
	triggerPrice?: string;
	/** 수량 — 포지션 전체 청산 주문은 "0" */
	quantity: string;
	closePosition?: boolean;
}

export interface BinanceFuturesCancelAction extends FuturesBase {
	kind: "binance-futures-cancel";
	original: FuturesOriginal;
}

export interface BinanceFuturesCancelAllAction extends FuturesBase {
	kind: "binance-futures-cancel-all";
	/** 준비 시점의 일반·조건부 미체결 건수 — 0 인 쪽은 요청하지 않는다 */
	orders: number;
	algo: number;
}

/** 종목 설정 — 레버리지·증거금 방식 (주문 없이) */
export interface BinanceFuturesSettingsAction extends FuturesBase {
	kind: "binance-futures-settings";
	leverage?: number;
	marginType?: FuturesMarginType;
	current: { leverage: number; marginType: FuturesMarginType };
}

export type BinanceFuturesAction =
	| BinanceFuturesOpenAction
	| BinanceFuturesCloseAction
	| BinanceFuturesTpslAction
	| BinanceFuturesCancelAction
	| BinanceFuturesCancelAllAction
	| BinanceFuturesSettingsAction;

// ── Binance 지갑 간 이동 (같은 계정 내부 — 외부 출금 아님, binance/wallet.ts) ──

/** FUTURES = USDⓈ-M 선물 지갑 */
export type WalletName = "SPOT" | "FUNDING" | "EARN" | "FUTURES";

/** 지갑 쌍으로 정해지는 API — 준비 단계에서 서버가 고른다 */
export type TransferRoute =
	| { kind: "universal"; type: "MAIN_FUNDING" | "FUNDING_MAIN" | "MAIN_UMFUTURE" | "UMFUTURE_MAIN" | "FUNDING_UMFUTURE" | "UMFUTURE_FUNDING" }
	| { kind: "redeem"; destAccount: "SPOT" }
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
	| BinanceFuturesAction
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
		case "binance-futures-open":
			return `binance 선물 진입 ${a.symbol} ${a.side} ${a.type} ${a.quantity} ${a.leverage}x ${a.marginType}${a.stopLossPrice ? " +SL" : ""}${a.takeProfitPrice ? " +TP" : ""}`;
		case "binance-futures-close":
			return `binance 선물 청산 ${a.symbol} ${a.side} ${a.type} ${a.quantity}`;
		case "binance-futures-tpsl":
			return `binance 선물 익절·손절 ${a.symbol}${a.takeProfitPrice ? " TP" : ""}${a.stopLossPrice ? " SL" : ""}`;
		case "binance-futures-cancel":
			return `binance 선물 취소 ${a.symbol} ${a.original.source} #${a.original.id}`;
		case "binance-futures-cancel-all":
			return `binance 선물 전체 취소 ${a.symbol} (${a.orders}+${a.algo}건)`;
		case "binance-futures-settings":
			return `binance 선물 설정 ${a.symbol}${a.leverage ? ` ${a.leverage}x` : ""}${a.marginType ? ` ${a.marginType}` : ""}`;
		case "binance-transfer":
			return `binance 지갑 이동 ${a.from}→${a.to} ${a.asset} ${a.all ? "전량" : a.amount}`;
	}
}
