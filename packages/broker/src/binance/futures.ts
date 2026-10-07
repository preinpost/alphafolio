/**
 * Binance USDⓈ-M 선물 — 계좌·포지션 조회 + 진입·청산·익절/손절·취소·종목 설정 (fapi).
 *
 * ⚠️ executeFutures 는 **실제 돈을 움직인다.** 서버의 확인 실행 경로(execute.ts)에서만 호출한다.
 * 이 모듈의 쓰기는 아래가 전부다:
 *   POST /fapi/v1/marginType · POST /fapi/v1/leverage                     종목 설정 (진입 직전 · settings)
 *   POST /fapi/v1/order · DELETE /fapi/v1/order · DELETE /fapi/v1/allOpenOrders
 *   POST /fapi/v1/algoOrder · DELETE /fapi/v1/algoOrder · DELETE /fapi/v1/algoOpenOrders   조건부 (익절·손절)
 * 익절·손절(STOP_MARKET·TAKE_PROFIT_MARKET)은 일반 주문 API 가 거절한다
 * (실측 2026-10-07: /fapi/v1/order/test → -4120 "Please use the Algo Order API endpoints") — Algo 로 건다.
 * 포지션 모드(단방향·양방향)·멀티에셋 모드는 계정 전체 설정이라 바꾸지 않는다 (읽기만).
 *
 * 멱등성: newClientOrderId·clientAlgoId 에 확인 토큰 nonce (26자 — 익절 tp·손절 sl 접미사를 붙여도 36자 안).
 * 자동 재시도 없음 (응답을 못 받은 뒤 다시 보내면 중복 주문).
 * 값은 문자열 10진수 그대로 (decimal.ts).
 */
import type {
	BinanceFuturesAction,
	BinanceFuturesCancelAction,
	BinanceFuturesCloseAction,
	BinanceFuturesOpenAction,
	BinanceFuturesSettingsAction,
	FuturesMarginType,
	FuturesOriginal,
	FuturesPositionSide,
} from "../actions.ts";
import type { OrderSide } from "../orders.ts";
import { BinanceError, publicGet, signed, type BinanceCreds } from "./trade.ts";

/** 테스트넷은 현물(testnet.binance.vision)과 키가 따로다 — 선물 테스트넷 키를 BINANCE_ENV=testnet 과 함께 넣어야 한다 */
export const futuresHost = (c?: BinanceCreds): string => (c?.testnet ? "https://testnet.binancefuture.com" : "https://fapi.binance.com");

const fget = (path: string, params: Record<string, string>, c: BinanceCreds, label: string): Promise<unknown> =>
	signed("GET", path, params, c, label, futuresHost(c));

const str = (v: unknown, d = "0"): string => (v === undefined || v === null || v === "" ? d : String(v));

// ── 거래소 규칙 ─────────────────────────────────────────────

export interface FuturesRules {
	symbol: string;
	status: string;
	/** PERPETUAL(무기한) · CURRENT_QUARTER 등 */
	contractType: string;
	base: string;
	quote: string;
	marginAsset: string;
	orderTypes: string[];
	tickSize: string;
	minPrice: string;
	maxPrice: string;
	stepSize: string;
	minQty: string;
	maxQty: string;
	marketStepSize: string;
	marketMinQty: string;
	marketMaxQty: string;
	/** 최소 주문금액 (증거금 자산) — 포지션을 줄이는 주문에는 적용되지 않는다 */
	minNotional: string;
	/** 지정가 허용 범위 — 표시가격 × multiplierDown ~ × multiplierUp */
	multiplierUp: string;
	multiplierDown: string;
}

type Filter = Record<string, string | number | boolean>;

