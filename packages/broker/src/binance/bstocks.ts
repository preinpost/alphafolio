/**
 * Binance bStocks — 토큰화 미국 주식·ETF (2026-06 출시, BTECH Holdings 발행). Binance **현물 거래소의 일반 USDT 쌍**이라
 * 주문·호가·봉·체결 API 가 코인과 같다 → 코인 자동 매매·`binance_order` 가 그대로 쓴다. 여기는 알아보고 이름 붙이는 것만.
 *
 *   심볼   티커 + "B" + USDT — AAPLBUSDT(기준 자산 AAPLB) · NVDABUSDT · SPYBUSDT. 규칙은 exchangeInfo (실측 AAPLB: tick 0.01 · step 0.001 · 최소 5 USDT)
 *   구분   exchangeInfo 에 표시가 없다. 기준가 계산(`/api/v3/referencePrice/calculation`)이 **EXTERNAL #2 (USDⓈ-M 선물 지수)** 인 B 접미 쌍
 *          (실측: 코인 ETH·SOL·PAXG·DOGE 는 ARITHMETIC_MEAN, bStock 은 모두 EXTERNAL #2)
 *   시간   24시간·주말도 체결된다 (실측 AAPLBUSDT 1시간봉 — 토·일도 움직인다, 거래량은 1/2~1/5)
 *   범위   체결가는 기준가 ±10% 안 (PRICE_RANGE) — 밖이면 EXPIRED (EXECUTION_RULE_PRICE_RANGE_EXCEEDED)
 *
 * ⚠️ 이름이 겹친다 — STXBUSDT 는 Seagate bStock, Stacks 코인은 STXUSDT. 그래서 "STX" 처럼 쌍이 아닌 티커를 받으면
 * 고르지 않고 두 후보를 알려 준다 (주문할 심볼은 늘 쌍 전체로).
 *
 * Binance 의 직접 미국 주식 거래(Nest Trading · Alpaca, 실제 주식)는 다른 API 다 — binance/stocks.ts (`/sapi/v1/equity`).
 */
import { PROVIDERS } from "../data/gateway.ts";
import { symbolRules, type BinanceCreds } from "./trade.ts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const BSTOCK_QUOTE = "USDT";

/** 모양만 — 티커(영문 1~6자) + B + USDT */
const SHAPE = /^([A-Z]{1,6})B(USDT)$/;

/** 티커 → bStock 쌍 (AAPL → AAPLBUSDT). 점·하이픈(BRK.B)은 뺀다 */
export const bStockSymbol = (ticker: string): string => `${ticker.toUpperCase().replace(/[^A-Z]/g, "")}B${BSTOCK_QUOTE}`;

/** 모양으로 본 원래 티커 (AAPLBUSDT → AAPL). bStock 인지는 bStockOf 로 확인한다 */
export function bStockTicker(symbol: string): string | null {
	return SHAPE.exec(symbol)?.[1] ?? null;
}

export interface BStock {
	symbol: string;
	/** 원래 미국 티커 (AAPL) */
	ticker: string;
	/** 토큰 이름 (AAPLB) */
	token: string;
}

const cache = new Map<string, { at: number; v: BStock | null }>();
const TTL = 6 * 60 * 60_000;

/**
 * bStock 인가 — "unknown" 은 모양은 맞는데 확인 조회가 실패했을 때 (주문 길목은 이걸 bStock 으로 본다 — 보수적으로).
 */
export async function bStockStatus(symbol: string, opts: { creds?: BinanceCreds; fetch?: FetchLike; now?: number } = {}): Promise<"bstock" | "coin" | "unknown"> {
	if (!bStockTicker(symbol)) return "coin";
	const ok = await bStockLookup(symbol, opts);
	return ok === undefined ? "unknown" : ok ? "bstock" : "coin";
}

/**
 * bStock 이면 정보, 아니면 null. 기준가 계산이 EXTERNAL #2 인 B 접미 USDT 쌍 — 조회가 실패하면 null (코인으로 다룬다:
 * 판정은 표시·경고에만 쓰고 주문 안전은 거래소 규칙이 지킨다).
 */
export async function bStockOf(symbol: string, opts: { creds?: BinanceCreds; fetch?: FetchLike; now?: number } = {}): Promise<BStock | null> {
	return (await bStockLookup(symbol, opts)) ?? null;
}

