/**
 * 주문 변경·조건주문 확인 카드 (PLAN §34).
 *
 * 신규 주문 카드(OrderPreviewCard, index.ts)와 같은 규칙: [확인] 버튼이 서명된 토큰을 서버로 보내야만 실행된다.
 * 원주문 값(original)은 준비 단계에서 서버가 증권사에서 조회한 값이다.
 */

export interface OrderChangeCard {
	kind: "order-change-card";
	ok: boolean;
	token: string | null;
	expiresAt: number | null;
	broker: "toss" | "kis";
	action: "modify" | "cancel";
	symbol: string;
	name: string;
	currency: "KRW" | "USD";
	original: {
		orderId: string;
		side: "BUY" | "SELL";
		orderType: "LIMIT" | "MARKET";
		openQuantity: number;
		price: number | null;
		orderedAt: string | null;
	};
	/** 정정 후 — 취소면 없다 */
	after?: { orderType: "LIMIT" | "MARKET"; quantity: number; price: number | null };
	warnings: string[];
	errors: string[];
}

export interface ConditionalLegView {
	side: "BUY" | "SELL";
	triggerPrice: number;
	orderPrice: number | null;
}

export interface ConditionalOrderCard {
	kind: "conditional-order-card";
	ok: boolean;
	token: string | null;
	expiresAt: number | null;
	broker: "toss";
	action: "create" | "modify" | "cancel";
	symbol: string;
	name: string;
	currency: "KRW" | "USD";
	conditionalOrderId: string | null;
	type: "SINGLE" | "OCO" | "OTO";
	quantity: number;
	orderType: "LIMIT" | "MARKET";
	expireDate: string;
	first: ConditionalLegView;
	second: ConditionalLegView | null;
	/** 카드의 "현재가 대비"·"평단 대비" 표시용 */
	currentPrice: number | null;
	avgPrice: number | null;
	warnings: string[];
	errors: string[];
}

/**
 * Binance 지갑 간 이동 확인 카드 — 같은 계정 안 (현물·펀딩·Earn 유연), 외부 출금이 아니다.
 * 이동 가능 수량·Earn 상품 ID 는 준비 단계에서 서버가 Binance 에서 조회한 값이다.
 */
export interface BinanceTransferCard {
	kind: "binance-transfer-card";
	ok: boolean;
	token: string | null;
	expiresAt: number | null;
	from: "SPOT" | "FUNDING" | "EARN";
	to: "SPOT" | "FUNDING" | "EARN";
	asset: string;
	/** 옮길 수량 — 전량이면 준비 시점의 이동 가능 수량 */
	amount: string | null;
	all: boolean;
	/** 보내는 지갑의 이동 가능 수량 */
	available: string | null;
	productId: string | null;
	/** 표시용 — 어떤 API 로 나가는지 */
	api: string | null;
	warnings: string[];
	errors: string[];
}

/** Binance 현물 확인 카드 (PLAN §36) — 값은 문자열 10진수 (거래소 단위로 보정됨) */
export interface BinanceOrderCard {
	kind: "binance-order-card";
	/** stock = Binance 미국 주식 직접 거래 (값의 base 는 티커, quote 는 USDC). 없으면 현물 */
	market?: "spot" | "stock";
	ok: boolean;
	token: string | null;
	expiresAt: number | null;
	action: "place" | "cancel" | "replace" | "oco" | "oto" | "cancel_all";
	symbol: string;
	base: string;
	quote: string;
	side: "BUY" | "SELL" | null;
	type: string | null;
	quantity: string | null;
	quoteQuantity: string | null;
	price: string | null;
	estimatedQuote: string | null;
	lastPrice: string | null;
	balance: { asset: string; free: string } | null;
	minNotional: string | null;
	original: { orderId: number | string; side: "BUY" | "SELL"; type: string; price: string; origQty: string; executedQty: string } | null;
	lines: Array<{ label: string; text: string; pct: number | null }>;
	orders: Array<{ orderId: number | string; side: "BUY" | "SELL"; type: string; price: string; origQty: string; executedQty: string }>;
	warnings: string[];
	errors: string[];
}