export function parseFuturesSymbol(s: Record<string, unknown>): FuturesRules {
	const f = (type: string): Filter => ((s.filters as Filter[] | undefined) ?? []).find((x) => x.filterType === type) ?? {};
	const price = f("PRICE_FILTER");
	const lot = f("LOT_SIZE");
	const mlot = f("MARKET_LOT_SIZE");
	const pct = f("PERCENT_PRICE");
	return {
		symbol: str(s.symbol, ""),
		status: str(s.status, ""),
		contractType: str(s.contractType, ""),
		base: str(s.baseAsset, ""),
		quote: str(s.quoteAsset, ""),
		marginAsset: str(s.marginAsset, str(s.quoteAsset, "")),
		orderTypes: (s.orderTypes as string[] | undefined) ?? [],
		tickSize: str(price.tickSize),
		minPrice: str(price.minPrice),
		maxPrice: str(price.maxPrice),
		stepSize: str(lot.stepSize),
		minQty: str(lot.minQty),
		maxQty: str(lot.maxQty),
		marketStepSize: str(mlot.stepSize, str(lot.stepSize)),
		marketMinQty: str(mlot.minQty, str(lot.minQty)),
		marketMaxQty: str(mlot.maxQty, str(lot.maxQty)),
		minNotional: str(f("MIN_NOTIONAL").notional),
		multiplierUp: str(pct.multiplierUp),
		multiplierDown: str(pct.multiplierDown),
	};
}

/** 선물 exchangeInfo 는 종목 지정이 없어 전체(~900종목)를 받는다 — 10분 캐시 */
let infoCache: { at: number; host: string; rules: Map<string, FuturesRules> } | null = null;

export async function futuresRules(symbol: string, c?: BinanceCreds): Promise<FuturesRules | null> {
	const host = futuresHost(c);
	if (!infoCache || infoCache.host !== host || Date.now() - infoCache.at > 10 * 60_000) {
		const info = (await publicGet("/fapi/v1/exchangeInfo", {}, c, host)) as { symbols?: Array<Record<string, unknown>> };
		infoCache = { at: Date.now(), host, rules: new Map((info.symbols ?? []).map((s) => [String(s.symbol), parseFuturesSymbol(s)])) };
	}
	return infoCache.rules.get(symbol) ?? null;
}

/** 테스트 */
export function clearFuturesCache(): void {
	infoCache = null;
}

export interface FuturesMark {
	markPrice: string;
	/** 마지막 펀딩 비율 (0.0001 = 0.01%) */
	fundingRate: string;
	nextFundingTime: number;
}

export async function futuresMark(symbol: string, c?: BinanceCreds): Promise<FuturesMark> {
	const r = (await publicGet("/fapi/v1/premiumIndex", { symbol }, c, futuresHost(c))) as Record<string, unknown>;
	if (!(Number(r?.markPrice) > 0)) throw new BinanceError(`${symbol} 선물 표시가격을 찾지 못했습니다`);
	return { markPrice: str(r.markPrice), fundingRate: str(r.lastFundingRate), nextFundingTime: Number(r.nextFundingTime) || 0 };
}

// ── 계좌·포지션 ─────────────────────────────────────────────

export interface FuturesAsset {
	asset: string;
	walletBalance: string;
	unrealizedProfit: string;
	/** 지갑 + 미실현 */
	marginBalance: string;
	/** 새 주문에 쓸 수 있는 증거금 */
	availableBalance: string;
	/** 지갑 밖으로 옮길 수 있는 수량 */
	maxWithdrawAmount: string;
}

export interface FuturesAccount {
	totalWalletBalance: string;
	totalUnrealizedProfit: string;
	totalMarginBalance: string;
	availableBalance: string;
	totalInitialMargin: string;
	totalMaintMargin: string;
	assets: FuturesAsset[];
}

export async function futuresAccount(c: BinanceCreds): Promise<FuturesAccount> {
	const r = (await fget("/fapi/v3/account", {}, c, "선물 계좌 조회")) as Record<string, unknown>;
	return {
		totalWalletBalance: str(r.totalWalletBalance),
		totalUnrealizedProfit: str(r.totalUnrealizedProfit),
		totalMarginBalance: str(r.totalMarginBalance),
		availableBalance: str(r.availableBalance),
		totalInitialMargin: str(r.totalInitialMargin),
		totalMaintMargin: str(r.totalMaintMargin),
		assets: ((r.assets as Array<Record<string, unknown>> | undefined) ?? []).map((a) => ({
			asset: str(a.asset, ""),
			walletBalance: str(a.walletBalance),
			unrealizedProfit: str(a.unrealizedProfit),
			marginBalance: str(a.marginBalance),
			availableBalance: str(a.availableBalance),
			maxWithdrawAmount: str(a.maxWithdrawAmount),
		})),
	};
}

