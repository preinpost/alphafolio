/**
 * Binance — 코인 잔고 + 미국 주식(직접 거래) + bStock 토큰.
 *
 *   잔고   wallet.ts 의 지갑별 조회 + Earn 고정 상품(`GET /sapi/v1/simple-earn/locked/position`)
 *   가격   `GET /api/v3/ticker/price` 전 종목 — {자산}USDT → USDC → FDUSD 순. 스테이블코인은 마켓이 없으면 1
 *   주식   지갑의 `EQ_{티커}` 잔고가 보유 수량 (@binance/stocks 문서: 주식의 내부 자산 코드 — 접두사를 떼면 티커). 평단은 체결 내역으로 (stocks.ts equityHoldings).
 *          지갑에 EQ_ 가 하나도 없으면 체결 내역 추정으로 돌아간다. 가격은 Binance 호가 중간값, 없으면 본주 시세(KIS·토스)
 *   bStock 지갑의 AAPLB 같은 토큰은 코인이 아니라 해외주식으로 옮긴다 (기준가 계산 방식으로 확인 — bstocks.ts)
 *   평단   코인은 현물 체결(`GET /api/v3/myTrades`, 달러 마켓)의 이동평균으로 추정 — 입금·Convert·보상분은 원가를 몰라 커버리지로 밝힌다
 *
 *   선물   USDⓈ-M 선물 지갑의 증거금 잔고(지갑 + 미실현 손익)를 그 자산으로 센다 — 포지션 크기(명목가)는 자산이 아니라 넣지 않는다.
 *          키에 선물 권한이 없으면 조용히 뺀다 (선물을 안 쓰는 계정에 매번 경고가 뜨지 않게)
 *
 * 조회만 한다. 마진은 넣지 않는다.
 * 테스트넷 키는 모의 잔고라 합계에서 뺀다 (connect 가 skipped).
 */
import { bStockOf } from "../binance/bstocks.ts";
import { equityHoldings, equityPositions, equityQuote, equityTicker, type EquityHolding } from "../binance/stocks.ts";
import { signed, tickerPrices, type BinanceCreds } from "../binance/trade.ts";
import { walletBalances, type WalletAsset } from "../binance/wallet.ts";
import type { CryptoHolding, Holding } from "../normalize.ts";
import type { BrokerAccess } from "../portfolio.ts";
import { fetchQuote } from "../quote.ts";
import { emptyResult, reason, type AssetSource, type SourceResult } from "./types.ts";

/** bStock 확인은 자산마다 한 번씩 부른다 (6시간 캐시) — 후보를 이만큼만 */
const MAX_TOKEN_CHECKS = 10;
const BSTOCK_ASSET = /^[A-Z]{1,6}B$/;

/** 달러 스테이블코인 — 배분에서 현금성으로 본다 */
export const STABLES: ReadonlySet<string> = new Set(["USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USD1"]);
/** 가격을 찾을 달러 마켓 순서 (모두 ≈ 1 USD 로 본다) */
const QUOTES = ["USDT", "USDC", "FDUSD"];

const WALLET_TEXT: Record<string, string> = {
	SPOT: "현물",
	FUNDING: "펀딩",
	EARN: "Earn 유연",
	EARN_LOCKED: "Earn 고정",
	FUTURES: "선물",
};

async function lockedEarn(c: BinanceCreds): Promise<WalletAsset[]> {
	const r = (await signed("GET", "/sapi/v1/simple-earn/locked/position", { size: "100" }, c, "Earn 고정 조회")) as {
		rows?: Array<Record<string, unknown>>;
	};
	return (r.rows ?? [])
		.filter((x) => Number(x.amount) > 0)
		.map((x) => ({ asset: String(x.asset ?? ""), free: String(x.amount) }));
}

/** 자산의 USD 가격 (순수) — 스테이블은 마켓이 없어도 1, 그 외는 못 찾으면 null */
export function usdPrice(asset: string, prices: ReadonlyMap<string, number>): number | null {
	if (asset === "USDT") return 1;
	for (const q of QUOTES) {
		if (q === asset) continue;
		const p = prices.get(`${asset}${q}`);
		if (p !== undefined) return p;
	}
	return STABLES.has(asset) ? 1 : null;
}

/**
 * 지갑별 잔고 → 자산별 합계 (순수). free + locked(주문·동결) 를 모두 센다 — 묶였어도 내 자산이다.
 * prices 가 null 이면 (시세 조회 실패) 수량만 채운다.
 */
