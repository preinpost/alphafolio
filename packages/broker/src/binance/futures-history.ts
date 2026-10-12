/**
 * Binance USDⓈ-M 선물 — 손익·체결 내역 (조회만).
 *
 *   GET /fapi/v1/income      실현손익·수수료·펀딩비·입출금 등 선물 지갑 흐름 — 전 종목. 7일씩 나눠 1,000건씩 page (weight 30)
 *   GET /fapi/v1/userTrades  체결 — **종목을 지정해야 한다**, 한 번에 7일 이내, 1,000건 넘으면 fromId 로 이어 받는다 (weight 5)
 *   GET /fapi/v1/openOrders  (일지 가져오기) 아직 열린 주문 — 부분 체결 주문을 끝난 매매로 넣지 않게
 * 둘 다 최근 3개월까지만 준다 (Binance 제한).
 *
 * 전 종목 체결 조회가 없어서, 체결을 훑을 종목·구간은 손익 내역에서 고른다:
 * 그 종목의 손익 기록(수수료·실현손익·펀딩비)이 있는 7일 구간 + 실현손익이 있는 구간의 바로 앞 구간 (진입이 앞 구간일 수 있다).
 * 지금 열린 포지션의 종목은 마지막 구간도 훑는다 — 수수료 0 진입(실측 2026-10-12 KORUUSDT 대부분)은 펀딩 전까지 손익 기록이 없다.
 * 그래도 수수료 0 진입을 손익 기록 없는 구간에서 하고 두 구간 뒤에 닫은 경우처럼 흔적이 없는 체결은 놓칠 수 있다.
 */
import type { FuturesPositionSide } from "../actions.ts";
import type { JournalContext, BrokerFill } from "../journal/types.ts";
import { binanceFuturesRef } from "../journal/refs.ts";
import type { OrderSide } from "../orders.ts";
import { futuresHost, futuresPositions } from "./futures.ts";
import { signed, type BinanceCreds } from "./trade.ts";

export const DAY = 86_400_000;
/** Binance 가 한 번에 받는 기간 (userTrades 7일 이내) */
const WINDOW = 7 * DAY;
/** Binance 가 내역을 주는 기간 */
export const MAX_HISTORY_DAYS = 90;
/** 체결을 훑는 종목 수 — 종목·구간마다 한 번씩 부른다 */
export const MAX_HISTORY_SYMBOLS = 20;
const PAGE = 1000;
const INCOME_PAGES = 10;
const TRADE_PAGES = 5;

type Row = Record<string, unknown>;

const num = (v: unknown): number => {
	const x = Number(String(v ?? "").trim());
	return Number.isFinite(x) ? x : 0;
};
const str = (v: unknown): string => String(v ?? "").trim();
/** 소수 합의 덧셈 오차를 지운다 */
const clean = (v: number): number => Number(v.toPrecision(12));

const fget = (path: string, params: Record<string, string>, c: BinanceCreds, label: string): Promise<unknown> =>
	signed("GET", path, params, c, label, futuresHost(c));

// ── 손익 내역 ───────────────────────────────────────────────

export interface FuturesIncome {
	/** 입출금 등 종목이 없는 흐름은 "" */
	symbol: string;
	/** REALIZED_PNL · COMMISSION · FUNDING_FEE · TRANSFER … */
	type: string;
	/** 부호 포함 — 수수료·펀딩비 지급은 음수 */
	amount: number;
	asset: string;
	at: number;
	tranId: string;
	tradeId: string;
}

export function parseIncome(r: Row): FuturesIncome | null {
	const type = str(r.incomeType);
	const at = num(r.time);
	if (!type || !(at > 0)) return null;
	return { symbol: str(r.symbol).toUpperCase(), type, amount: num(r.income), asset: str(r.asset), at, tranId: str(r.tranId), tradeId: str(r.tradeId) };
}

/** [from, to] 를 7일 구간으로 (양끝 포함 — Binance 의 startTime·endTime 처럼) */
export function windows(from: number, to: number): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (let s = from; s <= to; s += WINDOW) out.push([s, Math.min(s + WINDOW - 1, to)]);
	return out;
}

