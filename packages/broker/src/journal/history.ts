/**
 * 증권사 체결 내역 → BrokerFill (매매일지 가져오기, PLAN §42).
 *
 *   토스          GET /api/v1/orders status=CLOSED (from·to·cursor, 100건씩) — 수수료·세금까지 온다
 *   한국투자 국장  TTTC0081R 주식일별주문체결조회 (3개월 이내, 100건씩 5쪽) — 수수료는 없다
 *   한국투자 미장  TTTS3035R 해외주식 주문체결내역 (20건씩 5쪽이라 10일씩 나눠 부른다)
 *   Binance 현물  GET /api/v3/allOrders — **마켓을 지정해야 한다.** 전 종목 조회가 없어 호출부가 마켓 목록을 준다
 *                 (일지에 있는 마켓 + 지금 현물 지갑의 코인). 다 팔고 일지에도 없는 코인은 못 찾는다.
 *   Binance 주식  GET /sapi/v1/equity/order/history (전 종목)
 *
 * 조회만 한다. 파서는 순수 함수로 따로 둔다 (테스트).
 */
import type { BrokerAccess } from "../portfolio.ts";
import { signed } from "../binance/trade.ts";
import type { BinanceCreds } from "../binance/trade.ts";
import { EQUITY_OPEN, equityOrderHistory, type EquityOrder } from "../binance/stocks.ts";
import { accountParams, type KisContext, type KisResponse } from "../kis/client.ts";
import { callKisApi } from "../kis/gateway.ts";
import { defaultAccountSeq } from "../toss/api.ts";
import { listOrders, type TossOrder } from "../toss/orders.ts";
import type { TossContext } from "../toss/client.ts";
import { localDate } from "../triggers/market-time.ts";
import { binanceRef, binanceStockRef, kisRef, tossRef } from "./refs.ts";
import type { BrokerFill } from "./types.ts";

type Row = Record<string, unknown>;

const num = (v: unknown): number => {
	const x = Number(String(v ?? "").trim());
	return Number.isFinite(x) ? x : 0;
};
const str = (v: unknown): string => String(v ?? "").trim();
const rowsOf = (res: KisResponse, key: string): Row[] => {
	const v = res[key];
	return Array.isArray(v) ? (v as Row[]) : v && typeof v === "object" ? [v as Row] : [];
};
/** "20261008" + "093015" → epoch ms (offset = "+09:00" 등). 시각이 없으면 정오 */
function stamp(ymd: string, hms: string, offset: string): number {
	if (!/^\d{8}$/.test(ymd)) return Number.NaN;
	const t = /^\d{6}$/.test(hms) ? `${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}` : "12:00:00";
	return Date.parse(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${t}${offset}`);
}

// ── 토스 ────────────────────────────────────────────────────

/** 토스 시각은 KST — 오프셋이 빠진 값이 와도 서버 시간대(UTC 컨테이너)로 읽지 않게 */
export function kstParse(s: string | null | undefined): number {
	if (!s) return Number.NaN;
	return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}+09:00`);
}

/** 종료 주문 한 건 → 체결. 취소·거부(체결 0)도 돌려준다 — 앱에서 낸 주문의 "취소됨" 을 알아야 한다 */
export function tossFill(o: TossOrder): BrokerFill | null {
	if (!o.orderId || !o.symbol) return null;
	const ex = o.execution ?? ({} as Partial<TossOrder["execution"]>);
	const filled = num(ex.filledQuantity);
	const avg = num(ex.averageFilledPrice);
	const fee = ex.commission === null && ex.tax === null ? null : Number((num(ex.commission) + num(ex.tax)).toPrecision(12));
	const at = kstParse(ex.filledAt || o.orderedAt);
	return {
		ref: tossRef(o.orderId),
		parentRef: null,
		broker: "toss",
		symbol: o.symbol.toUpperCase(),
		name: null,
		side: o.side === "SELL" ? "SELL" : "BUY",
		ordered: num(o.quantity),
		filled,
		price: filled > 0 && avg > 0 ? avg : null,
		currency: o.currency === "KRW" ? "KRW" : "USD",
		fee: filled > 0 ? fee : null,
		at: Number.isFinite(at) ? at : 0,
		// OPEN 목록이 아니라 종료 목록에서 온 것만 다룬다
		open: false,
	};
}

