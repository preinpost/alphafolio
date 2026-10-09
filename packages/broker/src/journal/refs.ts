/**
 * 일지 ↔ 증권사 주문 — ref 문자열 하나로 잇는다 (순수).
 *
 *   토스            toss:<orderId>
 *   한국투자        kis:<주문일 YYYYMMDD>:<주문번호>   — 주문번호가 날마다 다시 1부터라 날짜가 필요하다.
 *                   날짜는 체결 내역의 ord_dt 와 같게: 국장 KST · 미장 뉴욕 현지 (자동 매매 체결기 kis.ts 와 같은 규칙)
 *   Binance 현물    binance:<SYMBOL>:<orderId>          — orderId 는 마켓마다 따로 센다
 *   Binance 주식    binance_stock:<orderId>
 *
 * 주문 접수(확인 카드)·자동 매매·체결 가져오기가 같은 함수로 ref 를 만들어야 같은 주문이 두 줄이 되지 않는다.
 */
import type { OrderAction } from "../actions.ts";
import type { ChildOrder } from "../triggers/executor.ts";
import { localDate } from "../triggers/market-time.ts";
import type { OrderTarget } from "../triggers/types.ts";
import { defaultCurrency } from "./validate.ts";
import type { JournalContext, JournalInput } from "./types.ts";

/** 주문번호 앞의 0 은 응답마다 다르게 온다 ("0000012345" · "12345") */
const odno = (v: string): string => v.trim().replace(/^0+(?=\d)/, "");

export const tossRef = (orderId: string): string => `toss:${orderId.trim()}`;
export const kisRef = (day: string, orderNo: string): string => `kis:${day.replaceAll("-", "")}:${odno(orderNo)}`;
export const binanceRef = (symbol: string, orderId: string | number): string => `binance:${symbol.toUpperCase()}:${String(orderId).trim()}`;
export const binanceStockRef = (orderId: string): string => `binance_stock:${orderId.trim()}`;

/** 한국투자 주문일 — 국장은 KST, 미장은 뉴욕 날짜 */
export function kisOrderDay(market: "KR" | "US", at: number): string {
	return localDate(at, market === "KR" ? "Asia/Seoul" : "America/New_York").ymd.replaceAll("-", "");
}

/** 일지에 남길 주문 — 신규 주문만. 정정·취소·조건주문·OCO·선물·지갑 이동은 매매 한 건이 아니다 */
export interface OrderJournal {
	ref: string;
	input: Omit<JournalInput, "thesis" | "targetPrice" | "stopPrice" | "tags" | "emotion" | "review" | "conversationId" | "name">;
}

/**
 * 확인 카드로 접수된 주문 → 일지 한 줄 (pending). 체결은 아직 모른다 — 가져오기가 수량·평단을 채운다.
 * 주문번호가 없으면(응답에 없었다) null — 이을 방법이 없다.
 */
export function orderJournal(action: OrderAction, orderId: string | undefined, now: number): OrderJournal | null {
	if (!orderId) return null;
	const base = { at: now, fee: null, status: "pending" as const, source: "order" as const };
	if (action.kind === "place") {
		const ctx: JournalContext = { orderType: action.orderType, ordered: action.quantity, ...(action.price !== undefined ? { limitPrice: action.price } : {}) };
		return {
			ref: action.broker === "kis" ? kisRef(kisOrderDay(action.market, now), orderId) : tossRef(orderId),
			input: { ...base, broker: action.broker, symbol: action.symbol, side: action.side, quantity: action.quantity, price: action.price ?? null, currency: action.currency, context: ctx },
		};
	}
	if (action.kind === "binance-place") {
		const qty = Number(action.quantity ?? 0);
		const limit = action.price !== undefined ? Number(action.price) : undefined;
		const amount = action.quoteOrderQty !== undefined ? Number(action.quoteOrderQty) : undefined;
		const ctx: JournalContext = { orderType: action.type, ...(qty > 0 ? { ordered: qty } : {}), ...(limit ? { limitPrice: limit } : {}), ...(amount ? { orderAmount: amount } : {}) };
		return {
			ref: binanceRef(action.symbol, orderId),
			input: { ...base, broker: "binance", symbol: action.symbol, side: action.side, quantity: qty > 0 ? qty : 0, price: limit ?? null, currency: action.quote, context: ctx },
		};
	}
	if (action.kind === "binance-stock-place") {
		const qty = Number(action.quantity ?? 0);
		const limit = action.price !== undefined ? Number(action.price) : undefined;
		const amount = action.notional !== undefined ? Number(action.notional) : undefined;
		const ctx: JournalContext = { orderType: action.type, ...(qty > 0 ? { ordered: qty } : {}), ...(limit ? { limitPrice: limit } : {}), ...(amount ? { orderAmount: amount } : {}) };
		return {
			ref: binanceStockRef(orderId),
			input: { ...base, broker: "binance_stock", symbol: action.symbol, side: action.side, quantity: qty > 0 ? qty : 0, price: limit ?? null, currency: "USD", context: ctx },
		};
	}
	return null;
}

/**
 * 정정·재주문으로 주문번호가 바뀌었다 — 원주문 기록에 새 ref 를 붙인다 (체결은 새 번호로 잡힌다).
 * 바뀌지 않았거나 이을 수 없으면 null.
 */
export function replacedRefs(action: OrderAction, newOrderId: string | undefined, now: number): { parent: string; child: string } | null {
	if (!newOrderId) return null;
	if (action.kind === "modify") {
		if (odno(newOrderId) === odno(action.original.orderId)) return null;
		if (action.broker === "kis") {
			// 정정은 같은 날 원주문에 한다 — 주문일은 지금 날짜로 본다
			const day = kisOrderDay(action.market, now);
			return { parent: kisRef(day, action.original.orderId), child: kisRef(day, newOrderId) };
		}
		return { parent: tossRef(action.original.orderId), child: tossRef(newOrderId) };
	}
	if (action.kind === "binance-replace") {
		if (String(action.original.orderId) === newOrderId) return null;
		return { parent: binanceRef(action.symbol, action.original.orderId), child: binanceRef(action.symbol, newOrderId) };
	}
	return null;
}

/**
 * 자동 매매 자식 주문 → ref. 한 신호가 주문 여러 개(호가 따라가기·잔량 재주문)로 나가도 일지는 한 줄이다.
 * KIS 자식 주문의 ref 는 "조직번호|주문일" (venues/kis.ts) — 주문일을 거기서 읽는다.
 */
export function execRefs(target: OrderTarget["broker"], symbol: string, children: readonly Pick<ChildOrder, "orderId" | "ref">[]): string[] {
	const out: string[] = [];
	for (const c of children) {
		if (!c.orderId) continue;
		if (target === "kis") {
			const day = (c.ref ?? "").split("|")[1];
			if (day) out.push(kisRef(day, c.orderId));
		} else if (target === "toss") out.push(tossRef(c.orderId));
		else if (target === "binance") out.push(binanceRef(symbol, c.orderId));
		else out.push(binanceStockRef(c.orderId));
	}
	return [...new Set(out)];
}

/** 자동 매매의 통화 — 코인은 마켓의 호가 자산 (자동 매매는 USDT 마켓만), Binance 주식은 달러 */
export function execCurrency(target: OrderTarget["broker"], symbol: string, currency: string): string {
	if (target === "binance") return defaultCurrency(symbol);
	if (target === "binance_stock") return "USD";
	return currency;
}