/** 조회 — bStock 정보 / null(코인) / undefined(조회 실패, 캐시하지 않는다) */
async function bStockLookup(symbol: string, opts: { creds?: BinanceCreds; fetch?: FetchLike; now?: number }): Promise<BStock | null | undefined> {
	const ticker = bStockTicker(symbol);
	if (!ticker) return null;
	const now = opts.now ?? Date.now();
	const hit = cache.get(symbol);
	if (hit && now - hit.at < TTL) return hit.v;
	const f = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
	let v: BStock | null = null;
	try {
		const base = PROVIDERS.binance.base(opts.creds ? { binance: opts.creds } : {});
		const res = await f(`${base}/api/v3/referencePrice/calculation?symbol=${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(10_000) });
		const body = (await res.json().catch(() => null)) as { calculationType?: string; externalCalculationId?: number } | null;
		if (res.ok && body?.calculationType === "EXTERNAL" && body.externalCalculationId === 2) v = { symbol, ticker, token: `${ticker}B` };
	} catch {
		return undefined; // 조회 실패는 캐시하지 않는다
	}
	cache.set(symbol, { at: now, v });
	return v;
}

/** 테스트 */
export function clearBStockCache(): void {
	cache.clear();
}

/**
 * 쌍이 아닌 티커(AAPL · STX)를 받았을 때 — Binance 에 있는 후보를 알려 주는 문장. 고르지 않는다 (이름이 겹친다).
 * 쌍이 아니면 이 문장으로 멈추고, 쌍이면 null.
 */
export async function binanceSymbolHint(raw: string, creds?: BinanceCreds): Promise<string | null> {
	const t = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
	if (!t || (/(USDT|USDC|FDUSD|BTC|ETH|BNB|USD1|TRY|EUR)$/.test(t) && t.length >= 6)) return null;
	const [coin, stock] = await Promise.all([symbolRules(`${t}USDT`, creds).catch(() => null), symbolRules(bStockSymbol(t), creds).catch(() => null)]);
	const hasStock = !!stock && stock.status === "TRADING";
	const hasCoin = !!coin && coin.status === "TRADING";
	// 미국 주식 티커면 — 실제 주식(직접 거래)이 먼저다. 토큰은 사용자가 원한다고 말했을 때만
	const direct = `${t} 이(가) 미국 주식이면 실제 주식은 binance_stock_order(symbol: '${t}') · 자동 매매는 watch_alert market: 'us' + order.broker: 'binance_stock' 로 한다`;
	if (hasStock && hasCoin) return `${t} 은(는) 겹친다 — 코인 ${t}USDT 인지 미국 주식인지 사용자에게 물어보세요. ${direct}. (토큰 ${bStockSymbol(t)} 은 사용자가 bStock·토큰이라고 직접 말했을 때만)`;
	if (hasStock) return `${direct}. 코인 시장(binance)에는 ${t} 코인이 없다 — 토큰 ${bStockSymbol(t)} 은 사용자가 bStock·토큰이라고 직접 말했을 때만 (bStock: true)`;
	if (hasCoin) return `Binance 심볼은 쌍 전체로 주세요 — 코인 ${t}USDT`;
	return `Binance 에 ${t} 거래쌍이 없습니다 — 코인은 BTCUSDT 처럼 쌍 전체로. 미국 주식이면 binance_stock_order(symbol: '${t}')`;
}

/** bStock 경고 — 확인 카드·주문 카드 공용 */
export function bStockWarnings(b: BStock, auto: boolean): string[] {
	return [
		`bStock 은 ${b.ticker} 주식이 아니라 토큰화 증권(BTECH 발행 증서)입니다 — 직접 소유·의결권이 없고, 이용 가능 지역·자격이 아니면 Binance 가 주문을 거절합니다.`,
		`24시간(주말 포함) 체결되지만 미국 장 밖에는 거래가 얇습니다. 체결가는 선물 지수 기준가 ±10% 안에서만 됩니다.`,
		...(auto ? [`조건은 ${b.symbol} 자체 시세(Binance 봉)로 판정합니다 — 나스닥 ${b.ticker} 시세가 아닙니다.`] : []),
	];
}

/**
 * 주문 길목 — bStock(토큰)은 사용자가 토큰을 원한다고 **직접 말했을 때만** (bStock: true). 아니면 실제 주식 쪽으로 돌려보낸다.
 * 확인 조회가 실패하면(unknown) bStock 으로 본다 — 실제 주식을 원하는 사람에게 토큰을 사 주는 쪽이 더 나쁘다.
 */
export function bStockGate(symbol: string, status: "bstock" | "coin" | "unknown", allowToken: boolean | undefined): string | null {
	if (status === "coin" || allowToken === true) return null;
	const t = bStockTicker(symbol) ?? symbol;
	const why = status === "unknown" ? `${symbol} 이(가) bStock(토큰)인지 확인하지 못했습니다 (코인이면 잠시 뒤 다시)` : `${symbol} 은(는) ${t} 주식이 아니라 bStock — 토큰화 증서입니다`;
	return (
		`${why}. 사용자가 "바이낸스에서 ${t} 주식" 을 말했다면 실제 주식으로: binance_stock_order(symbol: '${t}') · 자동 매매는 watch_alert market: 'us' + order.broker: 'binance_stock'. ` +
		"사용자가 bStock·토큰을 원한다고 직접 말했을 때만 bStock: true 로 다시 부른다."
	);
}