export async function futuresIncome(c: BinanceCreds, from: number, to: number): Promise<{ rows: FuturesIncome[]; truncated: boolean }> {
	const rows: FuturesIncome[] = [];
	let truncated = false;
	for (const [s, e] of windows(from, to)) {
		for (let page = 1; ; page++) {
			const r = await fget("/fapi/v1/income", { startTime: String(s), endTime: String(e), limit: String(PAGE), page: String(page) }, c, "선물 손익 내역");
			const arr = Array.isArray(r) ? (r as Row[]) : [];
			for (const x of arr) {
				const i = parseIncome(x);
				if (i) rows.push(i);
			}
			if (arr.length < PAGE) break;
			if (page >= INCOME_PAGES) {
				truncated = true;
				break;
			}
		}
	}
	// 같은 흐름(종류 + tranId)이 구간 경계·쪽 경계에서 두 번 오지 않게
	const unique = [...new Map(rows.map((i) => [`${i.type}:${i.tranId}:${i.at}:${i.symbol}`, i])).values()];
	return { rows: unique.sort((a, b) => a.at - b.at), truncated };
}

/** 매매에서 생기는 흐름 — 이게 있는 종목·구간을 체결 조회로 훑는다 */
const TRADE_INCOME = new Set(["COMMISSION", "REALIZED_PNL", "FUNDING_FEE", "SPECIAL_FUNDING_FEE", "INSURANCE_CLEAR"]);
/** 선물 지갑 안팎으로 옮긴 것 — 손익이 아니다 */
const MOVE_INCOME = new Set([
	"TRANSFER", "INTERNAL_TRANSFER", "CROSS_COLLATERAL_TRANSFER", "STRATEGY_UMFUTURES_TRANSFER", "COIN_SWAP_DEPOSIT", "COIN_SWAP_WITHDRAW", "AUTO_EXCHANGE",
]);
const FUNDING_INCOME = new Set(["FUNDING_FEE", "SPECIAL_FUNDING_FEE"]);

/** 매매한 종목 — 최근에 움직인 것부터 */
export function tradedSymbols(rows: readonly FuturesIncome[]): string[] {
	const last = new Map<string, number>();
	for (const i of rows) if (i.symbol && TRADE_INCOME.has(i.type)) last.set(i.symbol, Math.max(last.get(i.symbol) ?? 0, i.at));
	return [...last.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

/** 그 종목의 체결을 찾을 7일 구간 — 손익 기록이 있는 구간 + 실현손익이 있는 구간의 앞 구간 */
export function tradeRanges(rows: readonly FuturesIncome[], symbol: string, from: number, to: number): Array<[number, number]> {
	const all = windows(from, to);
	const pick = new Set<number>();
	for (const i of rows) {
		if (i.symbol !== symbol || !TRADE_INCOME.has(i.type) || i.at < from || i.at > to) continue;
		const k = Math.floor((i.at - from) / WINDOW);
		pick.add(k);
		if (i.type === "REALIZED_PNL" && k > 0) pick.add(k - 1);
	}
	return [...pick].sort((a, b) => a - b).map((k) => all[k]!).filter(Boolean);
}

function withLast(ranges: Array<[number, number]>, last: [number, number] | undefined): Array<[number, number]> {
	return last && !ranges.some((r) => r[0] === last[0]) ? [...ranges, last] : ranges;
}

export interface IncomeSummary {
	/** 합계 줄은 "" */
	symbol: string;
	asset: string;
	realized: number;
	/** 낸 수수료 (음수) */
	commission: number;
	funding: number;
	/** 리베이트·보험 청산 등 나머지 손익 */
	other: number;
	/** realized + commission + funding + other */
	net: number;
}

export interface IncomeReport {
	/** 종목 × 자산 — 순손익 절댓값이 큰 순 */
	bySymbol: IncomeSummary[];
	/** 자산별 합계 */
	totals: IncomeSummary[];
	/** 입출금 (손익 아님) — 자산별 합 */
	moves: Array<{ asset: string; amount: number }>;
}

export function summarizeIncome(rows: readonly FuturesIncome[]): IncomeReport {
	const blank = (symbol: string, asset: string): IncomeSummary => ({ symbol, asset, realized: 0, commission: 0, funding: 0, other: 0, net: 0 });
	const by = new Map<string, IncomeSummary>();
	const totals = new Map<string, IncomeSummary>();
	const moves = new Map<string, number>();
	for (const i of rows) {
		if (MOVE_INCOME.has(i.type)) {
			moves.set(i.asset, (moves.get(i.asset) ?? 0) + i.amount);
			continue;
		}
		const field: keyof Pick<IncomeSummary, "realized" | "commission" | "funding" | "other"> =
			i.type === "REALIZED_PNL" ? "realized" : i.type === "COMMISSION" ? "commission" : FUNDING_INCOME.has(i.type) ? "funding" : "other";
		for (const [m, key, symbol] of [[by, `${i.symbol}|${i.asset}`, i.symbol], [totals, i.asset, ""]] as const) {
			const s = m.get(key) ?? blank(symbol, i.asset);
			s[field] += i.amount;
			s.net += i.amount;
			m.set(key, s);
		}
	}
	const tidy = (s: IncomeSummary): IncomeSummary => ({ ...s, realized: clean(s.realized), commission: clean(s.commission), funding: clean(s.funding), other: clean(s.other), net: clean(s.net) });
	return {
		bySymbol: [...by.values()].filter((s) => s.symbol).map(tidy).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)),
		totals: [...totals.values()].map(tidy).sort((a, b) => a.asset.localeCompare(b.asset)),
		moves: [...moves.entries()].map(([asset, amount]) => ({ asset, amount: clean(amount) })).filter((m) => m.amount !== 0),
	};
}