/** 100건씩 최대 10쪽 (1,000건) */
const TOSS_PAGES = 10;

export async function tossFills(ctx: TossContext, from: string, to: string): Promise<{ fills: BrokerFill[]; warnings: string[] }> {
	const seq = await defaultAccountSeq(ctx);
	const fills: BrokerFill[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < TOSS_PAGES; page++) {
		const r = await listOrders(ctx, seq, { status: "CLOSED", limit: 100, from, to, ...(cursor ? { cursor } : {}) });
		for (const o of r.orders ?? []) {
			const f = tossFill(o);
			if (f) fills.push(f);
		}
		cursor = r.nextCursor ?? undefined;
		if (!cursor || (r.orders ?? []).length === 0) return { fills, warnings: [] };
	}
	return { fills, warnings: [`토스 주문이 ${fills.length}건을 넘어 앞쪽 일부만 가져왔습니다 — 기간을 줄여 다시 가져오세요`] };
}

// ── 한국투자 ────────────────────────────────────────────────

const SIDE_OF = (code: unknown): "BUY" | "SELL" => (str(code) === "01" ? "SELL" : "BUY");

/** 국장 일별 주문체결 한 줄 → 체결. 정정·취소 주문은 원주문번호(orgn_odno)로 원주문에 잇는다 */
export function kisDomesticFill(r: Row): BrokerFill | null {
	const day = str(r.ord_dt);
	const no = str(r.odno);
	const symbol = str(r.pdno);
	if (!/^\d{8}$/.test(day) || !no || !symbol) return null;
	const ordered = num(r.ord_qty);
	const filled = num(r.tot_ccld_qty);
	const rest = r.rmn_qty !== undefined ? num(r.rmn_qty) : Math.max(0, ordered - filled - num(r.cncl_cfrm_qty) - num(r.rjct_qty));
	const avg = num(r.avg_prvs);
	const orgn = str(r.orgn_odno).replace(/^0+/, "");
	return {
		ref: kisRef(day, no),
		parentRef: orgn ? kisRef(day, orgn) : null,
		broker: "kis",
		symbol,
		name: str(r.prdt_name) || null,
		side: SIDE_OF(r.sll_buy_dvsn_cd),
		ordered,
		filled,
		price: filled > 0 && avg > 0 ? avg : null,
		currency: "KRW",
		fee: null,
		at: stamp(day, str(r.ord_tmd), "+09:00"),
		open: rest > 0,
	};
}

/**
 * 미장 주문체결 한 줄 → 체결. ord_dt 는 현지(뉴욕) 날짜 — ref 도 그 날짜로 (자동 매매 체결기와 같다).
 * 시각은 국내 주문일·당사 주문시각(KST)이 있으면 그것, 없으면 현지 날짜 정오.
 */
