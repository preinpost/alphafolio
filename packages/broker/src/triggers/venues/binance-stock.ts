/**
 * Binance 미국 주식 체결 어댑터 (직접 거래 — Nest Trading → Alpaca). 체결기가 보는 네 동작만.
 *
 *   호가   /market/quote — 최우선 한 단씩 (최대 ~5초 지연). 체결기는 한 단만 보고 최악 허용가로 자른다
 *   지정가 /order/place LIMIT · DAY · RTH (자동 매매는 정규장만) · tokenize=false. IOC 없음 → 체결기가 지정가 + 잔량 취소
 *   취소   /order/cancel · 상태 /order/detail
 *
 * 가격은 0.01 단위, 수량은 종목의 stepSize (소수점 주식이면 1e-9, 아니면 1주). 최소 주문금액 5 USDC.
 * 멱등성: clientOrderId 가 같아도 다시 받아 주는지 문서에 없다 → idempotent=false. 결과를 모르면 clientOrderId 로 한 번 찾아본다.
 *
 * ⚠️ place/cancel 은 **실제 돈을 움직인다.** 켜진 트리거의 신호(주문 실행기)에서만 부른다.
 */
import { floorToStep } from "../../binance/decimal.ts";
import {
	BinanceStockError,
	EQUITY_OPEN,
	EQUITY_TICK,
	equityCancel,
	equityOrderDetail,
	equityPlace,
	equityQuote,
	equityRules,
	tradabilityProblem,
	type EquityOrder,
	type EquityRules,
	type StockCallOptions,
} from "../../binance/stocks.ts";
import type { BinanceCreds } from "../../binance/trade.ts";
import { cryptoGrid, plainDecimal } from "./binance.ts";
import { VenueRejected, VenueUnknown, type Book, type ExecVenue, type Grid, type VenueOrderState } from "./types.ts";

/** 종목 규칙 → 격자 (가격 0.01 · 수량 stepSize · 최소 주문금액) */
export function equityGrid(r: EquityRules): Grid {
	const g = cryptoGrid({
		symbol: r.symbol, status: "TRADING", base: r.symbol, quote: "USDC", orderTypes: ["LIMIT", "MARKET"], spot: true,
		tickSize: EQUITY_TICK, minPrice: EQUITY_TICK, maxPrice: "1000000", stepSize: r.stepSize, minQty: r.minQty, maxQty: r.maxQty,
		marketStepSize: r.stepSize, marketMinQty: r.minQty, marketMaxQty: r.maxQty, minNotional: r.minNotional, notionalAppliesToMarket: true,
	});
	return { ...g, unit: "주" };
}

export function equityOrderState(o: EquityOrder): VenueOrderState {
	const filledQty = Number(o.filledQty) || 0;
	const avg = Number(o.avgFilledPrice);
	return {
		filledQty,
		avgPrice: filledQty > 0 && avg > 0 ? avg : null,
		open: EQUITY_OPEN.has(o.status),
		...(o.status === "REJECTED" ? { rejected: "Binance 가 주문을 거부했습니다" } : {}),
	};
}

/** 오류 → 거절 / 모름. 응답 없음·5xx·-1006·-1007 은 모름, 그 밖의 4xx 는 거절 */
export function classifyEquityError(err: unknown): Error {
	const msg = err instanceof Error ? err.message : String(err);
	if (err instanceof BinanceStockError) {
		if (err.status === 0 || err.status >= 500 || err.code === -1006 || err.code === -1007) return new VenueUnknown(msg);
		return new VenueRejected(msg);
	}
	return new VenueUnknown(msg);
}

export async function binanceStockVenue(
	creds: BinanceCreds,
	symbol: string,
	opts: StockCallOptions & { rules?: EquityRules; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ExecVenue> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const rules = opts.rules ?? (await equityRules(creds, symbol, opts));
	if (!rules) throw new Error(`Binance 에서 거래할 수 없는 미국 주식입니다: ${symbol}`);
	if (rules.tradability === "NONE") throw new Error(`${symbol} 은(는) 지금 Binance 에서 거래할 수 없습니다`);
	if (rules.delistingTime && rules.delistingTime <= now()) throw new Error(`${symbol} 은(는) Binance 에서 상장 폐지됐습니다`);
	const grid = equityGrid(rules);
	const qtyText = (q: number) => floorToStep(plainDecimal(q), rules.stepSize);
	const priceText = (p: number) => floorToStep(plainDecimal(p), EQUITY_TICK);

	return {
		label: "Binance 미국 주식",
		market: "US",
		symbol,
		grid,
		supportsIoc: false,
		idempotent: false,
		async book(): Promise<Book> {
			const q = await equityQuote(creds, symbol, opts);
			return {
				bids: q && q.bid > 0 && q.bidSize > 0 ? [{ price: q.bid, volume: q.bidSize }] : [],
				asks: q && q.ask > 0 && q.askSize > 0 ? [{ price: q.ask, volume: q.askSize }] : [],
				at: now(),
			};
		},
		async place(o) {
			if (o.ioc) throw new VenueRejected("Binance 미국 주식은 IOC 주문이 없습니다");
			const bad = tradabilityProblem(rules, o.side);
			if (bad) throw new VenueRejected(bad);
			const quantity = qtyText(o.quantity);
			if (!(Number(quantity) > 0)) throw new VenueRejected(`수량이 수량 단위(${rules.stepSize})보다 작습니다: ${o.quantity}`);
			try {
				const r = await equityPlace(creds, { symbol, side: o.side, orderType: "LIMIT", price: priceText(o.price), quantity, session: "RTH", clientOrderId: o.clientId }, opts);
				return { orderId: r.orderId };
			} catch (err) {
				const e = classifyEquityError(err);
				if (!(e instanceof VenueUnknown)) throw e;
				// 접수됐는지 한 번 — 있으면 그 주문을 따라간다 (다시 보내지 않는다)
				await sleep(1_000);
				const found = await equityOrderDetail(creds, { clientOrderId: o.clientId }, opts).catch(() => null);
				if (found?.orderId) return { orderId: found.orderId };
				throw e;
			}
		},
		async cancel(orderId) {
			await equityCancel(creds, orderId, opts);
		},
		async status(orderId) {
			return equityOrderState(await equityOrderDetail(creds, { orderId }, opts));
		},
	};
}