export interface FuturesPosition {
	symbol: string;
	positionSide: FuturesPositionSide;
	/** 부호 포함 — 양수 롱, 음수 숏 */
	amt: string;
	entryPrice: string;
	breakEvenPrice: string;
	markPrice: string;
	unrealized: string;
	liquidationPrice: string;
	notional: string;
	/** 격리 증거금 (교차면 0) */
	isolatedMargin: string;
	marginAsset: string;
}

/** 열린 포지션만 (수량 0 은 뺀다) */
export async function futuresPositions(c: BinanceCreds, symbol?: string): Promise<FuturesPosition[]> {
	const r = (await fget("/fapi/v3/positionRisk", symbol ? { symbol } : {}, c, "선물 포지션 조회")) as Array<Record<string, unknown>>;
	return (Array.isArray(r) ? r : [])
		.filter((p) => Number(p.positionAmt) !== 0)
		.map((p) => ({
			symbol: str(p.symbol, ""),
			positionSide: str(p.positionSide, "BOTH") as FuturesPositionSide,
			amt: str(p.positionAmt),
			entryPrice: str(p.entryPrice),
			breakEvenPrice: str(p.breakEvenPrice),
			markPrice: str(p.markPrice),
			unrealized: str(p.unRealizedProfit),
			liquidationPrice: str(p.liquidationPrice),
			notional: str(p.notional),
			isolatedMargin: str(p.isolatedMargin),
			marginAsset: str(p.marginAsset, "USDT"),
		}));
}

export interface SymbolConfig {
	leverage: number;
	marginType: FuturesMarginType;
}

/** 종목별 레버리지·증거금 방식 (포지션 조회 v3 에는 이 값이 없다) */
export async function futuresSymbolConfig(c: BinanceCreds, symbol: string): Promise<SymbolConfig> {
	const r = (await fget("/fapi/v1/symbolConfig", { symbol }, c, "선물 종목 설정 조회")) as Array<Record<string, unknown>> | Record<string, unknown>;
	const row = (Array.isArray(r) ? r.find((x) => x.symbol === symbol) : r) ?? {};
	return { leverage: Number(row.leverage) || 1, marginType: row.marginType === "ISOLATED" ? "ISOLATED" : "CROSSED" };
}

/** 양방향(Hedge) 모드인가 — 계정 전체 설정 */
export async function futuresHedgeMode(c: BinanceCreds): Promise<boolean> {
	const r = (await fget("/fapi/v1/positionSide/dual", {}, c, "포지션 모드 조회")) as { dualSidePosition?: boolean };
	return r.dualSidePosition === true;
}

export async function futuresMultiAssets(c: BinanceCreds): Promise<boolean> {
	const r = (await fget("/fapi/v1/multiAssetsMargin", {}, c, "멀티에셋 모드 조회")) as { multiAssetsMargin?: boolean };
	return r.multiAssetsMargin === true;
}

export interface Bracket {
	initialLeverage: number;
	notionalFloor: number;
	notionalCap: number;
	maintMarginRatio: number;
	/** 유지증거금 공제액 — 청산가 계산에 쓴다 */
	cum: number;
}

/** 포지션 크기 구간별 최대 레버리지·유지증거금률 */
export async function leverageBrackets(c: BinanceCreds, symbol: string): Promise<Bracket[]> {
	const r = (await fget("/fapi/v1/leverageBracket", { symbol }, c, "레버리지 구간 조회")) as unknown;
	const row = (Array.isArray(r) ? (r as Array<Record<string, unknown>>).find((x) => x.symbol === symbol) : r) as { brackets?: Array<Record<string, unknown>> } | undefined;
	return (row?.brackets ?? []).map((b) => ({
		initialLeverage: Number(b.initialLeverage) || 0,
		notionalFloor: Number(b.notionalFloor) || 0,
		notionalCap: Number(b.notionalCap) || 0,
		maintMarginRatio: Number(b.maintMarginRatio) || 0,
		cum: Number(b.cum) || 0,
	}));
}

/** 포지션 크기가 속하는 구간 (순수) — 없으면 null */
export function bracketFor(brackets: readonly Bracket[], notional: number): Bracket | null {
	if (brackets.length === 0) return null;
	return brackets.find((b) => notional >= b.notionalFloor && notional < b.notionalCap) ?? brackets[brackets.length - 1]!;
}

/** 이 레버리지로 가질 수 있는 최대 포지션 크기 (순수) — 그 레버리지를 허용하는 구간들의 상한 중 가장 큰 것 */
export function maxNotionalAt(brackets: readonly Bracket[], leverage: number): number {
	return brackets.filter((b) => b.initialLeverage >= leverage).reduce((m, b) => Math.max(m, b.notionalCap), 0);
}

