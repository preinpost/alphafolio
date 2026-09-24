/**
 * Binance 현물 거래 — 주문·취소·재주문·OCO·OTO·전체 취소 (PLAN §36).
 *
 * ⚠️ place/cancel/… 실행 함수는 **실제 돈을 움직인다.** 서버의 확인 실행 경로(execute.ts)에서만 호출한다.
 * 이 모듈이 호출하는 쓰기 경로는 아래 여섯 개가 전부다 — 출금·이체·마진·전환 등 자금 이동 API 는 이 코드에 없다
 * (범용 조회 data_call 도 쓰기를 모두 거절한다).
 *   POST /api/v3/order · DELETE /api/v3/order · POST /api/v3/order/cancelReplace
 *   POST /api/v3/orderList/oco · POST /api/v3/orderList/oto · DELETE /api/v3/openOrders
 *
 * 요청 파라미터는 순수 함수(*Params)로 만든다 — 테스트가 한 글자씩 검사한다.
 * 멱등성: newClientOrderId(목록은 listClientOrderId)에 확인 토큰의 nonce — 같은 값으로 두 번 오면 Binance 가 거절한다.
 * 자동 재시도 없음 (응답을 못 받은 뒤 다시 보내면 중복 주문).
 */
import type {
	BinanceAction,
	BinanceCancelAction,
	BinanceCancelAllAction,
	BinanceOcoAction,
	BinanceOriginal,
	BinanceOtoAction,
	BinancePlaceAction,
	BinanceReplaceAction,
} from "../actions.ts";
import { binanceSign, PROVIDERS, type DataCreds } from "../data/gateway.ts";

export type BinanceCreds = NonNullable<DataCreds["binance"]>;

const base = (c: BinanceCreds | undefined): string => PROVIDERS.binance.base({ ...(c ? { binance: c } : {}) });

export class BinanceError extends Error {
	readonly code: number | undefined;
	constructor(message: string, code?: number) {
		super(message);
		this.name = "BinanceError";
		this.code = code;
	}
}

function scrub(text: string, c: BinanceCreds | undefined): string {
	let t = text;
	for (const s of [c?.key, c?.secret]) if (s && s.length >= 6) t = t.split(s).join("****");
	return t;
}

async function readJson(res: Response, c: BinanceCreds | undefined, label: string): Promise<unknown> {
	const text = await res.text();
	let data: unknown;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		throw new BinanceError(`${label} 응답을 읽지 못했습니다 (HTTP ${res.status}): ${scrub(text.slice(0, 160), c)}`);
	}
	const o = data as { code?: number; msg?: string } | null;
	if (!res.ok || (o && typeof o.code === "number" && o.code < 0)) {
		throw new BinanceError(`${label} 실패 (HTTP ${res.status}): ${scrub(String(o?.msg ?? text.slice(0, 160)), c)}`, o?.code);
	}
	return data;
}

/** 공개 조회 (키 없이) */
async function publicGet(path: string, query: Record<string, string>, c?: BinanceCreds): Promise<unknown> {
	const qs = new URLSearchParams(query).toString();
	const res = await fetch(`${base(c)}${path}${qs ? `?${qs}` : ""}`, { signal: AbortSignal.timeout(15_000) });
	return readJson(res, c, path);
}

/**
 * 서명 요청 — URL·헤더를 만드는 순수 함수. 파라미터는 쿼리로 보낸다 (POST 도 Binance 가 받는다).
 * timestamp·recvWindow 를 붙이고 **마지막에** signature.
 */
export function signedRequest(
	method: "GET" | "POST" | "DELETE",
	path: string,
	params: Record<string, string>,
	c: BinanceCreds,
	now: number = Date.now(),
): { url: string; init: RequestInit } {
	const q = new URLSearchParams(params);
	q.set("timestamp", String(now));
	q.set("recvWindow", "5000");
	const qs = q.toString();
	return {
		url: `${base(c)}${path}?${qs}&signature=${binanceSign(qs, c.secret)}`,
		init: { method, headers: { "X-MBX-APIKEY": c.key }, signal: AbortSignal.timeout(15_000) },
	};
}

async function signed(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string>, c: BinanceCreds, label: string): Promise<unknown> {
	const { url, init } = signedRequest(method, path, params, c);
	return readJson(await fetch(url, init), c, label);
}

// ── 거래소 규칙 ─────────────────────────────────────────────

