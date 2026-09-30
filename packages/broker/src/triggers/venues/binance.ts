/**
 * Binance 현물 체결 어댑터 (PLAN §40 4단계) — 코인 자동 매매. 24시간.
 *
 *   호가      GET /api/v3/depth (공개, 20호가 — bids 높은 가격부터, asks 낮은 가격부터)
 *   지정가    POST /api/v3/order LIMIT · timeInForce IOC(즉시) 또는 GTC(걸어 두기) · newClientOrderId = 체결기 clientId
 *   취소      DELETE /api/v3/order (orderId)
 *   상태      GET /api/v3/order — executedQty · cummulativeQuoteQty 로 체결량·평균가
 *
 * 가격·수량은 종목 규칙(exchangeInfo)의 tickSize·stepSize 에 **10진 계산으로** 맞춘다 (부동소수점 내림 금지 — decimal.ts).
 *
 * 멱등성: Binance 의 newClientOrderId 는 **열린 주문 안에서만** 유일하다 — 이미 체결·만료된 IOC 와 같은 값으로 다시 보내면
 * 새 주문이 된다. 그래서 idempotent=false (체결기가 다시 보내지 않는다). 대신 응답을 못 받았으면
 * origClientOrderId 로 한 번 찾아보고, 접수돼 있으면 그 주문을 이어서 따라간다 (없으면 결과 모름).
 *
 * 오류 구분 (Binance 문서): 4xx = 거래소가 판단해 거절(접수 안 됨), 5xx·-1006·-1007 = 실행 여부 모름.
 *
 * ⚠️ place/cancel 은 **실제 돈을 움직인다.** 켜진 트리거의 신호(주문 실행기)에서만 부른다.
 * 쓰기 경로는 POST /api/v3/order · DELETE /api/v3/order 둘뿐이다 (출금·이체 없음).
 */
import { floorToStep, subDec } from "../../binance/decimal.ts";
import { signedRequest, symbolRules, type BinanceCreds, type SymbolRules } from "../../binance/trade.ts";
import { PROVIDERS } from "../../data/gateway.ts";
import { VenueRejected, VenueUnknown, type Book, type BookLevel, type ExecVenue, type Grid, type VenueOrderState } from "./types.ts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface BinanceVenueOptions {
	now?: () => number;
	fetch?: FetchLike;
	sleep?: (ms: number) => Promise<void>;
	/** 테스트 — 종목 규칙 (없으면 exchangeInfo 조회) */
	rules?: SymbolRules;
}

/**
 * 10진 문자열 — 유효숫자 15자리로 부동소수점 잡음(0.19999999999999998 · 84000 × 1.1 = 92400.00000000001)을 걷어 내고,
 * 지수 표기(1.23e-7 — 가격이 아주 작은 코인) 없이.
 */