/**
 * 격리 · 새 포지션 하나의 예상 청산가 (순수, 표시용). 증거금 = 크기 ÷ 레버리지 일 때
 *   롱 (EP(1 − 1/L) − cum/Q) / (1 − MMR) · 숏 (EP(1 + 1/L) + cum/Q) / (1 + MMR)
 * 교차는 지갑 전체가 증거금이라 이 값이 아니다 (호출부가 넣지 않는다).
 */
export function isolatedLiqPrice(long: boolean, entry: number, qty: number, leverage: number, b: Pick<Bracket, "maintMarginRatio" | "cum">): number | null {
	if (!(entry > 0 && qty > 0 && leverage > 0)) return null;
	const v = long
		? (entry * (1 - 1 / leverage) - b.cum / qty) / (1 - b.maintMarginRatio)
		: (entry * (1 + 1 / leverage) + b.cum / qty) / (1 + b.maintMarginRatio);
	return v > 0 ? v : null;
}

export type FuturesOpenOrder = FuturesOriginal & { symbol: string; positionSide: string; reduceOnly: boolean };

/** 일반 미체결 + 조건부(Algo) 미체결 — 익절·손절은 Algo 쪽에 있다 */
export async function futuresOpenOrders(c: BinanceCreds, symbol?: string): Promise<FuturesOpenOrder[]> {
	const q: Record<string, string> = symbol ? { symbol } : {};
	const [orders, algo] = await Promise.all([
		fget("/fapi/v1/openOrders", q, c, "선물 미체결 조회") as Promise<Array<Record<string, unknown>>>,
		fget("/fapi/v1/openAlgoOrders", q, c, "선물 조건부 미체결 조회") as Promise<Array<Record<string, unknown>> | { orders?: Array<Record<string, unknown>> }>,
	]);
	const algoRows = Array.isArray(algo) ? algo : (algo?.orders ?? []);
	return [
		...(Array.isArray(orders) ? orders : []).map((o) => ({
			source: "order" as const,
			id: Number(o.orderId),
			symbol: str(o.symbol, ""),
			side: str(o.side, "BUY") as OrderSide,
			type: str(o.type, ""),
			price: str(o.price),
			...(Number(o.stopPrice) > 0 ? { triggerPrice: str(o.stopPrice) } : {}),
			quantity: str(o.origQty),
			closePosition: o.closePosition === true,
			positionSide: str(o.positionSide, "BOTH"),
			reduceOnly: o.reduceOnly === true,
		})),
		...algoRows.map((o) => ({
			source: "algo" as const,
			id: Number(o.algoId),
			symbol: str(o.symbol, ""),
			side: str(o.side, "BUY") as OrderSide,
			type: str(o.orderType, ""),
			price: str(o.price),
			...(Number(o.triggerPrice) > 0 ? { triggerPrice: str(o.triggerPrice) } : {}),
			quantity: str(o.quantity),
			closePosition: o.closePosition === true,
			positionSide: str(o.positionSide, "BOTH"),
			reduceOnly: o.reduceOnly === true,
		})),
	];
}

// ── 요청 파라미터 (순수) ────────────────────────────────────

/** 롱을 닫는 쪽은 SELL, 숏은 BUY */
export const closingSide = (side: OrderSide): OrderSide => (side === "BUY" ? "SELL" : "BUY");

export function openOrderParams(a: BinanceFuturesOpenAction, nonce: string): Record<string, string> {
	const p: Record<string, string> = {
		symbol: a.symbol,
		side: a.side,
		positionSide: a.positionSide,
		type: a.type,
		quantity: a.quantity,
		newClientOrderId: nonce,
		newOrderRespType: "RESULT",
	};
	if (a.type === "LIMIT") {
		if (!a.price) throw new BinanceError("지정가 주문에는 가격이 필요합니다");
		p.price = a.price;
		p.timeInForce = "GTC";
	}
	return p;
}

