/**
 * 주문 실행기 — 사람이 확인 카드에서 [확인] 을 눌렀을 때 서버가 부르는 **유일한 쓰기 경로** (PLAN §33).
 *
 * 입력은 서명·검증된 확인 토큰에 담긴 동작(OrderAction) 하나다. 동작의 종류(kind)와 증권사(broker)만 보고
 * API 를 고른다 — 토큰에 적힌 증권사가 아닌 곳으로 주문이 나가지 않는다 (예전 실행 경로는 broker 를 보지 않고
 * 항상 토스로 보냈다).
 *
 * 멱등성: 토스는 nonce 를 clientOrderId 로 보내 중복 생성을 막는다. KIS 는 멱등성 키가 없어 nonce 소비(서버)와
 * 자동 재시도 금지(kisPost)로 막는다.
 */
import { describeAction, type OrderAction } from "./actions.ts";
import { kisChangeOrder, kisPlaceOrder } from "./kis/orders.ts";
import type { BrokerAccess } from "./portfolio.ts";
import { defaultAccountSeq } from "./toss/api.ts";
import {
	cancelConditionalOrder,
	cancelOrder,
	createConditionalOrder,
	createOrder,
	modifyConditionalOrder,
	modifyOrder,
	tossModifyBody,
} from "./toss/orders.ts";

export interface ExecResult {
	/** 화면에 보여줄 한 줄 */
	message: string;
	orderId?: string;
	conditionalOrderId?: string;
}

function need<T>(get: (() => T) | undefined, name: string): T {
	if (!get) throw new Error(`${name} 연결이 없습니다 — 설정 화면에서 키를 확인하세요.`);
	return get();
}

/** 토큰은 우리 코드가 서명하지만, 실행 직전에 한 번 더 — 수량·가격이 말이 되는가 */
function sane(a: OrderAction): void {
	const pos = (v: number | undefined, what: string) => {
		if (v === undefined) return;
		if (!Number.isFinite(v) || v <= 0) throw new Error(`${what} 값이 올바르지 않습니다: ${v}`);
	};
	if (a.kind === "place" || a.kind === "modify") {
		pos(a.quantity, "수량");
		pos(a.price, "가격");
	}
	if (a.kind === "conditional-create" || a.kind === "conditional-modify") {
		pos(a.quantity, "수량");
		pos(a.first.triggerPrice, "감시가");
		pos(a.second?.triggerPrice, "감시가");
	}
}

export async function executeOrderAction(action: OrderAction, nonce: string, access: BrokerAccess): Promise<ExecResult> {
	sane(action);
	switch (action.kind) {
		case "place": {
			if (action.broker === "kis") {
				const r = await kisPlaceOrder(need(access.kis, "한국투자증권"), action);
				return { message: "주문이 접수되었습니다", orderId: r.orderId };
			}
			const ctx = need(access.toss, "토스증권");
			const r = await createOrder(ctx, await defaultAccountSeq(ctx), {
				symbol: action.symbol,
				side: action.side,
				orderType: action.orderType,
				quantity: String(action.quantity),
				...(action.orderType === "LIMIT" && action.price !== undefined ? { price: String(action.price) } : {}),
				clientOrderId: nonce,
			});
			return { message: "주문이 접수되었습니다", orderId: r.orderId };
		}
		case "modify":
		case "cancel": {
			if (action.broker === "kis") {
				const r = await kisChangeOrder(need(access.kis, "한국투자증권"), action);
				return { message: action.kind === "cancel" ? "취소가 접수되었습니다" : "정정이 접수되었습니다", orderId: r.orderId };
			}
			const ctx = need(access.toss, "토스증권");
			const seq = await defaultAccountSeq(ctx);
			if (action.kind === "cancel") {
				await cancelOrder(ctx, seq, action.original.orderId);
				return { message: "취소가 접수되었습니다", orderId: action.original.orderId };
			}
			const r = await modifyOrder(ctx, seq, action.original.orderId, tossModifyBody(action.market, action.orderType, action.quantity, action.price));
			return { message: "정정이 접수되었습니다", orderId: r.orderId ?? action.original.orderId };
		}
		case "conditional-create": {
			const ctx = need(access.toss, "토스증권");
			const r = await createConditionalOrder(ctx, await defaultAccountSeq(ctx), action, nonce);
			return { message: "조건주문이 등록되었습니다", conditionalOrderId: r.conditionalOrderId };
		}
		case "conditional-modify": {
			const ctx = need(access.toss, "토스증권");
			const r = await modifyConditionalOrder(ctx, await defaultAccountSeq(ctx), action.conditionalOrderId, action);
			// 규격: 수정은 취소 후 재생성 — 번호가 바뀐다
			return { message: "조건주문이 수정되었습니다 (새 번호가 발급됩니다)", conditionalOrderId: r.conditionalOrderId };
		}
		case "conditional-cancel": {
			const ctx = need(access.toss, "토스증권");
			await cancelConditionalOrder(ctx, await defaultAccountSeq(ctx), action.conditionalOrderId);
			return { message: "조건주문이 취소되었습니다", conditionalOrderId: action.conditionalOrderId };
		}
	}
}

export { describeAction };