// ── 체결 ────────────────────────────────────────────────────

export interface FuturesTrade {
	id: number;
	orderId: number;
	symbol: string;
	side: OrderSide;
	positionSide: FuturesPositionSide;
	price: number;
	qty: number;
	/** 체결 금액 (호가 자산) */
	quoteQty: number;
	realizedPnl: number;
	/** 낸 수수료 (양수) */
	commission: number;
	commissionAsset: string;
	maker: boolean;
	at: number;
}

export function parseTrade(r: Row): FuturesTrade | null {
	const symbol = str(r.symbol).toUpperCase();
	const id = num(r.id);
	const orderId = num(r.orderId);
	const at = num(r.time);
	if (!symbol || !(id > 0) || !(orderId > 0) || !(at > 0)) return null;
	const ps = str(r.positionSide);
	return {
		id,
		orderId,
		symbol,
		side: str(r.side) === "SELL" ? "SELL" : "BUY",
		positionSide: ps === "LONG" || ps === "SHORT" ? ps : "BOTH",
		price: num(r.price),
		qty: num(r.qty),
		quoteQty: num(r.quoteQty),
		realizedPnl: num(r.realizedPnl),
		commission: num(r.commission),
		commissionAsset: str(r.commissionAsset),
		maker: r.maker === true,
		at,
	};
}

/** 한 종목의 체결 — 구간마다 startTime·endTime 으로, 1,000건이 차면 fromId 로 이어 받는다 (fromId 는 기간과 같이 못 보낸다) */
export async function futuresTrades(c: BinanceCreds, symbol: string, ranges: ReadonlyArray<[number, number]>): Promise<{ trades: FuturesTrade[]; truncated: boolean }> {
	const out = new Map<number, FuturesTrade>();
	let truncated = false;
	const take = (rows: unknown, end: number): { n: number; lastId: number; past: boolean } => {
		const arr = Array.isArray(rows) ? (rows as Row[]) : [];
		let lastId = 0;
		let past = false;
		for (const r of arr) {
			const t = parseTrade(r);
			if (!t) continue;
			lastId = Math.max(lastId, t.id);
			if (t.at > end) past = true;
			else out.set(t.id, t);
		}
		return { n: arr.length, lastId, past };
	};
	for (const [s, e] of ranges) {
		let got = take(await fget("/fapi/v1/userTrades", { symbol, startTime: String(s), endTime: String(e), limit: String(PAGE) }, c, `${symbol} 선물 체결 내역`), e);
		for (let page = 1; got.n >= PAGE && !got.past; page++) {
			if (page >= TRADE_PAGES) {
				truncated = true;
				break;
			}
			got = take(await fget("/fapi/v1/userTrades", { symbol, fromId: String(got.lastId + 1), limit: String(PAGE) }, c, `${symbol} 선물 체결 내역`), e);
		}
	}
	return { trades: [...out.values()].sort((a, b) => a.at - b.at || a.id - b.id), truncated };
}