export function kisOverseasFill(r: Row): BrokerFill | null {
	const day = str(r.ord_dt);
	const no = str(r.odno);
	const symbol = str(r.pdno).toUpperCase();
	if (!/^\d{8}$/.test(day) || !no || !symbol) return null;
	// 취소 주문 줄 (rvse_cncl_dvsn 02) 은 체결이 없다 — 원주문 줄이 결과를 가진다
	if (str(r.rvse_cncl_dvsn) === "02") return null;
	const filled = num(r.ft_ccld_qty);
	const avg = num(r.ft_ccld_unpr3);
	const rejected = str(r.prcs_stat_name) === "거부";
	const kstDay = str(r.dmst_ord_dt);
	const kstTime = str(r.thco_ord_tmd);
	const at = /^\d{8}$/.test(kstDay) && /^\d{6}$/.test(kstTime) ? stamp(kstDay, kstTime, "+09:00") : stamp(day, "", "-05:00");
	const orgn = str(r.orgn_odno).replace(/^0+/, "");
	return {
		ref: kisRef(day, no),
		parentRef: orgn ? kisRef(day, orgn) : null,
		broker: "kis",
		symbol,
		name: str(r.prdt_name) || null,
		side: SIDE_OF(r.sll_buy_dvsn_cd),
		ordered: num(r.ft_ord_qty),
		filled,
		price: filled > 0 && avg > 0 ? avg : null,
		currency: str(r.tr_crcy_cd) || "USD",
		fee: null,
		at,
		open: !rejected && num(r.nccs_qty) > 0,
	};
}

const ymdOf = (t: number, tz: string): string => localDate(t, tz).ymd.replaceAll("-", "");

export async function kisDomesticFills(ctx: KisContext, from: number, to: number): Promise<{ fills: BrokerFill[]; warnings: string[] }> {
	accountParams(ctx.creds); // 계좌번호가 없으면 여기서 멈춘다
	const r = await callKisApi(
		ctx,
		"TTTC0081R",
		{
			INQR_STRT_DT: ymdOf(from, "Asia/Seoul"),
			INQR_END_DT: ymdOf(to, "Asia/Seoul"),
			SLL_BUY_DVSN_CD: "00",
			PDNO: "",
			ORD_GNO_BRNO: "",
			ODNO: "",
			CCLD_DVSN: "00",
			INQR_DVSN: "00",
			INQR_DVSN_1: "",
			INQR_DVSN_3: "00",
			EXCG_ID_DVSN_CD: "ALL",
		},
		{ trId: "TTTC0081R", pages: 5 },
	);
	const fills = r.pages.flatMap((p) => rowsOf(p, "output1")).map(kisDomesticFill).filter((f): f is BrokerFill => f !== null);
	return { fills, warnings: r.truncated ? ["한국투자 국장 주문이 500건을 넘어 최근 것만 가져왔습니다 — 기간을 줄여 다시 가져오세요"] : [] };
}

/** 미장은 한 번에 20건씩이라 기간을 나눈다 */
const OVERSEAS_CHUNK_DAYS = 10;

export async function kisOverseasFills(ctx: KisContext, from: number, to: number): Promise<{ fills: BrokerFill[]; warnings: string[] }> {
	accountParams(ctx.creds);
	const fills: BrokerFill[] = [];
	let truncated = false;
	for (let end = to; end > from; end -= OVERSEAS_CHUNK_DAYS * 86_400_000) {
		const start = Math.max(from, end - OVERSEAS_CHUNK_DAYS * 86_400_000 + 86_400_000);
		const r = await callKisApi(
			ctx,
			"TTTS3035R",
			{
				PDNO: "%",
				ORD_STRT_DT: ymdOf(start, "America/New_York"),
				ORD_END_DT: ymdOf(end, "America/New_York"),
				SLL_BUY_DVSN: "00",
				CCLD_NCCS_DVSN: "00",
				OVRS_EXCG_CD: "NASD",
				SORT_SQN: "DS",
				ORD_DT: "",
				ORD_GNO_BRNO: "",
				ODNO: "",
			},
			{ pages: 5 },
		);
		truncated ||= r.truncated;
		for (const p of r.pages) for (const row of rowsOf(p, "output")) {
			const f = kisOverseasFill(row);
			if (f) fills.push(f);
		}
	}
	const unique = [...new Map(fills.map((f) => [f.ref, f])).values()];
	return { fills: unique, warnings: truncated ? ["한국투자 미장 주문이 많아 일부 기간은 앞쪽만 가져왔습니다"] : [] };
}

// ── Binance ─────────────────────────────────────────────────