/** 청산 — 단방향은 reduceOnly 로 포지션을 넘겨 반대로 뒤집히지 않게. 양방향은 positionSide 가 그 역할 (reduceOnly 를 보내면 거절) */
export function closeOrderParams(a: BinanceFuturesCloseAction, nonce: string): Record<string, string> {
	const p: Record<string, string> = {
		symbol: a.symbol,
		side: a.side,
		positionSide: a.positionSide,
		type: a.type,
		quantity: a.quantity,
		newClientOrderId: nonce,
		newOrderRespType: "RESULT",
	};
	if (a.positionSide === "BOTH") p.reduceOnly = "true";
	if (a.type === "LIMIT") {
		if (!a.price) throw new BinanceError("지정가 주문에는 가격이 필요합니다");
		p.price = a.price;
		p.timeInForce = "GTC";
	}
	return p;
}

/**
 * 익절·손절 — 트리거되면 그 방향 포지션 **전체**를 시장가로 닫는다 (closePosition).
 * 기준은 표시가격(MARK_PRICE — 순간 체결가 튐에 덜 걸린다), priceProtect 로 표시가격·체결가 괴리가 크면 트리거하지 않는다.
 */
export function tpslParams(
	t: { symbol: string; side: OrderSide; positionSide: FuturesPositionSide },
	leg: "tp" | "sl",
	triggerPrice: string,
	nonce: string,
): Record<string, string> {
	return {
		algoType: "CONDITIONAL",
		symbol: t.symbol,
		side: t.side,
		positionSide: t.positionSide,
		type: leg === "tp" ? "TAKE_PROFIT_MARKET" : "STOP_MARKET",
		triggerPrice,
		closePosition: "true",
		workingType: "MARK_PRICE",
		priceProtect: "true",
		clientAlgoId: `${nonce}${leg}`,
	};
}

export function cancelRequest(a: BinanceFuturesCancelAction): { path: string; params: Record<string, string> } {
	return a.original.source === "algo"
		? { path: "/fapi/v1/algoOrder", params: { algoId: String(a.original.id) } }
		: { path: "/fapi/v1/order", params: { symbol: a.symbol, orderId: String(a.original.id) } };
}

/**
 * 바꿀 설정만 — 증거금 방식 먼저 (격리 ↔ 교차), 그다음 레버리지.
 * alwaysLeverage: 진입 직전에는 같아도 레버리지를 보낸다 — 준비 뒤 앱에서 바꿨으면 다른 레버리지로 진입하게 된다 (같은 값은 Binance 가 그대로 받는다)
 */
export function settingsRequests(
	a: Pick<BinanceFuturesSettingsAction, "symbol" | "leverage" | "marginType" | "current">,
	alwaysLeverage = false,
): Array<{ path: string; params: Record<string, string>; label: string }> {
	const out: Array<{ path: string; params: Record<string, string>; label: string }> = [];
	if (a.marginType && a.marginType !== a.current.marginType) {
		out.push({ path: "/fapi/v1/marginType", params: { symbol: a.symbol, marginType: a.marginType }, label: a.marginType === "ISOLATED" ? "격리" : "교차" });
	}
	if (a.leverage && (alwaysLeverage || a.leverage !== a.current.leverage)) {
		out.push({ path: "/fapi/v1/leverage", params: { symbol: a.symbol, leverage: String(a.leverage) }, label: `레버리지 ${a.leverage}x` });
	}
	return out;
}

// ── 실행 — **실제 돈을 움직인다** ───────────────────────────

/** -4046 "No need to change margin type" — 이미 그 방식이다 */
const NO_CHANGE = new Set([-4046]);

async function applySettings(
	a: Pick<BinanceFuturesSettingsAction, "symbol" | "leverage" | "marginType" | "current">,
	c: BinanceCreds,
	alwaysLeverage = false,
): Promise<string[]> {
	const done: string[] = [];
	for (const r of settingsRequests(a, alwaysLeverage)) {
		try {
			await signed("POST", r.path, r.params, c, `${r.label} 설정`, futuresHost(c));
			done.push(r.label);
		} catch (err) {
			if (err instanceof BinanceError && err.code !== undefined && NO_CHANGE.has(err.code)) continue;
			throw err;
		}
	}
	return done;
}

const fmtResult = (r: { status?: string; avgPrice?: string; executedQty?: string }): string =>
	r.status ? ` (${r.status}${Number(r.executedQty) > 0 ? ` · 체결 ${r.executedQty} @ ${r.avgPrice}` : ""})` : "";

