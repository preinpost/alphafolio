/**
 * 토스증권 타입드 API — 조회 전용.
 *
 * 주문/조건주문 API 는 의도적으로 넣지 않았다 (KIS 와 동일 방침).
 */
import { tossGet, type TossContext } from "./client.ts";

export interface TossPrice {
	symbol: string;
	timestamp: string | null;
	lastPrice: string;
	currency: string;
}

export interface TossCandle {
	timestamp: string;
	openPrice: string;
	highPrice: string;
	lowPrice: string;
	closePrice: string;
	volume: string;
	currency: string;
}

export interface TossAccount {
	accountNo: string;
	accountSeq: number;
	accountType: string;
}

/** 통화별 금액 맵 — 토스는 KRW/USD 를 섞지 않고 통화별로 합산해서 준다. */
export type TossPriceMap = Record<string, string>;

export interface TossHoldingsItem {
	symbol: string;
	name: string;
	marketCountry: "KR" | "US";
	currency: string;
	quantity: string;
	lastPrice: string;
	averagePurchasePrice: string;
	marketValue: { purchaseAmount: string; amount: string; amountAfterCost: string };
	profitLoss: { amount: string; rate: string };
}

export interface TossHoldings {
	totalPurchaseAmount: TossPriceMap;
	marketValue: { amount: TossPriceMap };
	profitLoss: { amount: TossPriceMap; rate: string };
	items: TossHoldingsItem[];
}

/** 현재가 (최대 200종목). */
export function tossPrices(ctx: TossContext, symbols: string[]): Promise<TossPrice[]> {
	return tossGet<TossPrice[]>(ctx, "/api/v1/prices", {
		query: { symbols: symbols.join(",") },
		group: "MARKET_DATA",
	});
}

/**
 * 캔들 — 토스는 **일봉(1d)과 1분봉(1m)만** 제공한다.
 * 주봉/월봉이 필요하면 KIS 를 쓰거나 일봉을 집계해야 한다.
 */
export function tossCandles(
	ctx: TossContext,
	symbol: string,
	opts?: { interval?: "1d" | "1m"; count?: number },
): Promise<{ candles: TossCandle[]; nextBefore: string | null }> {
	return tossGet<{ candles: TossCandle[]; nextBefore: string | null }>(ctx, "/api/v1/candles", {
		query: {
			symbol,
			interval: opts?.interval ?? "1d",
			count: Math.min(opts?.count ?? 100, 200),
			adjusted: true,
		},
		group: "MARKET_DATA_CHART",
	});
}

/** 계좌 목록 — accountSeq(정수 식별 키)를 얻는 유일한 경로. */
export function tossAccounts(ctx: TossContext): Promise<TossAccount[]> {
	return tossGet<TossAccount[]>(ctx, "/api/v1/accounts", { group: "ACCOUNT" });
}

/** 보유 주식 + 통화별 합계. */
export function tossHoldings(ctx: TossContext, accountSeq: number): Promise<TossHoldings> {
	return tossGet<TossHoldings>(ctx, "/api/v1/holdings", { accountSeq, group: "ASSET" });
}

/** 매수 가능 금액 (= 사실상 예수금). */
export function tossBuyingPower(
	ctx: TossContext,
	accountSeq: number,
	currency: "KRW" | "USD" = "KRW",
): Promise<{ currency: string; cashBuyingPower: string }> {
	return tossGet<{ currency: string; cashBuyingPower: string }>(ctx, "/api/v1/buying-power", {
		query: { currency },
		accountSeq,
		group: "ORDER_INFO",
	});
}

/** 환율 (USD→KRW 기본). KIS 잔고가 없어도 원화 환산이 가능해진다. */
export function tossExchangeRate(
	ctx: TossContext,
	baseCurrency = "USD",
	quoteCurrency = "KRW",
): Promise<{ rate: string; midRate: string }> {
	return tossGet<{ rate: string; midRate: string }>(ctx, "/api/v1/exchange-rate", {
		query: { baseCurrency, quoteCurrency },
		group: "MARKET_INFO",
	});
}

/** 계좌 식별 키 캐시 — 계좌 목록 API 는 1/s 로 가장 빡빡하다. */
const accountSeqCache = new Map<string, number>();

export async function defaultAccountSeq(ctx: TossContext): Promise<number> {
	const key = `${ctx.owner}:${ctx.creds.clientId}`;
	const hit = accountSeqCache.get(key);
	if (hit !== undefined) return hit;

	const accounts = await tossAccounts(ctx);
	const first = accounts[0];
	if (!first) throw new Error("토스증권 계좌를 찾지 못했습니다 (앱에서 계좌 개설 여부를 확인하세요).");

	accountSeqCache.set(key, first.accountSeq);
	return first.accountSeq;
}
