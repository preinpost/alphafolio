/**
 * Binance Stocks — **직접 미국 주식 거래** (Nest Trading(ADGM) → Alpaca 체결·보관). `/sapi/v1/equity/*` (2026-08 공개, 공식 커넥터 @binance/stocks 1.0).
 * bStocks(토큰화 증서, 현물 AAPLBUSDT)와 다르다 — 이건 실제 주식이다.
 *
 *   규칙   GET  /market/exchangeInfo (API 키만, 서명 없음) — tradability BUY_SELL·BUY·SELL·NONE, fractionable, stepSize(실측 1e-9), minNotional(5)
 *   호가   GET  /market/quote — 최우선 매수·매도 한 단씩 (최대 ~5초 지연). 없으면 빈 본문
 *   주문   POST /order/place — LIMIT(price 소수 2자리 + quantity + tradingSession RTH·EXTENDED·24H) · MARKET(매수는 notional, 매도는 quantity)
 *          timeInForce DAY·GTC (IOC 없음). clientOrderId 32~36자. **tokenize 기본 true** — 보내지 않으면 산 주식이 bStock 토큰이 된다 → 늘 false
 *   취소   POST /order/cancel (orderId) — 응답 status S/F 는 접수 여부일 뿐, 결과는 /order/detail
 *   상태   GET  /order/detail (orderId 또는 clientOrderId) — status NEW·ACCEPTED·PARTIALLY_FILLED·FILLED·CANCELED·EXPIRED·REJECTED, filledQty, avgFilledPrice
 *   내역   GET  /order/history — 주문 단위, **fee (수수료 USD 누적)** 가 여기 있다 (detail·open-orders 에도)
 *   체결   GET  /trade/history — **보유 수량 API 가 없다.** 매도 가능 수량은 체결 내역(매수 − 매도)으로 추정한다 (앱에서 bStock 으로 바꾼 건 빠지지 않는다 →
 *          넘치면 거래소가 거절한다)
 *
 * 매수 대금은 기본 USDC (quoteAsset), 매도 대금도 USDC. 테스트넷은 없다 (실전 api.binance.com 만).
 * ⚠️ 쓰기 경로는 /order/place · /order/cancel 둘뿐 — 약관 동의(/account/disclaimer)·토큰 전환(mint/redeem)은 부르지 않는다.
 *    Funding 지갑(`POST /sapi/v1/asset/get-funding-asset`)은 POST 지만 조회다 — binance_stock_account 가 잔고 표시에만 쓴다.
 */
import { floorToStep } from "./decimal.ts";
import { plainDecimal } from "../triggers/venues/binance.ts";
import { signedRequest, type BinanceCreds } from "./trade.ts";
import { PROVIDERS } from "../data/gateway.ts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const EQUITY = "/sapi/v1/equity";
/** 매수 대금 기본 — 매도 대금도 USDC 로 들어온다 */
export const EQUITY_QUOTE = "USDC";
/** 가격은 소수 2자리까지 */
export const EQUITY_TICK = "0.01";

export class BinanceStockError extends Error {
	/** HTTP 상태 (0 = 응답 없음) */
	readonly status: number;
	readonly code: number | undefined;
	constructor(message: string, status: number, code?: number) {
		super(message);
		this.name = "BinanceStockError";
		this.status = status;
		this.code = code;
	}
}

export interface EquityRules {
	symbol: string;
	/** BUY_SELL · BUY · SELL · NONE */
	tradability: string;
	fractionable: boolean;
	extendedSession: boolean;
	overnightSupported: boolean;
	/** 소수점 주식이면 stepSize, 아니면 1 */
	stepSize: string;
	minQty: string;
	maxQty: string;
	minNotional: string;
	maxNotional: string;
	/** 기준가 대비 허용 범위 (1.1 · 0.9) */
	multiplierUp: string;
	multiplierDown: string;
	listingTime: number | null;
	delistingTime: number | null;
}