const BINANCE_OPEN = new Set(["NEW", "PARTIALLY_FILLED", "PENDING_NEW", "PENDING_CANCEL"]);

/** 현물 주문 한 건 → 체결. 평단 = 누적 체결금액 / 체결 수량 (수수료는 주문 응답에 없다) */
export function binanceFill(o: Row, quote: string): BrokerFill | null {
	const symbol = str(o.symbol).toUpperCase();
	const id = str(o.orderId);
	if (!symbol || !id) return null;
	const filled = num(o.executedQty);
	const cum = num(o.cummulativeQuoteQty);
	const at = num(o.updateTime) || num(o.time);
	return {
		ref: binanceRef(symbol, id),
		parentRef: null,
		broker: "binance",
		symbol,
		name: null,
		side: str(o.side) === "SELL" ? "SELL" : "BUY",
		ordered: num(o.origQty),
		filled,
		price: filled > 0 && cum > 0 ? Number((cum / filled).toPrecision(10)) : null,
		currency: quote,
		fee: null,
		at,
		open: BINANCE_OPEN.has(str(o.status)),
	};
}

export interface BinanceMarket {
	symbol: string;
	quote: string;
}

/** 훑는 마켓 수 — 마켓마다 weight 20 */
export const MAX_BINANCE_MARKETS = 20;
const QUOTES = ["USDT", "USDC", "FDUSD"] as const;
/** 스테이블 — 그 자체를 사고파는 마켓을 훑지 않는다 */
const STABLE = new Set(["USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USD1"]);

/** "BTCUSDT" → { BTCUSDT, USDT } — USDT·USDC·FDUSD 마켓만 (자동 매매·평단 추정과 같은 범위) */
export function binanceMarketOf(symbol: string): BinanceMarket | null {
	const s = symbol.toUpperCase();
	const quote = QUOTES.find((q) => s.endsWith(q) && s.length > q.length);
	return quote ? { symbol: s, quote } : null;
}

/**
 * 훑을 마켓 — 일지에 있는 마켓 + 지금 현물 지갑에 있는 코인의 USDT 마켓 (아래쪽 우선은 일지).
 * 지갑 조회가 실패하면 일지 마켓만.
 */
export async function binanceMarkets(c: BinanceCreds, known: readonly string[]): Promise<BinanceMarket[]> {
	const out = new Map<string, BinanceMarket>();
	for (const s of known) {
		const m = binanceMarketOf(s);
		if (m) out.set(m.symbol, m);
	}
	try {
		const r = (await signed("GET", "/api/v3/account", { omitZeroBalances: "true" }, c, "현물 지갑 조회")) as { balances?: Array<{ asset: string; free: string; locked: string }> };
		for (const b of r.balances ?? []) {
			if (b.asset.startsWith("LD") || STABLE.has(b.asset) || !(num(b.free) + num(b.locked) > 0)) continue;
			const symbol = `${b.asset}USDT`;
			if (!out.has(symbol)) out.set(symbol, { symbol, quote: "USDT" });
		}
	} catch {
		/* 지갑을 못 읽으면 일지에 있는 마켓만 */
	}
	return [...out.values()].slice(0, MAX_BINANCE_MARKETS);
}

/** 마켓마다 최근 주문 500건 (weight 20) — 기간 안의 것만 */
export async function binanceSpotFills(c: BinanceCreds, markets: readonly BinanceMarket[], from: number): Promise<{ fills: BrokerFill[]; warnings: string[] }> {
	const fills: BrokerFill[] = [];
	const failed: string[] = [];
	for (const m of markets) {
		try {
			const rows = (await signed("GET", "/api/v3/allOrders", { symbol: m.symbol, limit: "500" }, c, `${m.symbol} 주문 내역`)) as Row[];
			for (const o of Array.isArray(rows) ? rows : []) {
				const f = binanceFill(o, m.quote);
				if (f && f.at >= from) fills.push(f);
			}
		} catch (err) {
			// 없는 마켓(상장 폐지·오타)은 그 마켓만 건너뛴다
			failed.push(`${m.symbol}(${err instanceof Error ? err.message.slice(0, 60) : "실패"})`);
		}
	}
	return { fills, warnings: failed.length ? [`Binance 일부 마켓을 가져오지 못했습니다: ${failed.join(", ")}`] : [] };
}

