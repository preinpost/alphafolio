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

/** Binance 현물 확인 카드 (PLAN §36) — 값은 문자열 10진수 (거래소 단위로 보정됨) */
export interface BinanceOrderCard {
	kind: "binance-order-card";
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
	original: { orderId: number; side: "BUY" | "SELL"; type: string; price: string; origQty: string; executedQty: string } | null;
	lines: Array<{ label: string; text: string; pct: number | null }>;
	orders: Array<{ orderId: number; side: "BUY" | "SELL"; type: string; price: string; origQty: string; executedQty: string }>;
	warnings: string[];
	errors: string[];
}