export function parseEquityRules(body: unknown): EquityRules | null {
	const s = ((body as { symbols?: unknown[] } | null)?.symbols ?? [])[0] as Record<string, unknown> | undefined;
	if (!s?.symbol) return null;
	const str = (v: unknown, d: string): string => (v === undefined || v === null || v === "" ? d : String(v));
	const fractionable = s.fractionable === true;
	const step = str(s.stepSize, "1");
	return {
		symbol: String(s.symbol),
		tradability: str(s.tradability, "NONE"),
		fractionable,
		extendedSession: s.extendedSession === true,
		overnightSupported: s.overnightSupported === true,
		// 소수점이 안 되는 종목은 1주 단위
		stepSize: fractionable ? step : "1",
		minQty: str(s.minQty, fractionable ? step : "1"),
		maxQty: str(s.maxQty, "1000000"),
		minNotional: str(s.minNotional, "0"),
		maxNotional: str(s.maxNotional, "0"),
		multiplierUp: str(s.multiplierUp, "0"),
		multiplierDown: str(s.multiplierDown, "0"),
		listingTime: typeof s.listingTime === "number" ? s.listingTime : null,
		delistingTime: typeof s.delistingTime === "number" ? s.delistingTime : null,
	};
}

/** 이 방향으로 거래할 수 있는가 — 아니면 이유 */
export function tradabilityProblem(r: EquityRules, side: "BUY" | "SELL"): string | null {
	const t = r.tradability;
	if (t === "BUY_SELL" || t === side) return null;
	if (t === "NONE") return `${r.symbol} 은(는) 지금 Binance 에서 거래할 수 없습니다`;
	return `${r.symbol} 은(는) 지금 ${t === "BUY" ? "매수" : "매도"}만 됩니다`;
}

/**
 * 체결기 clientId → Binance clientOrderId (32~36자, 영숫자·-·_). 뒤를 "_" 로 채운다 —
 * "x…-1" 과 "x…-10" 이 겹치지 않게 숫자가 아닌 글자로 (0 으로 채우면 겹친다).
 */
export function equityClientId(id: string): string {
	if (!/^[A-Za-z0-9_-]{1,36}$/.test(id)) throw new Error(`clientOrderId 형식이 올바르지 않습니다: ${id}`);
	return id.padEnd(32, "_");
}

export interface EquityOrder {
	orderId: string;
	clientOrderId: string | null;
	symbol: string;
	side: "BUY" | "SELL";
	orderType: string;
	limitPrice: string | null;
	qty: string | null;
	notional: string | null;
	filledQty: string;
	avgFilledPrice: string | null;
	status: string;
	session: string | null;
	/** 수수료 누적 (USD) — 응답에 없으면 null */
	fee: string | null;
	/** 생성 시각 (ms) — 내역 조회에서만 */
	createdAt: number | null;
}

export function parseEquityOrder(o: Record<string, unknown>): EquityOrder {
	const s = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
	return {
		orderId: String(o.orderId ?? ""),
		clientOrderId: s(o.clientOrderId),
		symbol: String(o.symbol ?? ""),
		side: String(o.side) === "SELL" ? "SELL" : "BUY",
		orderType: String(o.orderType ?? ""),
		limitPrice: s(o.limitPrice),
		qty: s(o.qty),
		notional: s(o.notional),
		filledQty: s(o.filledQty) ?? "0",
		avgFilledPrice: s(o.avgFilledPrice),
		status: String(o.status ?? ""),
		session: s(o.session),
		fee: s(o.fee),
		createdAt: o.createdAt === undefined || o.createdAt === null || !Number.isFinite(Number(o.createdAt)) ? null : Number(o.createdAt),
	};
}

/** 살아 있는(더 체결될 수 있는) 상태 */
export const EQUITY_OPEN = new Set(["NEW", "ACCEPTED", "PARTIALLY_FILLED", "PENDING_NEW", "PENDING_CANCEL"]);

// ── 요청 (순수) ────────────────────────────────────────────

export interface EquityPlace {
	symbol: string;
	side: "BUY" | "SELL";
	orderType: "LIMIT" | "MARKET";
	/** LIMIT — 소수 2자리 */
	price?: string;
	/** LIMIT 양쪽 · MARKET 매도 */
	quantity?: string;
	/** MARKET 매수 — USDC 금액 */
	notional?: string;
	/** LIMIT 만 — 기본 RTH (정규장) */
	session?: "RTH" | "EXTENDED" | "24H";
	clientOrderId: string;
	quoteAsset?: string;
}