/** 미국 주식 주문 한 건 → 체결 */
export function binanceStockFill(o: EquityOrder, now: number): BrokerFill | null {
	if (!o.orderId || !o.symbol) return null;
	const filled = num(o.filledQty);
	const avg = num(o.avgFilledPrice);
	return {
		ref: binanceStockRef(o.orderId),
		parentRef: null,
		broker: "binance_stock",
		symbol: o.symbol.toUpperCase(),
		name: null,
		side: o.side,
		ordered: num(o.qty),
		filled,
		price: filled > 0 && avg > 0 ? avg : null,
		currency: "USD",
		fee: o.fee === null ? null : num(o.fee),
		at: o.createdAt ?? now,
		open: EQUITY_OPEN.has(o.status),
	};
}

export async function binanceStockFills(c: BinanceCreds, from: number, now: number): Promise<{ fills: BrokerFill[]; warnings: string[] }> {
	const orders = await equityOrderHistory(c, null, from, { maxPages: 5 });
	return { fills: orders.map((o) => binanceStockFill(o, now)).filter((f): f is BrokerFill => f !== null), warnings: [] };
}

// ── 계좌 묶음 ───────────────────────────────────────────────

export interface FillSource {
	broker: BrokerFill["broker"];
	label: string;
	run: (from: number, to: number) => Promise<{ fills: BrokerFill[]; warnings: string[] }>;
}

/** 만들 수 있으면 연결된 것 (자격증명이 없으면 접근자가 throw 한다) */
function made<T>(make: (() => T) | undefined): T | null {
	if (!make) return null;
	try {
		return make();
	} catch {
		return null;
	}
}

/**
 * 사용자가 연결한 계좌의 체결 출처. 키가 없는 계좌는 빠진다 (경고 없음).
 * binanceSymbols: 일지에 있는 Binance 현물 마켓 — 지갑의 코인과 합쳤 훑는다 (binanceMarkets).
 */
export function fillSources(access: BrokerAccess, opts: { binanceSymbols: () => Promise<string[]>; now?: () => number }): FillSource[] {
	const now = opts.now ?? Date.now;
	const out: FillSource[] = [];
	const toss = made(access.toss);
	if (toss) {
		const kst = (t: number): string => localDate(t, "Asia/Seoul").ymd;
		out.push({ broker: "toss", label: "토스", run: (from, to) => tossFills(toss, kst(from), kst(to)) });
	}
	const kis = made(access.kis);
	// 계좌번호가 없으면(시세만 쓰는 키) 체결 내역이 없다 · 모의투자는 체결 조회 TR 이 달라 빼 둔다 (주문 TR 도 실전만 — venues/kis.ts)
	if (kis && kis.creds.cano && kis.creds.env !== "paper") {
		out.push({ broker: "kis", label: "한국투자 국장", run: (from, to) => kisDomesticFills(kis, from, to) });
		out.push({ broker: "kis", label: "한국투자 미장", run: (from, to) => kisOverseasFills(kis, from, to) });
	}
	const binance = made(access.binance);
	// 테스트넷은 모의 주문이라 일지에 넣지 않는다
	if (binance && !binance.testnet) {
		out.push({ broker: "binance", label: "Binance 현물", run: async (from) => binanceSpotFills(binance, await binanceMarkets(binance, await opts.binanceSymbols()), from) });
		out.push({ broker: "binance_stock", label: "Binance 미국 주식", run: (from) => binanceStockFills(binance, from, now()) });
	}
	return out;
}