export interface SymbolRules {
	symbol: string;
	status: string;
	base: string;
	quote: string;
	orderTypes: string[];
	spot: boolean;
	tickSize: string;
	minPrice: string;
	maxPrice: string;
	stepSize: string;
	minQty: string;
	maxQty: string;
	marketStepSize: string;
	marketMinQty: string;
	marketMaxQty: string;
	/** 최소 주문금액 (호가 자산) */
	minNotional: string;
	/** 시장가에도 최소 주문금액을 적용하는가 */
	notionalAppliesToMarket: boolean;
}

type Filter = Record<string, string | boolean | number>;

export function parseSymbolRules(info: unknown): SymbolRules | null {
	const s = ((info as { symbols?: unknown[] })?.symbols ?? [])[0] as Record<string, unknown> | undefined;
	if (!s) return null;
	const f = (type: string): Filter => ((s.filters as Filter[] | undefined) ?? []).find((x) => x.filterType === type) ?? {};
	const price = f("PRICE_FILTER");
	const lot = f("LOT_SIZE");
	const mlot = f("MARKET_LOT_SIZE");
	const notional = f("NOTIONAL");
	const minNotional = f("MIN_NOTIONAL");
	const str = (v: unknown, d = "0"): string => (v === undefined || v === null || v === "" ? d : String(v));
	return {
		symbol: str(s.symbol),
		status: str(s.status),
		base: str(s.baseAsset),
		quote: str(s.quoteAsset),
		orderTypes: (s.orderTypes as string[] | undefined) ?? [],
		spot: s.isSpotTradingAllowed !== false,
		tickSize: str(price.tickSize),
		minPrice: str(price.minPrice),
		maxPrice: str(price.maxPrice),
		stepSize: str(lot.stepSize),
		minQty: str(lot.minQty),
		maxQty: str(lot.maxQty),
		marketStepSize: str(mlot.stepSize, str(lot.stepSize)),
		marketMinQty: str(mlot.minQty, str(lot.minQty)),
		marketMaxQty: str(mlot.maxQty, str(lot.maxQty)),
		minNotional: str(notional.minNotional ?? minNotional.minNotional),
		notionalAppliesToMarket: (notional.applyMinToMarket ?? minNotional.applyToMarket) !== false,
	};
}

const rulesCache = new Map<string, { at: number; rules: SymbolRules | null }>();
export async function symbolRules(symbol: string, c?: BinanceCreds): Promise<SymbolRules | null> {
	const hit = rulesCache.get(symbol);
	if (hit && Date.now() - hit.at < 10 * 60_000) return hit.rules;
	const rules = parseSymbolRules(await publicGet("/api/v3/exchangeInfo", { symbol }, c).catch(() => null));
	rulesCache.set(symbol, { at: Date.now(), rules });
	return rules;
}

export async function lastPrice(symbol: string, c?: BinanceCreds): Promise<string> {
	const r = (await publicGet("/api/v3/ticker/price", { symbol }, c)) as { price?: string };
	if (!r?.price) throw new BinanceError(`${symbol} 현재가를 찾지 못했습니다`);
	return r.price;
}

/** 자산별 주문 가능 잔고(free) */
export async function freeBalances(c: BinanceCreds): Promise<Record<string, string>> {
	const r = (await signed("GET", "/api/v3/account", { omitZeroBalances: "true" }, c, "잔고 조회")) as { balances?: Array<{ asset: string; free: string }> };
	return Object.fromEntries((r.balances ?? []).map((b) => [b.asset, b.free]));
}

export async function openOrders(c: BinanceCreds, symbol?: string): Promise<Array<BinanceOriginal & { symbol: string }>> {
	const r = (await signed("GET", "/api/v3/openOrders", symbol ? { symbol } : {}, c, "미체결 조회")) as Array<Record<string, unknown>>;
	return (Array.isArray(r) ? r : []).map((o) => ({
		symbol: String(o.symbol),
		orderId: Number(o.orderId),
		side: String(o.side) as BinanceOriginal["side"],
		type: String(o.type),
		price: String(o.price ?? "0"),
		origQty: String(o.origQty ?? "0"),
		executedQty: String(o.executedQty ?? "0"),
	}));
}

// ── 요청 파라미터 (순수) ────────────────────────────────────

export function placeParams(a: BinancePlaceAction, nonce: string): Record<string, string> {
	const p: Record<string, string> = { symbol: a.symbol, side: a.side, type: a.type, newClientOrderId: nonce, newOrderRespType: "RESULT" };
	if (a.type === "LIMIT") {
		if (!a.price || !a.quantity) throw new BinanceError("지정가 주문에는 가격·수량이 필요합니다");
		p.timeInForce = "GTC";
		p.quantity = a.quantity;
		p.price = a.price;
	} else if (a.quoteOrderQty) {
		// 시장가 매수를 금액으로 — 수량은 보내지 않는다 (둘 다 보내면 거절)
		p.quoteOrderQty = a.quoteOrderQty;
	} else {
		if (!a.quantity) throw new BinanceError("시장가 주문에는 수량이나 금액이 필요합니다");
		p.quantity = a.quantity;
	}
	return p;
}