/** 주문 파라미터 — 필드 조합 표(LIMIT/MARKET × BUY/SELL)를 지킨다. tokenize=false 는 늘 */
export function equityPlaceParams(p: EquityPlace): Record<string, string> {
	const q: Record<string, string> = {
		symbol: p.symbol,
		side: p.side,
		orderType: p.orderType,
		quoteAsset: p.quoteAsset ?? EQUITY_QUOTE,
		clientOrderId: equityClientId(p.clientOrderId),
		// 기본 true — 보내지 않으면 산 주식이 bStock 토큰으로 바뀐다
		tokenize: "false",
	};
	if (p.orderType === "LIMIT") {
		if (!p.price || !p.quantity) throw new BinanceStockError("지정가 주문에는 가격·수량이 필요합니다", 0);
		if (!/^\d+(\.\d{1,2})?$/.test(p.price)) throw new BinanceStockError(`가격은 소수 2자리까지입니다: ${p.price}`, 0);
		q.price = p.price;
		q.quantity = p.quantity;
		q.timeInForce = "DAY";
		q.tradingSession = p.session ?? "RTH";
	} else if (p.side === "BUY") {
		if (!p.notional) throw new BinanceStockError("시장가 매수는 금액(notional)으로 합니다", 0);
		q.notional = p.notional;
	} else {
		if (!p.quantity) throw new BinanceStockError("시장가 매도에는 수량이 필요합니다", 0);
		q.quantity = p.quantity;
	}
	return q;
}

// ── 호출 ───────────────────────────────────────────────────

export interface StockCallOptions {
	fetch?: FetchLike;
	now?: () => number;
}

function scrub(t: string, c: BinanceCreds): string {
	let out = t;
	for (const s of [c.key, c.secret]) if (s && s.length >= 6) out = out.split(s).join("****");
	return out;
}

/** 한 번 보낸다. 응답이 없거나 읽지 못하면 status 0 (결과 모름) */
export async function equityCall(
	c: BinanceCreds,
	method: "GET" | "POST",
	path: string,
	params: Record<string, string>,
	kind: "signed" | "key",
	opts: StockCallOptions = {},
): Promise<unknown> {
	if (c.testnet) throw new BinanceStockError("Binance 미국 주식은 테스트넷이 없습니다 — 실전 키로만 됩니다", 400);
	const f: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
	let url: string;
	let init: RequestInit;
	if (kind === "signed") ({ url, init } = signedRequest(method, `${EQUITY}${path}`, params, c, opts.now?.() ?? Date.now()));
	else {
		const qs = new URLSearchParams(params).toString();
		url = `${PROVIDERS.binance.base({ binance: c })}${EQUITY}${path}${qs ? `?${qs}` : ""}`;
		init = { method, headers: { "X-MBX-APIKEY": c.key }, signal: AbortSignal.timeout(10_000) };
	}
	let res: Response;
	try {
		res = await f(url, init);
	} catch (err) {
		throw new BinanceStockError(`Binance 주식 연결 실패: ${scrub(err instanceof Error ? err.message : String(err), c)}`, 0);
	}
	const text = await res.text().catch(() => "");
	if (!text) {
		if (!res.ok) throw new BinanceStockError(`Binance 주식 ${path} 실패 (HTTP ${res.status})`, res.status);
		return null; // 빈 본문 = 없음 (호가 없음 등)
	}
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new BinanceStockError(`Binance 주식 ${path} 응답을 읽지 못했습니다 (HTTP ${res.status}): ${scrub(text.slice(0, 160), c)}`, res.ok ? 0 : res.status);
	}
	const o = body as { code?: number; msg?: string } | null;
	if (!res.ok || (o && typeof o.code === "number" && o.code < 0)) {
		throw new BinanceStockError(`Binance 주식 ${path} 실패 (HTTP ${res.status}${o?.code !== undefined ? ` ${o.code}` : ""}): ${scrub(String(o?.msg ?? text.slice(0, 160)), c)}`, res.status || 400, o?.code);
	}
	return body;
}

