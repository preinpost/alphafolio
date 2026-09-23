/**
 * 토스증권 주문 API — 조회·생성·정정·취소, 조건주문 (PLAN §18, §33).
 *
 * ⚠️ **이 모듈의 함수는 실제 돈을 움직인다.** 에이전트 툴에서 직접 호출하지 않는다.
 *    사람이 확인 카드를 클릭했을 때 서버가 호출하는 경로만 허용한다 (PLAN.md §18).
 *
 * 멱등성: `clientOrderId` 를 주면 10분 내 같은 값으로 재요청해도 **이전 주문 결과를
 * 그대로 돌려준다**. 확인 토큰의 nonce 를 이 값으로 쓰면 네트워크 재시도·더블클릭이
 * 중복 주문이 되지 않는다.
 */
import { tossDelete, tossGet, tossPost, TossError, type TossContext, type TossRequestOptions } from "./client.ts";
import type { ConditionalSpec } from "../actions.ts";
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
	return tossPost<TossOrderCreated>(ctx, "/api/v1/orders", { accountSeq, body, group: "ORDER" });
}

/** 주문 취소. */
export function cancelOrder(ctx: TossContext, accountSeq: number, orderId: string): Promise<unknown> {
	return tossPost<unknown>(ctx, `/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, { accountSeq, body: {}, group: "ORDER" });
}

/**
 * 주문 정정 본문 — 규격: 국내는 수량 필수(양의 정수), **미국은 수량을 보내면 400** (가격만 정정),
 * 지정가만 가격, 시장가에 가격을 보내면 400.
 */
export function tossModifyBody(market: "KR" | "US", orderType: OrderType, quantity: number, price?: number): Record<string, string> {
	const body: Record<string, string> = { orderType };
	if (market === "KR") body.quantity = String(quantity);
	if (orderType === "LIMIT") {
		if (price === undefined) throw new TossError("지정가 정정에는 가격이 필요합니다.", { status: 400 });
		body.price = String(price);
	}
	return body;
}

/** 주문 정정 — **실제 주문을 바꾼다.** 서버의 확인 실행 경로에서만. */
export function modifyOrder(
	ctx: TossContext,
	accountSeq: number,
	orderId: string,
	body: Record<string, string>,
): Promise<{ orderId?: string }> {
	return tossPost<{ orderId?: string }>(ctx, `/api/v1/orders/${encodeURIComponent(orderId)}/modify`, { accountSeq, body, group: "ORDER" });
}

/** 주문 상세 — 정정·취소 준비 때 원주문 값(수량·가격·미체결)을 서버가 직접 확인한다 */
export function getOrder(ctx: TossContext, accountSeq: number, orderId: string): Promise<TossOrder> {
	return tossGet<TossOrder>(ctx, `/api/v1/orders/${encodeURIComponent(orderId)}`, { accountSeq, group: "ORDER_HISTORY" });
}

// ── 조건주문 ────────────────────────────────────────────────

/** 조건주문 본문 — 생성은 symbol 포함, 수정은 symbol 없이 (규격: conditionalOrderId 로 식별) */
export function tossConditionalBody(spec: ConditionalSpec, opts: { forCreate: boolean; clientOrderId?: string }): Record<string, unknown> {
	const leg = (l: ConditionalSpec["first"]) => ({
		orderSide: l.side,
		triggerPrice: String(l.triggerPrice),
		...(spec.orderType === "LIMIT" && l.orderPrice !== undefined ? { orderPrice: String(l.orderPrice) } : {}),
	});
	return {
		...(opts.forCreate ? { symbol: spec.symbol } : {}),
		...(opts.forCreate && opts.clientOrderId ? { clientOrderId: opts.clientOrderId } : {}),
		type: spec.type,
		quantity: String(spec.quantity),
		orderType: spec.orderType,
		expireDate: spec.expireDate,
		first: leg(spec.first),
		...(spec.type !== "SINGLE" && spec.second ? { second: leg(spec.second) } : {}),
	};
}

/** 조건주문 생성 — **조건 충족 시 실제 주문이 나간다.** */
export function createConditionalOrder(
	ctx: TossContext,
	accountSeq: number,
	spec: ConditionalSpec,
	clientOrderId: string,
): Promise<{ conditionalOrderId: string }> {
	return tossPost(ctx, "/api/v1/conditional-orders", {
		accountSeq,
		body: tossConditionalBody(spec, { forCreate: true, clientOrderId }),
		group: "CONDITIONAL_ORDER",
	});
}

/** 조건주문 수정 — 규격: 기존 것을 취소하고 새로 만든다 → **새 conditionalOrderId** 가 온다 */
export function modifyConditionalOrder(
	ctx: TossContext,
	accountSeq: number,
	conditionalOrderId: string,
	spec: ConditionalSpec,
): Promise<{ conditionalOrderId: string }> {
	return tossPost(ctx, `/api/v1/conditional-orders/${encodeURIComponent(conditionalOrderId)}/modify`, {
		accountSeq,
		body: tossConditionalBody(spec, { forCreate: false }),
		group: "CONDITIONAL_ORDER",
	});
}

export function cancelConditionalOrder(ctx: TossContext, accountSeq: number, conditionalOrderId: string): Promise<unknown> {
	return tossDelete(ctx, `/api/v1/conditional-orders/${encodeURIComponent(conditionalOrderId)}`, { accountSeq, group: "CONDITIONAL_ORDER" });
}

export interface TossConditionalOrder {
	conditionalOrderId: string;
	symbol: string;
	type: string;
	status: string;
	quantity: string;
	orderType: string;
	expireDate: string;
	[key: string]: unknown;
}

export function getConditionalOrder(ctx: TossContext, accountSeq: number, id: string): Promise<TossConditionalOrder> {
	return tossGet(ctx, `/api/v1/conditional-orders/${encodeURIComponent(id)}`, { accountSeq, group: "CONDITIONAL_ORDER_HISTORY" });
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
		group: "ORDER_HISTORY" // 규격의 그룹 — 예전엔 ORDER_INFO 로 잘못 잡혀 있었다,
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
