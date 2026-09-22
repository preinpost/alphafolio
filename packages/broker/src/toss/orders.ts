/**
 * 토스증권 주문 API — 조회·생성·취소.
 *
 * ⚠️ **이 모듈의 함수는 실제 돈을 움직인다.** 에이전트 툴에서 직접 호출하지 않는다.
 *    사람이 확인 카드를 클릭했을 때 서버가 호출하는 경로만 허용한다 (PLAN.md §18).
 *
 * 멱등성: `clientOrderId` 를 주면 10분 내 같은 값으로 재요청해도 **이전 주문 결과를
 * 그대로 돌려준다**. 확인 토큰의 nonce 를 이 값으로 쓰면 네트워크 재시도·더블클릭이
 * 중복 주문이 되지 않는다.
 */
import { tossGet, tossPost, TossError, type TossContext, type TossRequestOptions } from "./client.ts";
import type { OrderSide, OrderType } from "../orders.ts";

export type TimeInForce = "DAY" | "CLS" | "OPG";

export interface TossOrderRequest {
	symbol: string;
	side: OrderSide;
	orderType: OrderType;
	/** 주 단위. 국내·매수는 양의 정수만. */
	quantity: string;
	/** LIMIT 이면 필수 (현지 통화 기준) */
	price?: string;
	timeInForce?: TimeInForce;
	/** 멱등성 키 (최대 36자, 영숫자·-·_) */
	clientOrderId: string;
}

export interface TossOrderCreated {
	orderId: string;
	clientOrderId: string | null;
}

export interface TossOrderExecution {
	filledQuantity: string;
	averageFilledPrice: string | null;
	filledAmount: string | null;
	commission: string | null;
	tax: string | null;
	filledAt: string | null;
}

export interface TossOrder {
	orderId: string;
	symbol: string;
	side: OrderSide;
	orderType: OrderType;
	timeInForce: TimeInForce;
	status: string;
	price: string | null;
	quantity: string;
	orderAmount: string | null;
	currency: string;
	orderedAt: string;
	canceledAt: string | null;
	execution: TossOrderExecution;
}

/**
 * 주문 생성 — **실제 체결로 이어진다.**
 * 서버의 확인 실행 경로에서만 호출할 것.
 */
export function createOrder(
	ctx: TossContext,
	accountSeq: number,
	req: TossOrderRequest,
): Promise<TossOrderCreated> {
	const body: Record<string, unknown> = {
		clientOrderId: req.clientOrderId,
		symbol: req.symbol,
		side: req.side,
		orderType: req.orderType,
		quantity: req.quantity,
		timeInForce: req.timeInForce ?? "DAY",
	};
	// 시장가에 price 를 실으면 거절된다
	if (req.orderType === "LIMIT") {
		if (!req.price) throw new TossError("지정가 주문에는 가격이 필요합니다.", { status: 400 });
		body.price = req.price;
	}
	return tossPost<TossOrderCreated>(ctx, "/api/v1/orders", { accountSeq, body });
}

/** 주문 취소. */
export function cancelOrder(ctx: TossContext, accountSeq: number, orderId: string): Promise<unknown> {
	return tossPost<unknown>(ctx, `/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, { accountSeq, body: {} });
}

/** 주문 목록. status 는 OPEN(미체결) / CLOSED(종료). */
export function listOrders(
	ctx: TossContext,
	accountSeq: number,
	opts?: { status?: "OPEN" | "CLOSED"; symbol?: string; limit?: number },
): Promise<{ orders: TossOrder[]; nextCursor?: string | null }> {
	const query: TossRequestOptions["query"] = {
		status: opts?.status ?? "OPEN",
		symbol: opts?.symbol,
		limit: opts?.limit ?? 30,
	};
	return tossGet<{ orders: TossOrder[]; nextCursor?: string | null }>(ctx, "/api/v1/orders", {
		query,
		accountSeq,
		group: "ORDER_INFO",
	});
}

/** 매도 가능 수량 — 매도 주문 전 검증에 쓴다. */
export function sellableQuantity(
	ctx: TossContext,
	accountSeq: number,
	symbol: string,
): Promise<{ sellableQuantity: string }> {
	return tossGet<{ sellableQuantity: string }>(ctx, "/api/v1/sellable-quantity", {
		query: { symbol },
		accountSeq,
		group: "ORDER_INFO",
	});
}