const rulesCache = new Map<string, { at: number; rules: EquityRules | null }>();
export async function equityRules(c: BinanceCreds, symbol: string, opts: StockCallOptions = {}): Promise<EquityRules | null> {
	const hit = rulesCache.get(symbol);
	const now = opts.now?.() ?? Date.now();
	if (hit && now - hit.at < 10 * 60_000) return hit.rules;
	const rules = parseEquityRules(await equityCall(c, "GET", "/market/exchangeInfo", { symbol }, "key", opts));
	rulesCache.set(symbol, { at: now, rules });
	return rules;
}

export function clearEquityRulesCache(): void {
	rulesCache.clear();
}

export async function equityQuote(c: BinanceCreds, symbol: string, opts: StockCallOptions = {}): Promise<{ bid: number; ask: number; bidSize: number; askSize: number } | null> {
	const r = (await equityCall(c, "GET", "/market/quote", { symbol }, "key", opts)) as Record<string, unknown> | null;
	if (!r) return null;
	const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
	return { bid: n(r.bidPrice), ask: n(r.askPrice), bidSize: n(r.bidSize), askSize: n(r.askSize) };
}

export async function equityOpenOrders(c: BinanceCreds, opts: StockCallOptions = {}): Promise<EquityOrder[]> {
	const r = await equityCall(c, "GET", "/order/open-orders", {}, "signed", opts);
	return (Array.isArray(r) ? (r as Array<Record<string, unknown>>) : []).map(parseEquityOrder);
}

export async function equityOrderDetail(c: BinanceCreds, by: { orderId: string } | { clientOrderId: string }, opts: StockCallOptions = {}): Promise<EquityOrder> {
	const params: Record<string, string> = "orderId" in by ? { orderId: by.orderId } : { clientOrderId: equityClientId(by.clientOrderId) };
	return parseEquityOrder(((await equityCall(c, "GET", "/order/detail", params, "signed", opts)) ?? {}) as Record<string, unknown>);
}

/** 주문 — **실제 돈을 움직인다.** 접수 응답 status F 면 거절 */
export async function equityPlace(c: BinanceCreds, p: EquityPlace, opts: StockCallOptions = {}): Promise<{ orderId: string; clientOrderId: string }> {
	const r = (await equityCall(c, "POST", "/order/place", equityPlaceParams(p), "signed", opts)) as { status?: string; orderId?: string; clientOrderId?: string } | null;
	if (r?.status === "F") throw new BinanceStockError("Binance 가 주문을 받지 않았습니다 (status F)", 400);
	if (!r?.orderId) throw new BinanceStockError("주문 응답에 orderId 가 없습니다", 0);
	return { orderId: String(r.orderId), clientOrderId: String(r.clientOrderId ?? equityClientId(p.clientOrderId)) };
}

/** 취소 — **실제 돈을 움직인다.** status F 면 취소가 거절된 것 (이미 체결·닫힘 등) */
export async function equityCancel(c: BinanceCreds, orderId: string, opts: StockCallOptions = {}): Promise<void> {
	const r = (await equityCall(c, "POST", "/order/cancel", { orderId }, "signed", opts)) as { status?: string } | null;
	if (r?.status === "F") throw new BinanceStockError("취소가 받아들여지지 않았습니다 (이미 체결·취소됐을 수 있습니다)", 400);
}

// ── 보유 (체결 내역으로 추정) ───────────────────────────────

export interface EquityFill {
	/** 종목 — 전 종목 조회(symbol 없이)에서 묶을 때 쓴다 */
	symbol?: string;
	side: "BUY" | "SELL";
	qty: string;
	price: string;
	at: number;
}

