/**
 * 토스 체결 어댑터 (PLAN §40 2단계) — 국장·미장 같은 API.
 *
 *   호가      GET /api/v1/orderbook (asks 낮은 가격부터, bids 높은 가격부터)
 *   지정가    createOrder(clientOrderId) — 10분 안에 같은 값으로 다시 보내면 이전 결과를 돌려준다 (idempotent)
 *   취소      cancelOrder — 새 주문번호가 오지만, 체결량은 원주문 상세에 남는다
 *   상태      getOrder — PARTIAL_FILLED 는 진행 중·종료 두 그룹에 모두 있어 canceledAt 으로 가른다
 *
 * IOC 는 없다 (timeInForce DAY·CLS·OPG 뿐) — 체결기가 지정가 + 잔량 취소로 한다.
 */
import { isDomesticSymbol } from "../../quote.ts";
import { tossGet, TossError, type TossContext } from "../../toss/client.ts";
import { defaultAccountSeq } from "../../toss/api.ts";
import { cancelOrder, createOrder, getOrder, type TossOrder } from "../../toss/orders.ts";
import { priceText } from "./tick.ts";
import { VenueRejected, VenueUnknown, type Book, type BookLevel, type ExecVenue, type VenueOrderState } from "./types.ts";

interface TossOrderbook {
	timestamp?: string | null;
	asks?: Array<{ price: string | number; volume: string | number }>;
	bids?: Array<{ price: string | number; volume: string | number }>;
}

const levels = (xs: TossOrderbook["asks"]): BookLevel[] =>
	(xs ?? []).map((l) => ({ price: Number(l.price), volume: Number(l.volume) })).filter((l) => l.price > 0 && l.volume > 0);

export function tossBook(raw: TossOrderbook, at: number): Book {
	const asks = levels(raw.asks).sort((a, b) => a.price - b.price);
	const bids = levels(raw.bids).sort((a, b) => b.price - a.price);
	return { asks, bids, at };
}

const OPEN = new Set(["PENDING", "PENDING_CANCEL", "PENDING_REPLACE"]);

export function tossOrderState(o: TossOrder): VenueOrderState {
	const filledQty = Number(o.execution?.filledQuantity ?? 0) || 0;
	const avg = o.execution?.averageFilledPrice;
	const avgPrice = avg !== null && avg !== undefined && Number(avg) > 0 ? Number(avg) : null;
	const open = OPEN.has(o.status) || (o.status === "PARTIAL_FILLED" && !o.canceledAt);
	return { filledQty, avgPrice, open, ...(o.status === "REJECTED" ? { rejected: "증권사가 주문을 거부했습니다" } : {}) };
}

/** 토스 오류 → 거절(접수 안 됨) / 결과 모름. 4xx 는 거절, 5xx·응답 파싱 실패·연결 끊김은 모름 */
export function classifyTossError(err: unknown): Error {
	const msg = err instanceof Error ? err.message : String(err);
	if (err instanceof TossError && err.status >= 400 && err.status < 500) return new VenueRejected(msg);
	return new VenueUnknown(msg);
}

export async function tossVenue(ctx: TossContext, symbol: string, opts: { accountSeq?: number; now?: () => number } = {}): Promise<ExecVenue> {
	const market = isDomesticSymbol(symbol) ? "KR" : "US";
	const seq = opts.accountSeq ?? (await defaultAccountSeq(ctx));
	const now = opts.now ?? Date.now;
	return {
		label: market === "KR" ? "토스 국장" : "토스 미장",
		market,
		symbol,
		supportsIoc: false,
		idempotent: true,
		async book() {
			return tossBook(await tossGet<TossOrderbook>(ctx, "/api/v1/orderbook", { query: { symbol } }), now());
		},
		async place(o) {
			if (o.ioc) throw new VenueRejected("토스는 IOC 주문이 없습니다");
			try {
				const r = await createOrder(ctx, seq, {
					symbol,
					side: o.side,
					orderType: "LIMIT",
					quantity: String(o.quantity),
					price: priceText(market, o.price),
					timeInForce: "DAY",
					clientOrderId: o.clientId,
				});
				return { orderId: r.orderId };
			} catch (err) {
				throw classifyTossError(err);
			}
		},
		async cancel(orderId) {
			await cancelOrder(ctx, seq, orderId);
		},
		async status(orderId) {
			return tossOrderState(await getOrder(ctx, seq, orderId));
		},
	};
}