export const cancelParams = (a: BinanceCancelAction, nonce: string): Record<string, string> => ({
	symbol: a.symbol,
	orderId: String(a.original.orderId),
	newClientOrderId: nonce,
});

export function replaceParams(a: BinanceReplaceAction, nonce: string): Record<string, string> {
	return {
		symbol: a.symbol,
		side: a.original.side,
		type: "LIMIT",
		// 취소가 실패하면(이미 체결됨 등) 새 주문을 내지 않는다
		cancelReplaceMode: "STOP_ON_FAILURE",
		cancelOrderId: String(a.original.orderId),
		timeInForce: "GTC",
		quantity: a.quantity,
		price: a.price,
		newClientOrderId: nonce,
	};
}

export function ocoParams(a: BinanceOcoAction, nonce: string): Record<string, string> {
	return {
		symbol: a.symbol,
		side: "SELL",
		quantity: a.quantity,
		listClientOrderId: nonce,
		// 위: 익절 지정가 (메이커 전용) / 아래: 손절 스톱 지정가
		aboveType: "LIMIT_MAKER",
		abovePrice: a.takeProfitPrice,
		belowType: "STOP_LOSS_LIMIT",
		belowStopPrice: a.stopPrice,
		belowPrice: a.stopLimitPrice,
		belowTimeInForce: "GTC",
	};
}

export function otoParams(a: BinanceOtoAction, nonce: string): Record<string, string> {
	return {
		symbol: a.symbol,
		listClientOrderId: nonce,
		workingType: "LIMIT",
		workingSide: "BUY",
		workingPrice: a.buyPrice,
		workingQuantity: a.quantity,
		workingTimeInForce: "GTC",
		pendingType: "LIMIT",
		pendingSide: "SELL",
		pendingPrice: a.sellPrice,
		pendingQuantity: a.quantity,
		pendingTimeInForce: "GTC",
	};
}

export const cancelAllParams = (a: BinanceCancelAllAction): Record<string, string> => ({ symbol: a.symbol });

// ── 실행 — **실제 돈을 움직인다** ───────────────────────────

export async function executeBinance(a: BinanceAction, nonce: string, c: BinanceCreds): Promise<{ message: string; orderId?: string }> {
	switch (a.kind) {
		case "binance-place": {
			const r = (await signed("POST", "/api/v3/order", placeParams(a, nonce), c, "주문")) as { orderId?: number; status?: string };
			return { message: `주문이 접수되었습니다${r.status ? ` (${r.status})` : ""}`, orderId: r.orderId !== undefined ? String(r.orderId) : undefined };
		}
		case "binance-cancel":
			await signed("DELETE", "/api/v3/order", cancelParams(a, nonce), c, "취소");
			return { message: "취소되었습니다", orderId: String(a.original.orderId) };
		case "binance-replace": {
			const r = (await signed("POST", "/api/v3/order/cancelReplace", replaceParams(a, nonce), c, "재주문")) as { newOrderResponse?: { orderId?: number } };
			return { message: "재주문이 접수되었습니다", orderId: r.newOrderResponse?.orderId !== undefined ? String(r.newOrderResponse.orderId) : undefined };
		}
		case "binance-oco": {
			const r = (await signed("POST", "/api/v3/orderList/oco", ocoParams(a, nonce), c, "OCO")) as { orderListId?: number };
			return { message: "익절·손절(OCO)이 등록되었습니다", orderId: r.orderListId !== undefined ? `list ${r.orderListId}` : undefined };
		}
		case "binance-oto": {
			const r = (await signed("POST", "/api/v3/orderList/oto", otoParams(a, nonce), c, "OTO")) as { orderListId?: number };
			return { message: "매수 후 매도(OTO)가 등록되었습니다", orderId: r.orderListId !== undefined ? `list ${r.orderListId}` : undefined };
		}
		case "binance-cancel-all": {
			const r = await signed("DELETE", "/api/v3/openOrders", cancelAllParams(a), c, "전체 취소");
			return { message: `미체결 ${Array.isArray(r) ? r.length : a.count}건이 취소되었습니다` };
		}
	}
}