/** 체결 내역 → 남은 수량·평단 (이동평균 — 매도는 평단을 바꾸지 않는다). 수량은 단위(step)로 내림 */
export function netPosition(fills: EquityFill[], step = "0.000000001"): { qty: number; avgPrice: number | null } {
	let qty = 0;
	let cost = 0;
	for (const f of [...fills].sort((a, b) => a.at - b.at)) {
		const q = Number(f.qty) || 0;
		if (f.side === "BUY") {
			cost += q * (Number(f.price) || 0);
			qty += q;
		} else {
			const sold = Math.min(q, qty);
			cost -= qty > 0 ? (cost / qty) * sold : 0;
			qty = Math.max(0, qty - q);
		}
	}
	const left = Number(floorToStep(plainDecimal(qty), step));
	return { qty: left, avgPrice: left > 0 && cost > 0 ? Number((cost / qty).toPrecision(12)) : null };
}

/** 종목의 체결 전부 (기간 from~지금, 100건씩). symbol 이 null 이면 전 종목 */
export async function equityFills(c: BinanceCreds, symbol: string | null, from: number, opts: StockCallOptions & { maxPages?: number } = {}): Promise<EquityFill[]> {
	const now = opts.now?.() ?? Date.now();
	const out: EquityFill[] = [];
	for (let page = 1; page <= (opts.maxPages ?? 20); page++) {
		const q: Record<string, string> = { startTime: String(from), endTime: String(now), current: String(page), size: "100" };
		if (symbol) q.symbol = symbol;
		const r = (await equityCall(c, "GET", "/trade/history", q, "signed", opts)) as {
			total?: number;
			rows?: Array<Record<string, unknown>>;
		} | null;
		const rows = r?.rows ?? [];
		for (const x of rows) {
			out.push({
				symbol: String(x.symbol ?? symbol ?? ""),
				side: String(x.side) === "SELL" ? "SELL" : "BUY",
				qty: String(x.qty ?? "0"),
				price: String(x.price ?? "0"),
				at: Number(x.executionAt ?? 0),
			});
		}
		if (rows.length < 100 || out.length >= Number(r?.total ?? 0)) break;
	}
	return out;
}

/** 이 종목의 보유 추정 — 상장(Binance 주식 서비스) 시점부터 체결 내역으로 */
export async function equityPosition(c: BinanceCreds, symbol: string, opts: StockCallOptions = {}): Promise<{ qty: number; avgPrice: number | null }> {
	const rules = await equityRules(c, symbol, opts);
	if (!rules) throw new BinanceStockError(`Binance 에서 거래할 수 없는 미국 주식입니다: ${symbol}`, 400);
	const now = opts.now?.() ?? Date.now();
	const from = rules.listingTime ?? now - 365 * 86_400_000;
	return netPosition(await equityFills(c, symbol, from, opts), rules.stepSize);
}

/** Binance 미국 주식 서비스 공개(2026-08) 전 — 전 종목 체결 조회의 시작점 */
export const EQUITY_SINCE = Date.UTC(2026, 7, 1);

export interface EquityHolding {
	symbol: string;
	qty: number;
	avgPrice: number | null;
	fills: number;
}