export function mergeCrypto(
	wallets: Array<{ wallet: string; assets: WalletAsset[] }>,
	prices: ReadonlyMap<string, number> | null,
): CryptoHolding[] {
	const byAsset = new Map<string, CryptoHolding>();
	for (const { wallet, assets } of wallets) {
		for (const a of assets) {
			const qty = Number(a.free) + Number(a.locked ?? 0);
			if (!a.asset || !(qty > 0)) continue;
			let h = byAsset.get(a.asset);
			if (!h) {
				h = {
					source: "binance",
					asset: a.asset,
					quantity: 0,
					wallets: [],
					priceUsd: null,
					valueUsd: null,
					valueKrw: 0,
					stable: STABLES.has(a.asset),
					avgPriceUsd: null,
					costCoverage: null,
					profitUsd: null,
					profitPct: null,
				};
				byAsset.set(a.asset, h);
			}
			h.quantity += qty;
			const w = h.wallets.find((x) => x.wallet === wallet);
			if (w) w.quantity += qty;
			else h.wallets.push({ wallet, quantity: qty });
		}
	}
	const out = [...byAsset.values()];
	for (const h of out) {
		h.quantity = Number(h.quantity.toPrecision(12));
		const p = prices ? usdPrice(h.asset, prices) : null;
		if (p !== null) {
			h.priceUsd = p;
			h.valueUsd = Math.round(h.quantity * p * 100) / 100;
		}
	}
	return out.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** 주식 보유 + 가격 → 주식 잔고 (순수). 가격이 없으면 평가 0 — 호출부가 경고한다 */
export function equityHolding(h: EquityHolding, price: number | null, fromWallet = false): Holding {
	const px = price ?? 0;
	const value = round2(h.qty * px);
	const avg = h.avgPrice ?? 0;
	const profit = avg > 0 && px > 0 ? round2(h.qty * (px - avg)) : 0;
	return {
		broker: "binance",
		symbol: h.symbol,
		name: h.symbol,
		market: "overseas",
		currency: "USD",
		quantity: h.qty,
		avgPrice: avg,
		price: px,
		value,
		profit,
		profitPct: avg > 0 && px > 0 ? round2(((px - avg) / avg) * 100) : 0,
		valueKrw: 0,
		note: fromWallet ? "지갑 잔고 · 평단은 체결 내역" : "체결 내역 추정",
	};
}

/** bStock 토큰 잔고 → 해외주식 잔고 (순수). 평단은 모른다 */
export function tokenHolding(c: CryptoHolding, ticker: string): Holding {
	return {
		broker: "binance",
		symbol: ticker,
		name: ticker,
		market: "overseas",
		currency: "USD",
		quantity: c.quantity,
		avgPrice: 0,
		price: c.priceUsd ?? 0,
		value: c.valueUsd ?? 0,
		profit: 0,
		profitPct: 0,
		valueKrw: 0,
		note: `bStock 토큰 ${c.asset}`,
	};
}

/** Binance 호가 중간값 → 없으면 본주 시세 */
async function equityPrice(c: BinanceCreds, access: BrokerAccess, symbol: string): Promise<number | null> {
	const q = await equityQuote(c, symbol).catch(() => null);
	if (q) {
		const mid = q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : q.ask > 0 ? q.ask : q.bid;
		if (mid > 0) return mid;
	}
	return fetchQuote(access, symbol).then((x) => (x.price > 0 ? x.price : null)).catch(() => null);
}

// ── 코인 평단 추정 ─────────────────────────────────────────

/** 평단을 볼 코인 수 (평가금액 상위) — 마켓마다 myTrades(weight 20)를 부른다 */
const MAX_COST_ASSETS = 15;
const COST_TTL = 10 * 60_000;
const costCache = new Map<string, { at: number; v: { qty: number; avg: number | null } }>();

export interface CoinFill {
	isBuyer: boolean;
	/** 체결 수량 (수수료를 이 자산으로 냈으면 뺀 순수량) */
	qty: number;
	/** 체결 금액 (USD 상당) */
	quote: number;
	time: number;
}

/** 체결 → 남은 수량·평단 (이동평균, 매도는 평단을 바꾸지 않는다). 순수 */
export function coinCostBasis(fills: readonly CoinFill[]): { qty: number; avg: number | null } {
	let qty = 0;
	let cost = 0;
	for (const f of [...fills].sort((a, b) => a.time - b.time)) {
		if (f.isBuyer) {
			qty += f.qty;
			cost += f.quote;
		} else {
			const sold = Math.min(f.qty, qty);
			cost -= qty > 0 ? (cost / qty) * sold : 0;
			qty -= sold;
		}
	}
	return { qty: Number(qty.toPrecision(12)), avg: qty > 0 && cost > 0 ? Number((cost / qty).toPrecision(10)) : null };
}

/** 평단 → 보유분 손익 (순수). 체결로 설명되는 수량까지만 손익을 낸다 */
export function withCost(h: CryptoHolding, basis: { qty: number; avg: number | null }): CryptoHolding {
	if (basis.avg === null || h.priceUsd === null || !(h.quantity > 0)) return h;
	const covered = Math.min(h.quantity, basis.qty);
	return {
		...h,
		avgPriceUsd: basis.avg,
		costCoverage: Math.round((covered / h.quantity) * 1000) / 1000,
		profitUsd: Math.round(covered * (h.priceUsd - basis.avg) * 100) / 100,
		profitPct: Math.round(((h.priceUsd - basis.avg) / basis.avg) * 10000) / 100,
	};
}

/** 한 마켓의 내 체결 전부 (오래된 것부터, 1000건씩 최대 5쪽) */
async function myTrades(c: BinanceCreds, symbol: string, asset: string, quoteAsset: string): Promise<CoinFill[]> {
	const out: CoinFill[] = [];
	let fromId = "0";
	for (let page = 0; page < 5; page++) {
		const rows = (await signed("GET", "/api/v3/myTrades", { symbol, fromId, limit: "1000" }, c, `${symbol} 체결 조회`)) as Array<Record<string, unknown>>;
		if (!Array.isArray(rows) || rows.length === 0) break;
		for (const r of rows) {
			const fee = Number(r.commission) || 0;
			const qty = Number(r.qty) || 0;
			const quote = Number(r.quoteQty) || 0;
			const buyer = r.isBuyer === true;
			out.push({
				isBuyer: buyer,
				// 매수 수수료를 그 코인으로 냈으면 받은 수량이 그만큼 적다 · 매도 수수료를 달러로 냈으면 받은 금액이 적다(원가와 무관)
				qty: buyer && r.commissionAsset === asset ? qty - fee : qty,
				// 매수 수수료를 달러로 냈으면 원가에 더한다
				quote: buyer && r.commissionAsset === quoteAsset ? quote + fee : quote,
				time: Number(r.time) || 0,
			});
		}
		if (rows.length < 1000) break;
		fromId = String(Number(rows[rows.length - 1]!.id) + 1);
	}
	return out;
}

async function coinBasis(c: BinanceCreds, asset: string, prices: ReadonlyMap<string, number>, now: number): Promise<{ qty: number; avg: number | null }> {
	const key = `${c.key}:${asset}`;
	const hit = costCache.get(key);
	if (hit && now - hit.at < COST_TTL) return hit.v;
	const markets = QUOTES.filter((q) => q !== asset && prices.has(`${asset}${q}`));
	const fills = (await Promise.all(markets.map((q) => myTrades(c, `${asset}${q}`, asset, q)))).flat();
	const v = coinCostBasis(fills);
	costCache.set(key, { at: now, v });
	return v;
}

/** 테스트 */
export function clearCoinCostCache(): void {
	costCache.clear();
}

async function fetchBinance(c: BinanceCreds, access: BrokerAccess): Promise<SourceResult> {
	const warnings: string[] = [];
	const [walletsRes, lockedRes, pricesRes, equityRes] = await Promise.allSettled([
		walletBalances(c),
		lockedEarn(c),
		tickerPrices(c),
		equityHoldings(c),
	]);

	const wallets: Array<{ wallet: string; assets: WalletAsset[] }> = [];
	const failed: string[] = [];
	for (const w of walletsRes.status === "fulfilled" ? walletsRes.value : []) {
		if (w.assets) wallets.push({ wallet: w.wallet, assets: w.assets });
		else if (w.wallet === "FUTURES" && /permissions/i.test(w.error ?? "")) continue;
		else failed.push(`${WALLET_TEXT[w.wallet] ?? w.wallet}(${w.error ?? "실패"})`);
	}
	// 지갑을 하나도 못 읽었으면 출처 전체 실패 — 0원으로 보이면 자산이 사라진 것처럼 보인다
	if (wallets.length === 0) {
		throw new Error(walletsRes.status === "rejected" ? reason(walletsRes.reason) : `지갑 잔고를 불러오지 못했습니다: ${failed.join(", ")}`);
	}
	if (failed.length > 0) warnings.push(`Binance 일부 지갑을 불러오지 못했습니다: ${failed.join(", ")}`);

	if (lockedRes.status === "fulfilled") wallets.push({ wallet: "EARN_LOCKED", assets: lockedRes.value });
	else warnings.push(`Binance Earn 고정 상품을 불러오지 못했습니다: ${reason(lockedRes.reason)}`);

	const prices = pricesRes.status === "fulfilled" ? pricesRes.value : null;
	if (!prices) warnings.push(`Binance 시세를 불러오지 못해 코인 평가금액이 빠졌습니다: ${reason((pricesRes as PromiseRejectedResult).reason)}`);

	let crypto = mergeCrypto(wallets, prices);
	const holdings: Holding[] = [];

	// bStock 토큰 → 해외주식. 확인이 실패하면 코인으로 남긴다 (금액은 같고 분류만 다르다)
	const candidates = crypto.filter((x) => BSTOCK_ASSET.test(x.asset) && prices?.has(`${x.asset}USDT`)).slice(0, MAX_TOKEN_CHECKS);
	const tokens = await Promise.all(candidates.map(async (x) => ({ x, b: await bStockOf(`${x.asset}USDT`, { creds: c }).catch(() => null) })));
	const moved = new Set<string>();
	for (const { x, b } of tokens) {
		if (!b) continue;
		holdings.push(tokenHolding(x, b.ticker));
		moved.add(x.asset);
	}
	crypto = crypto.filter((x) => !moved.has(x.asset));

	// 주식(본주) EQ_ 잔고 → 해외주식. 코인 시세가 없으니 코인 목록에서 뺀다 (binance_stock_account 도 같은 규칙)
	const equityWallet = new Map<string, number>();
	for (const x of crypto) {
		const t = equityTicker(x.asset);
		if (t) equityWallet.set(t, x.quantity);
	}
	crypto = crypto.filter((x) => equityTicker(x.asset) === null);

	if (prices) {
		const unpriced = crypto.filter((h) => h.priceUsd === null).map((h) => h.asset);
		if (unpriced.length > 0) warnings.push(`Binance 달러 시세가 없어 합계에서 뺀 자산: ${unpriced.join(", ")}`);
	}

	// 코인 평단 — 스테이블·잔돈·시세 없는 것은 건너뛴다. 실패는 평단 없음으로 (평가금액은 그대로)
	const costTargets = prices
		? crypto.filter((x) => !x.stable && x.priceUsd !== null && (x.valueUsd ?? 0) >= 1).slice(0, MAX_COST_ASSETS)
		: [];
	const costFailed: string[] = [];
	const now = Date.now();
	const [bases, priced] = await Promise.all([
		Promise.all(
			costTargets.map((x) =>
				coinBasis(c, x.asset, prices!, now).catch((err: unknown) => {
					costFailed.push(`${x.asset}(${reason(err).slice(0, 60)})`);
					return null;
				}),
			),
		),
		Promise.all(
			equityPositions(equityWallet, equityRes.status === "fulfilled" ? equityRes.value : null).map(async (h) => ({
				h,
				px: await equityPrice(c, access, h.symbol),
			})),
		),
	]);
	const basisOf = new Map(costTargets.map((x, i) => [x.asset, bases[i]]));
	crypto = crypto.map((x) => {
		const b = basisOf.get(x.asset);
		return b ? withCost(x, b) : x;
	});
	if (costFailed.length > 0) warnings.push(`Binance 코인 평단을 계산하지 못했습니다: ${costFailed.join(", ")}`);

	// 미국 주식 — 지갑 EQ_ 잔고, 없으면 체결 내역 추정. 안 쓰는 계정이면 빈 목록이다
	const missing: string[] = [];
	for (const { h, px } of priced) {
		if (px === null) missing.push(h.symbol);
		holdings.push(equityHolding(h, px, h.fromWallet));
	}
	if (missing.length > 0) warnings.push(`Binance 미국 주식 시세를 찾지 못해 평가에서 뺀 종목: ${missing.join(", ")}`);
	if (equityRes.status === "rejected") {
		warnings.push(
			equityWallet.size > 0
				? `Binance 미국 주식 체결 내역을 불러오지 못해 평단이 빠졌습니다: ${reason(equityRes.reason)}`
				: `Binance 미국 주식 보유(체결 내역)를 불러오지 못했습니다: ${reason(equityRes.reason)}`,
		);
	}

	return { ...emptyResult(), holdings, crypto, warnings };
}

export const binanceSource: AssetSource = {
	id: "binance",
	label: "Binance",
	connect(access) {
		if (!access.binance) return null;
		const creds = access.binance();
		if (creds.testnet) return { skipped: "테스트넷 키 — 모의 잔고라 총자산에서 뺍니다" };
		return { run: () => fetchBinance(creds, access) };
	},
};

export { equityPositions, equityTicker };

export const walletLabel = (wallet: string): string => WALLET_TEXT[wallet] ?? wallet;