export function plainDecimal(v: number): string {
	if (v === 0 || !Number.isFinite(v)) return "0";
	const digits = Math.min(100, Math.max(0, 14 - Math.floor(Math.log10(Math.abs(v)))));
	const s = v.toFixed(digits);
	return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
const plain = plainDecimal;

/** 종목 규칙 → 격자. 가격·수량을 거래소 단위에 **10진 계산으로** 맞춘다 */
export function cryptoGrid(r: SymbolRules): Grid {
	const tick = r.tickSize;
	const step = r.stepSize;
	const up = (p: number): number => {
		const down = floorToStep(plain(p), tick);
		return Number(down) >= Number(plain(p)) ? Number(down) : Number(subDec(down, `-${tick}`));
	};
	return {
		roundPrice: (p, dir) => (p > 0 ? (dir === "down" ? Number(floorToStep(plain(p), tick)) : up(p)) : 0),
		stepPrice: (p, dir) => {
			const base = dir === 1 ? floorToStep(plain(p), tick) : plain(up(p));
			return Number(dir === 1 ? subDec(base, `-${tick}`) : subDec(base, tick));
		},
		floorQty: (q) => (q > 0 ? Number(floorToStep(plain(q), step)) : 0),
		minQty: Number(r.minQty) || Number(step) || 0,
		minNotional: Number(r.minNotional) || 0,
		unit: r.base,
	};
}

/** 거래소에 보낼 문자열 — 단위에 맞춘 10진 (지수 표기 없이) */
export const binancePriceText = (r: SymbolRules, price: number): string => floorToStep(plain(price), r.tickSize);
export const binanceQtyText = (r: SymbolRules, qty: number): string => floorToStep(plain(qty), r.stepSize);

const levels = (xs: unknown): BookLevel[] =>
	(Array.isArray(xs) ? (xs as unknown[][]) : [])
		.map((l) => ({ price: Number(l[0]), volume: Number(l[1]) }))
		.filter((l) => l.price > 0 && l.volume > 0);

export function binanceBook(raw: { bids?: unknown; asks?: unknown }, at: number): Book {
	return {
		bids: levels(raw.bids).sort((a, b) => b.price - a.price),
		asks: levels(raw.asks).sort((a, b) => a.price - b.price),
		at,
	};
}

/** 살아 있는(더 체결될 수 있는) 상태 — PENDING_CANCEL 은 문서상 안 쓰이지만 닫혔다고 보지 않는다 */
const OPEN = new Set(["NEW", "PARTIALLY_FILLED", "PENDING_NEW", "PENDING_CANCEL"]);

export function binanceOrderState(o: { status?: string; executedQty?: string; cummulativeQuoteQty?: string }): VenueOrderState {
	const filledQty = Number(o.executedQty ?? 0) || 0;
	const quote = Number(o.cummulativeQuoteQty ?? 0) || 0;
	const status = String(o.status ?? "");
	return {
		filledQty,
		// 84.1 ÷ 0.001 = 84099.99999999999 같은 잡음을 걷어 낸다 (유효숫자 12자리)
		avgPrice: filledQty > 0 && quote > 0 ? Number((quote / filledQty).toPrecision(12)) : null,
		open: OPEN.has(status),
		...(status === "REJECTED" ? { rejected: "거래소가 주문을 거부했습니다" } : {}),
	};
}

/** 실행 여부를 모르는 오류 코드 — -1006 예상 밖 응답, -1007 백엔드 응답 시간 초과 */
const UNKNOWN_CODES = new Set([-1006, -1007]);

/** 응답 → 거절 / 모름. status 0 = 응답을 못 받음 */
export function classifyBinance(status: number, body: { code?: number; msg?: string } | null, text: string): Error {
	const msg = body?.msg ?? text.slice(0, 160);
	const label = `Binance (HTTP ${status || "—"}${body?.code !== undefined ? ` ${body.code}` : ""}): ${msg}`;
	if (status === 0 || status >= 500 || (body?.code !== undefined && UNKNOWN_CODES.has(body.code))) return new VenueUnknown(label);
	if (status >= 400) return new VenueRejected(label);
	return new VenueUnknown(label);
}

export async function binanceVenue(creds: BinanceCreds, symbol: string, opts: BinanceVenueOptions = {}): Promise<ExecVenue> {
	const f: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const rules = opts.rules ?? (await symbolRules(symbol, creds));
	if (!rules) throw new Error(`Binance 에 없는 종목입니다: ${symbol}`);
	if (rules.status !== "TRADING") throw new Error(`${symbol} 은(는) 지금 거래할 수 없습니다 (${rules.status})`);
	if (!rules.spot) throw new Error(`${symbol} 은(는) 현물 거래가 막혀 있습니다`);
	if (rules.orderTypes.length > 0 && !rules.orderTypes.includes("LIMIT")) throw new Error(`${symbol} 은(는) 지정가 주문을 받지 않습니다`);
	const base = PROVIDERS.binance.base({ binance: creds });
	const grid = cryptoGrid(rules);
	const scrub = (t: string): string => {
		let out = t;
		for (const s of [creds.key, creds.secret]) if (s && s.length >= 6) out = out.split(s).join("****");
		return out;
	};

	/** 한 번 보낸다 — 응답이 없거나 읽지 못하면 status 0 */
	const call = async (method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string>, signed: boolean): Promise<unknown> => {
		let url: string;
		let init: RequestInit;
		if (signed) {
			({ url, init } = signedRequest(method, path, params, creds, now()));
		} else {
			url = `${base}${path}?${new URLSearchParams(params).toString()}`;
			init = { method, signal: AbortSignal.timeout(10_000) };
		}
		let res: Response;
		try {
			res = await f(url, init);
		} catch (err) {
			throw classifyBinance(0, null, scrub(err instanceof Error ? err.message : String(err)));
		}
		const text = await res.text().catch(() => "");
		let body: unknown = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			throw classifyBinance(res.ok ? 0 : res.status, null, scrub(text));
		}
		const o = body as { code?: number; msg?: string } | null;
		if (!res.ok || (o && typeof o.code === "number" && o.code < 0)) {
			throw classifyBinance(res.status, o ? { ...o, ...(o.msg ? { msg: scrub(o.msg) } : {}) } : null, scrub(text));
		}
		return body;
	};

	const lookupByClient = async (clientId: string): Promise<{ orderId: string } | null> => {
		try {
			const r = (await call("GET", "/api/v3/order", { symbol, origClientOrderId: clientId }, true)) as { orderId?: number };
			return r?.orderId !== undefined ? { orderId: String(r.orderId) } : null;
		} catch {
			return null;
		}
	};

	return {
		label: creds.testnet ? "Binance 현물 (테스트넷)" : "Binance 현물",
		market: "CRYPTO",
		symbol,
		grid,
		supportsIoc: true,
		idempotent: false,
		async book() {
			const r = (await call("GET", "/api/v3/depth", { symbol, limit: "20" }, false)) as { bids?: unknown; asks?: unknown };
			return binanceBook(r ?? {}, now());
		},
		async place(o) {
			const quantity = binanceQtyText(rules, o.quantity);
			const price = binancePriceText(rules, o.price);
			if (!(Number(quantity) > 0)) throw new VenueRejected(`수량이 수량 단위(${rules.stepSize})보다 작습니다: ${o.quantity}`);
			const params = {
				symbol,
				side: o.side,
				type: "LIMIT",
				timeInForce: o.ioc ? "IOC" : "GTC",
				quantity,
				price,
				newClientOrderId: o.clientId,
				newOrderRespType: "RESULT",
			};
			try {
				const r = (await call("POST", "/api/v3/order", params, true)) as { orderId?: number };
				if (r?.orderId === undefined) throw new VenueUnknown("주문 응답에 orderId 가 없습니다");
				return { orderId: String(r.orderId) };
			} catch (err) {
				if (!(err instanceof VenueUnknown)) throw err;
				// 접수됐는지 한 번 찾아본다 — 있으면 그 주문을 따라간다 (다시 보내지 않는다)
				await sleep(1_000);
				const found = await lookupByClient(o.clientId);
				if (found) return found;
				throw err;
			}
		},
		async cancel(orderId) {
			await call("DELETE", "/api/v3/order", { symbol, orderId }, true);
		},
		async status(orderId) {
			const r = (await call("GET", "/api/v3/order", { symbol, orderId }, true)) as Record<string, string>;
			return binanceOrderState(r ?? {});
		},
	};
}

/** 매도 가능 수량 — 기준 자산의 free 잔고를 수량 단위로 내림 */
export function binanceSellable(free: Record<string, string>, rules: SymbolRules): number {
	const v = free[rules.base];
	if (!v) return 0;
	return Number(floorToStep(v, rules.stepSize));
}