/** 전 종목 체결 → 종목별 남은 수량·평단 (다 판 종목은 뺀다). 순수 */
export function holdingsFromFills(fills: EquityFill[]): EquityHolding[] {
	const by = new Map<string, EquityFill[]>();
	for (const f of fills) {
		if (!f.symbol) continue;
		by.set(f.symbol, [...(by.get(f.symbol) ?? []), f]);
	}
	return [...by.entries()]
		.map(([symbol, fs]) => ({ symbol, ...netPosition(fs), fills: fs.length }))
		.filter((h) => h.qty > 0)
		.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** 주문 내역 (기간 from~지금, 100건씩, 최근 것부터일 수 있다 — 순서는 쓰지 않는다). symbol 이 null 이면 전 종목 */
export async function equityOrderHistory(
	c: BinanceCreds,
	symbol: string | null,
	from: number,
	opts: StockCallOptions & { maxPages?: number; orderStatus?: string } = {},
): Promise<EquityOrder[]> {
	const now = opts.now?.() ?? Date.now();
	const out: EquityOrder[] = [];
	for (let page = 1; page <= (opts.maxPages ?? 20); page++) {
		const q: Record<string, string> = { startTime: String(from), endTime: String(now), current: String(page), size: "100" };
		if (symbol) q.symbol = symbol;
		if (opts.orderStatus) q.orderStatus = opts.orderStatus;
		const r = (await equityCall(c, "GET", "/order/history", q, "signed", opts)) as { total?: number; rows?: Array<Record<string, unknown>> } | null;
		const rows = r?.rows ?? [];
		out.push(...rows.map(parseEquityOrder));
		if (rows.length < 100 || out.length >= Number(r?.total ?? 0)) break;
	}
	return out;
}

export interface EquityFees {
	symbol: string;
	/** 수수료 합계 (USD) */
	fee: number;
	/** 체결된 금액 합계 (USD) — 수수료율 계산용 */
	filled: number;
	orders: number;
}

/** 주문 내역 → 종목별 수수료 합계 (체결이 있는 주문만). 순수 */
export function feesFromOrders(orders: EquityOrder[]): EquityFees[] {
	const by = new Map<string, EquityFees>();
	for (const o of orders) {
		const qty = Number(o.filledQty) || 0;
		if (!(qty > 0) || !o.symbol) continue;
		const e = by.get(o.symbol) ?? { symbol: o.symbol, fee: 0, filled: 0, orders: 0 };
		e.fee += Number(o.fee) || 0;
		e.filled += qty * (Number(o.avgFilledPrice) || 0);
		e.orders += 1;
		by.set(o.symbol, e);
	}
	return [...by.values()]
		.map((e) => ({ ...e, fee: Number(e.fee.toFixed(6)), filled: Number(e.filled.toFixed(2)) }))
		.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** 보유 추정 — 전 종목 (체결 내역으로) */
export async function equityHoldings(c: BinanceCreds, opts: StockCallOptions & { from?: number } = {}): Promise<EquityHolding[]> {
	return holdingsFromFills(await equityFills(c, null, opts.from ?? EQUITY_SINCE, opts));
}

// ── Funding 지갑 ────────────────────────────────────────────

export interface FundingAsset {
	asset: string;
	free: string;
	locked: string;
	freeze: string;
	withdrawing: string;
}

export function parseFunding(body: unknown): FundingAsset[] {
	const s = (v: unknown): string => (v === undefined || v === null || v === "" ? "0" : String(v));
	return (Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [])
		.filter((x) => x.asset)
		.map((x) => ({ asset: String(x.asset), free: s(x.free), locked: s(x.locked), freeze: s(x.freeze), withdrawing: s(x.withdrawing) }));
}

/**
 * Funding 지갑 잔고 — `POST /sapi/v1/asset/get-funding-asset`. POST 지만 **조회**다 (돈을 움직이지 않는다).
 * Binance Pay·Card·Gift Card·Stock Token 자산이 여기 있다.
 */
export async function fundingAssets(c: BinanceCreds, opts: StockCallOptions = {}): Promise<FundingAsset[]> {
	if (c.testnet) throw new BinanceStockError("Funding 지갑은 테스트넷이 없습니다 — 실전 키로만 됩니다", 400);
	const f: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
	const { url, init } = signedRequest("POST", "/sapi/v1/asset/get-funding-asset", {}, c, opts.now?.() ?? Date.now());
	let res: Response;
	try {
		res = await f(url, init);
	} catch (err) {
		throw new BinanceStockError(`Funding 지갑 연결 실패: ${scrub(err instanceof Error ? err.message : String(err), c)}`, 0);
	}
	const text = await res.text().catch(() => "");
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : [];
	} catch {
		throw new BinanceStockError(`Funding 지갑 응답을 읽지 못했습니다 (HTTP ${res.status}): ${scrub(text.slice(0, 160), c)}`, res.ok ? 0 : res.status);
	}
	const o = body as { code?: number; msg?: string } | null;
	if (!res.ok || (o && !Array.isArray(o) && typeof o.code === "number" && o.code < 0)) {
		throw new BinanceStockError(`Funding 지갑 조회 실패 (HTTP ${res.status}${o?.code !== undefined ? ` ${o.code}` : ""}): ${scrub(String(o?.msg ?? text.slice(0, 160)), c)}`, res.status || 400, o?.code);
	}
	return parseFunding(body);
}