/** LONG_OPEN 롱 진입 · LONG_CLOSE 롱 청산 · SHORT_OPEN 숏 진입 · SHORT_CLOSE 숏 청산 (일지 context 와 같은 값) */
export type FuturesDirection = NonNullable<JournalContext["direction"]>;

export const DIRECTION_TEXT: Record<FuturesDirection, string> = { LONG_OPEN: "롱 진입", LONG_CLOSE: "롱 청산", SHORT_OPEN: "숏 진입", SHORT_CLOSE: "숏 청산" };

/**
 * 진입인가 청산인가. 양방향(Hedge)은 positionSide 로 정확히 안다.
 * 단방향은 실현손익으로 추정한다 — 줄이는 체결에만 실현손익이 생긴다 (진입가에 딱 맞춰 닫으면 0 이라 진입으로 보인다).
 */
export function directionOf(o: { side: OrderSide; positionSide: FuturesPositionSide; realizedPnl: number }): FuturesDirection {
	if (o.positionSide === "LONG") return o.side === "BUY" ? "LONG_OPEN" : "LONG_CLOSE";
	if (o.positionSide === "SHORT") return o.side === "SELL" ? "SHORT_OPEN" : "SHORT_CLOSE";
	const closing = o.realizedPnl !== 0;
	return o.side === "BUY" ? (closing ? "SHORT_CLOSE" : "LONG_OPEN") : closing ? "LONG_CLOSE" : "SHORT_OPEN";
}

/** 주문 하나의 체결 묶음 */
export interface FuturesOrderFills {
	symbol: string;
	orderId: number;
	side: OrderSide;
	positionSide: FuturesPositionSide;
	direction: FuturesDirection;
	qty: number;
	/** 평균 체결가 */
	price: number;
	/** 체결 금액 합 */
	quoteQty: number;
	realizedPnl: number;
	/** 낸 수수료 합 — 자산이 섞였으면(USDT·BNB) null */
	commission: number | null;
	commissionAsset: string;
	/** 첫 체결 시각 */
	at: number;
	fills: number;
}

/** 체결 → 주문 단위로 (최근 순) */
export function groupOrders(trades: readonly FuturesTrade[]): FuturesOrderFills[] {
	const by = new Map<string, FuturesTrade[]>();
	for (const t of trades) {
		const k = `${t.symbol}:${t.orderId}`;
		by.set(k, [...(by.get(k) ?? []), t]);
	}
	const out: FuturesOrderFills[] = [];
	for (const g of by.values()) {
		const first = g[0]!;
		const qty = clean(g.reduce((s, t) => s + t.qty, 0));
		const quoteQty = clean(g.reduce((s, t) => s + t.quoteQty, 0));
		const realizedPnl = clean(g.reduce((s, t) => s + t.realizedPnl, 0));
		const assets = new Set(g.filter((t) => t.commission !== 0).map((t) => t.commissionAsset));
		const priced = g.reduce((s, t) => s + t.price * t.qty, 0);
		out.push({
			symbol: first.symbol,
			orderId: first.orderId,
			side: first.side,
			positionSide: first.positionSide,
			direction: directionOf({ side: first.side, positionSide: first.positionSide, realizedPnl }),
			qty,
			price: qty > 0 ? Number((priced / qty).toPrecision(10)) : 0,
			quoteQty,
			realizedPnl,
			commission: assets.size <= 1 ? clean(g.reduce((s, t) => s + t.commission, 0)) : null,
			commissionAsset: assets.size === 1 ? [...assets][0]! : assets.size === 0 ? first.commissionAsset : "",
			at: Math.min(...g.map((t) => t.at)),
			fills: g.length,
		});
	}
	return out.sort((a, b) => b.at - a.at || b.orderId - a.orderId);
}

/** 증거금(호가) 자산 — BTCUSDT → USDT. 모르면 USDT */
export function futuresQuote(symbol: string): string {
	return /(USDT|USDC|BUSD|FDUSD)$/.exec(symbol.toUpperCase())?.[1] ?? "USDT";
}

// ── 훑기 ────────────────────────────────────────────────────

export interface FuturesHistory {
	from: number;
	to: number;
	income: FuturesIncome[];
	/** 체결을 훑은 종목 */
	symbols: string[];
	orders: FuturesOrderFills[];
	warnings: string[];
}