/** 익절·손절을 건다 — 하나가 실패해도 나머지는 건다. 결과 문장 목록 */
async function placeTpsl(
	t: { symbol: string; side: OrderSide; positionSide: FuturesPositionSide; takeProfitPrice?: string; stopLossPrice?: string },
	nonce: string,
	c: BinanceCreds,
): Promise<{ notes: string[]; failed: number }> {
	const notes: string[] = [];
	let failed = 0;
	for (const [leg, price, name] of [["sl", t.stopLossPrice, "손절"], ["tp", t.takeProfitPrice, "익절"]] as const) {
		if (!price) continue;
		try {
			await signed("POST", "/fapi/v1/algoOrder", tpslParams(t, leg, price, nonce), c, `${name} 등록`, futuresHost(c));
			notes.push(`${name} ${price} 등록`);
		} catch (err) {
			failed += 1;
			notes.push(`⚠️ ${name} 등록 실패: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { notes, failed };
}

export async function executeFutures(a: BinanceFuturesAction, nonce: string, c: BinanceCreds): Promise<{ message: string; orderId?: string }> {
	const host = futuresHost(c);
	switch (a.kind) {
		case "binance-futures-settings": {
			const done = await applySettings(a, c);
			return { message: done.length ? `${a.symbol} ${done.join(" · ")} 로 바꿨습니다` : `${a.symbol} 설정이 이미 같습니다` };
		}
		case "binance-futures-open": {
			// 설정이 실패하면 주문하지 않는다 — 다른 레버리지로 진입하면 안 된다
			const done = (await applySettings(a, c, true)).filter((x) => a.leverage !== a.current.leverage || !x.startsWith("레버리지"));
			const r = (await signed("POST", "/fapi/v1/order", openOrderParams(a, nonce), c, "선물 진입", host)) as { orderId?: number; status?: string; avgPrice?: string; executedQty?: string };
			const tpsl = await placeTpsl({ ...a, side: closingSide(a.side) }, nonce, c);
			const parts = [`진입 주문이 접수되었습니다${fmtResult(r)}`, ...(done.length ? [`설정 ${done.join(" · ")}`] : []), ...tpsl.notes];
			if (tpsl.failed > 0) parts.push("포지션이 보호되지 않을 수 있습니다 — 익절·손절을 다시 걸어 주세요");
			return { message: parts.join(" · "), ...(r.orderId !== undefined ? { orderId: String(r.orderId) } : {}) };
		}
		case "binance-futures-close": {
			const r = (await signed("POST", "/fapi/v1/order", closeOrderParams(a, nonce), c, "선물 청산", host)) as { orderId?: number; status?: string; avgPrice?: string; executedQty?: string };
			return { message: `청산 주문이 접수되었습니다${fmtResult(r)}`, ...(r.orderId !== undefined ? { orderId: String(r.orderId) } : {}) };
		}
		case "binance-futures-tpsl": {
			const tpsl = await placeTpsl(a, nonce, c);
			if (tpsl.failed > 0 && tpsl.failed === tpsl.notes.length) throw new BinanceError(tpsl.notes.join(" · ").replace(/⚠️ /g, ""));
			return { message: tpsl.notes.join(" · ") };
		}
		case "binance-futures-cancel": {
			const { path, params } = cancelRequest(a);
			await signed("DELETE", path, params, c, "선물 취소", host);
			return { message: "취소되었습니다", orderId: `${a.original.source === "algo" ? "algo " : ""}${a.original.id}` };
		}
		case "binance-futures-cancel-all": {
			// 둘 중 하나가 실패해도 다른 쪽은 이미 취소됐을 수 있다 — 실패를 숨기지 않고 알린다
			const notes: string[] = [];
			if (a.orders > 0) await signed("DELETE", "/fapi/v1/allOpenOrders", { symbol: a.symbol }, c, "선물 전체 취소", host).then(() => notes.push(`일반 ${a.orders}건 취소`));
			if (a.algo > 0) {
				try {
					await signed("DELETE", "/fapi/v1/algoOpenOrders", { symbol: a.symbol }, c, "선물 조건부 전체 취소", host);
					notes.push(`익절·손절 등 조건부 ${a.algo}건 취소`);
				} catch (err) {
					if (notes.length === 0) throw err;
					notes.push(`⚠️ 조건부 취소 실패: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			return { message: notes.join(" · ") || "취소할 주문이 없습니다" };
		}
	}
}