/**
 * 손익 내역 → 매매한 종목 → 그 종목의 체결.
 * symbol 을 주면 그 종목만 (손익 기록이 없어도 기간 전체를 훑는다). 손익 내역이 실패하면 throw — 체결을 훑을 곳을 모른다.
 */
export async function futuresHistory(c: BinanceCreds, from: number, to: number, symbol?: string): Promise<FuturesHistory> {
	const warnings: string[] = [];
	const inc = await futuresIncome(c, from, to);
	if (inc.truncated) warnings.push("손익 내역이 많아 일부 구간은 앞쪽만 가져왔습니다 — 기간을 줄여 보세요");
	const income = symbol ? inc.rows.filter((i) => i.symbol === symbol || !i.symbol) : inc.rows;
	// 열린 포지션 — 못 읽으면 손익 내역만으로
	const held = symbol ? [] : await futuresPositions(c).then((ps) => [...new Set(ps.map((p) => p.symbol))]).catch(() => [] as string[]);
	const found = symbol ? [symbol] : [...new Set([...tradedSymbols(income), ...held])];
	const symbols = found.slice(0, MAX_HISTORY_SYMBOLS);
	if (found.length > symbols.length) warnings.push(`매매한 종목이 ${found.length}개라 최근 ${symbols.length}개만 체결을 훑었습니다 — 종목을 지정해 보세요`);
	const trades: FuturesTrade[] = [];
	const failed: string[] = [];
	for (const s of symbols) {
		const ranges = symbol ? windows(from, to) : withLast(tradeRanges(income, s, from, to), held.includes(s) ? windows(from, to).at(-1) : undefined);
		try {
			const r = await futuresTrades(c, s, ranges);
			trades.push(...r.trades);
			if (r.truncated) warnings.push(`${s} 체결이 많아 일부 구간은 앞쪽만 가져왔습니다`);
		} catch (err) {
			failed.push(`${s}(${err instanceof Error ? err.message.slice(0, 80) : "실패"})`);
		}
	}
	if (failed.length) warnings.push(`일부 종목의 체결을 가져오지 못했습니다: ${failed.join(", ")}`);
	return { from, to, income, symbols, orders: groupOrders(trades), warnings };
}

// ── 매매일지 가져오기 ───────────────────────────────────────

/** 주문 하나 → 일지 체결. 수수료는 증거금 자산으로 냈을 때만 (BNB 로 냈으면 비운다) */
export function futuresFill(o: FuturesOrderFills, open = false): BrokerFill {
	const currency = futuresQuote(o.symbol);
	const context: JournalContext = {
		direction: o.direction,
		realizedPnl: o.realizedPnl,
		...(o.positionSide !== "BOTH" ? { positionSide: o.positionSide } : {}),
	};
	return {
		ref: binanceFuturesRef(o.symbol, o.orderId),
		parentRef: null,
		broker: "binance_futures",
		symbol: o.symbol,
		name: null,
		side: o.side,
		ordered: o.qty,
		filled: o.qty,
		price: o.qty > 0 && o.price > 0 ? o.price : null,
		currency,
		fee: o.commission !== null && (o.commission === 0 || o.commissionAsset === currency) ? o.commission : null,
		at: o.at,
		open,
		context,
	};
}

/** 매매일지 가져오기 — 체결된 주문 전부. 아직 열린(부분 체결) 주문은 open 으로 표시해 새 줄로 넣지 않는다 */
export async function binanceFuturesFills(c: BinanceCreds, from: number, to: number): Promise<{ fills: BrokerFill[]; warnings: string[] }> {
	const h = await futuresHistory(c, from, to);
	if (h.orders.length === 0) return { fills: [], warnings: h.warnings };
	let open = new Set<string>();
	try {
		const rows = (await fget("/fapi/v1/openOrders", {}, c, "선물 미체결 조회")) as Row[];
		open = new Set((Array.isArray(rows) ? rows : []).map((r) => `${str(r.symbol).toUpperCase()}:${str(r.orderId)}`));
	} catch {
		/* 미체결을 못 읽으면 체결된 만큼만 넣는다 — 다음 가져오기가 수량을 다시 맞춘다 */
	}
	return { fills: h.orders.map((o) => futuresFill(o, open.has(`${o.symbol}:${o.orderId}`))), warnings: h.warnings };
}
