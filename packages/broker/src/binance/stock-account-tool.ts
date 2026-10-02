/**
 * binance_stock_account — Binance **미국 주식 계좌 조회** (조회만 — 주문은 binance_stock_order).
 *
 *   잔고   Funding 지갑(`POST /sapi/v1/asset/get-funding-asset`) · 현물(MAIN) 지갑의 USDC·USDT
 *          매수 대금 walletType 기본 CARD — Funding 인지 아직 실측 전 (TODO.md), 두 지갑을 다 보여 준다
 *   보유   체결 내역(전 종목, 매수 − 매도)으로 추정 — Binance 에 보유 API 가 없다
 *   괴리   Binance 호가(bid·ask, ~5초 지연) vs 본주 현재가(KIS·토스 — market_price 와 같은 길)
 *   토큰   Funding·현물에 있는 bStock(AAPLB 등) — 현물 AAPLBUSDT 가격 vs 본주 (1토큰 = 1주 가정)
 *   미체결 /sapi/v1/equity/order/open-orders
 *
 * 한 곳이 실패해도 나머지는 보여 주고, 빠진 것은 경고로 알린다 (portfolio.ts 와 같은 원칙).
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { BrokerAccess } from "../portfolio.ts";
import { fetchQuote } from "../quote.ts";
import { bStockOf } from "./bstocks.ts";
import { equityHoldings, equityOpenOrders, equityQuote, fundingAssets, type EquityHolding, type EquityOrder, type FundingAsset } from "./stocks.ts";
import { freeBalances, lastPrice, type BinanceCreds } from "./trade.ts";

const CASH = ["USDC", "USDT"];
/** 한 번에 괴리를 볼 종목 수 — 호가·본주 시세를 종목마다 두 번씩 부른다 */
const MAX_SYMBOLS = 15;
const MAX_TOKENS = 10;

export interface Premium {
	/** Binance 중간가 (bid·ask 중 하나만 있으면 그 값) */
	binance: number;
	underlying: number;
	/** (Binance 중간가 − 본주) / 본주 % */
	pct: number;
	/** 지금 사면(ask) · 팔면(bid) 본주 대비 % */
	askPct: number | null;
	bidPct: number | null;
	/** 호가 폭 / 중간가 % */
	spreadPct: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const rel = (a: number, b: number): number => round2(((a - b) / b) * 100);

/** 괴리 (순수) — 호가가 비었거나 본주 가격이 없으면 null */
export function premiumOf(q: { bid: number; ask: number } | null, underlying: number): Premium | null {
	if (!q || !(underlying > 0)) return null;
	const bid = q.bid > 0 ? q.bid : null;
	const ask = q.ask > 0 ? q.ask : null;
	const mid = bid && ask ? (bid + ask) / 2 : (ask ?? bid);
	if (!mid) return null;
	return {
		binance: round2(mid),
		underlying,
		pct: rel(mid, underlying),
		askPct: ask ? rel(ask, underlying) : null,
		bidPct: bid ? rel(bid, underlying) : null,
		spreadPct: bid && ask ? round2(((ask - bid) / mid) * 100) : null,
	};
}

const sign = (n: number): string => `${n >= 0 ? "+" : ""}${n}%`;
const usd = (n: number): string => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const qtyText = (n: number): string => String(Number(n.toPrecision(10)));

function cashLines(label: string, rows: Array<{ asset: string; free: string; locked?: string }>): string[] {
	const hit = rows.filter((r) => CASH.includes(r.asset));
	if (hit.length === 0) return [`- ${label}: USDC·USDT 없음`];
	return hit.map((r) => `- ${label} ${r.asset}: ${r.free}${r.locked && Number(r.locked) > 0 ? ` (묶임 ${r.locked})` : ""}`);
}

interface Row {
	symbol: string;
	holding: EquityHolding | null;
	quote: { bid: number; ask: number } | null;
	underlying: { price: number; source: string } | null;
	premium: Premium | null;
	problem: string | null;
}

interface TokenRow {
	asset: string;
	ticker: string;
	qty: number;
	wallet: string;
	price: number | null;
	underlying: number | null;
	pct: number | null;
}

export interface BinanceStockAccountDetails {
	kind: "binance-stock-account";
	funding: FundingAsset[] | null;
	spot: Record<string, string> | null;
	rows: Row[];
	tokens: TokenRow[];
	open: EquityOrder[] | null;
	warnings: string[];
}

function connected<T>(make: (() => T) | undefined): T | null {
	if (!make) return null;
	try {
		return make();
	} catch {
		return null;
	}
}

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createBinanceStockAccountTool(deps: { brokers: BrokerAccess }) {
	return defineTool({
		name: "binance_stock_account",
		label: "Binance 미국 주식 계좌",
		description:
			"Binance **미국 주식 직접 거래** 계좌를 조회한다 (조회만). Funding·현물 지갑의 USDC·USDT 잔고, 보유 주식(체결 내역으로 추정한 수량·평단·평가손익), " +
			"Binance 호가와 본주(나스닥·NYSE) 현재가의 괴리(%), 보유 bStock 토큰, 미체결 주문. " +
			"사용자가 바이낸스 주식 잔고·보유·괴리·프리미엄·USDC 를 물으면 이 툴. symbols 로 보유하지 않은 종목의 괴리도 본다 (예 'PANW,NVDA'). " +
			"주문은 binance_stock_order.",
		parameters: Type.Object({
			symbols: Type.Optional(Type.String({ description: "괴리를 볼 미국 티커, 콤마 구분 (보유 종목은 자동 포함) — 예 'PANW,NVDA'" })),
		}),
		execute: async (_id, params) => {
			const creds = connected(deps.brokers.binance) as BinanceCreds | null;
			if (!creds) throw new Error("Binance 키가 없습니다 — 설정 → 코인 (Binance) 에서 등록 (출금 권한 없이, 조회는 읽기 권한이면 된다).");
			const warnings: string[] = [];
			const soft = <T>(label: string, p: Promise<T>): Promise<T | null> =>
				p.catch((err) => {
					warnings.push(`${label} 실패: ${why(err)}`);
					return null;
				});

			const [funding, spot, holdings, open] = await Promise.all([
				soft("Funding 지갑", fundingAssets(creds)),
				soft("현물 지갑", freeBalances(creds)),
				soft("체결 내역(보유 추정)", equityHoldings(creds)),
				soft("미체결", equityOpenOrders(creds)),
			]);

			const asked = (params.symbols ?? "")
				.split(/[,\s]+/)
				.map((s) => s.trim().toUpperCase().replace(/[^A-Z.]/g, ""))
				.filter(Boolean);
			const symbols = [...new Set([...(holdings ?? []).map((h) => h.symbol), ...asked])];
			if (symbols.length > MAX_SYMBOLS) warnings.push(`종목이 많아 앞의 ${MAX_SYMBOLS}개만 괴리를 봤습니다.`);

			const rows: Row[] = await Promise.all(
				symbols.slice(0, MAX_SYMBOLS).map(async (symbol): Promise<Row> => {
					const holding = holdings?.find((h) => h.symbol === symbol) ?? null;
					const [q, u] = await Promise.all([
						equityQuote(creds, symbol).catch((err) => ({ error: why(err) })),
						fetchQuote(deps.brokers, symbol).catch((err) => ({ error: why(err) })),
					]);
					const quote = q && !("error" in q) ? q : null;
					const underlying = u && !("error" in u) ? { price: u.price, source: u.source } : null;
					const problem =
						q && "error" in q ? `Binance 호가 실패: ${q.error}` : !quote ? "Binance 호가 없음 (모르는 티커·거래정지·장 마감)" : !underlying ? `본주 시세 실패: ${(u as { error: string }).error}` : null;
					return { symbol, holding, quote, underlying, premium: underlying ? premiumOf(quote, underlying.price) : null, problem };
				}),
			);

			// bStock 토큰 — Funding("Stock Token")·현물 어느 쪽이든. B 로 끝나는 자산만 확인한다 (BNB 같은 코인은 bStockOf 가 거른다)
			const held = new Map<string, { qty: number; wallet: string }>();
			for (const a of funding ?? []) if (Number(a.free) + Number(a.locked) > 0) held.set(a.asset, { qty: Number(a.free) + Number(a.locked), wallet: "Funding" });
			for (const [asset, free] of Object.entries(spot ?? {})) {
				if (!(Number(free) > 0)) continue;
				const prev = held.get(asset);
				held.set(asset, prev ? { qty: prev.qty + Number(free), wallet: `${prev.wallet}+현물` } : { qty: Number(free), wallet: "현물" });
			}
			const candidates = [...held.keys()].filter((a) => /^[A-Z]{1,6}B$/.test(a)).slice(0, MAX_TOKENS);
			const tokens = (
				await Promise.all(
					candidates.map(async (asset): Promise<TokenRow | null> => {
						const b = await bStockOf(`${asset}USDT`, { creds }).catch(() => null);
						if (!b) return null;
						const { qty, wallet } = held.get(asset)!;
						const price = await lastPrice(b.symbol, creds).then(Number).catch(() => null);
						const underlying = await fetchQuote(deps.brokers, b.ticker).then((q) => q.price).catch(() => null);
						return { asset, ticker: b.ticker, qty, wallet, price, underlying, pct: price && underlying ? rel(price, underlying) : null };
					}),
				)
			).filter((t): t is TokenRow => t !== null);

			const lines: string[] = ["[Binance 미국 주식 계좌]", "", "잔고"];
			if (funding) lines.push(...cashLines("Funding", funding));
			if (spot) lines.push(...cashLines("현물(MAIN)", Object.entries(spot).map(([asset, free]) => ({ asset, free }))));
			lines.push("  ※ 매수 대금은 기본 CARD 지갑에서 나간다 — Funding 과 같은지는 실주문으로 확인 전");

			lines.push("", `보유 (체결 내역 추정, ${holdings ? `${holdings.length}종목` : "조회 실패"})`);
			let value = 0;
			let cost = 0;
			for (const r of rows.filter((x) => x.holding)) {
				const h = r.holding!;
				const px = r.premium?.binance ?? r.underlying?.price ?? null;
				const v = px ? h.qty * px : null;
				if (v !== null && h.avgPrice) {
					value += v;
					cost += h.qty * h.avgPrice;
				}
				const pnl = v !== null && h.avgPrice ? ` · 평가 ${usd(v)} (${sign(rel(px!, h.avgPrice))})` : v !== null ? ` · 평가 ${usd(v)}` : "";
				lines.push(`- ${r.symbol} ${qtyText(h.qty)}주 · 평단 ${h.avgPrice ? usd(h.avgPrice) : "—"}${pnl}`);
			}
			if (holdings?.length === 0) lines.push("- 없음");
			if (cost > 0) lines.push(`  합계 평가 ${usd(value)} · 원가 ${usd(cost)} (${sign(rel(value, cost))})`);
			if (holdings?.length) lines.push("  ※ 앱에서 bStock 으로 바꾼 주식·입출고는 체결 내역에 안 잡혀 실제와 다를 수 있다");

			if (rows.length) {
				lines.push("", "괴리 (Binance 중간가 vs 본주 현재가)");
				for (const r of rows) {
					if (!r.premium) {
						lines.push(`- ${r.symbol}: ${r.problem ?? "계산 불가"}`);
						continue;
					}
					const p = r.premium;
					lines.push(
						`- ${r.symbol}: Binance ${usd(p.binance)} (매수 ${r.quote!.bid} / 매도 ${r.quote!.ask}) vs 본주 ${usd(p.underlying)} [${r.underlying!.source}] → ${sign(p.pct)}` +
							`${p.askPct !== null ? ` · 지금 사면 ${sign(p.askPct)}` : ""}${p.bidPct !== null ? ` · 팔면 ${sign(p.bidPct)}` : ""}${p.spreadPct !== null ? ` · 호가 폭 ${p.spreadPct}%` : ""}`,
					);
				}
				lines.push("  ※ Binance 호가는 최대 ~5초, 본주 시세는 증권사 조회 시점 — 장 마감·장 밖에는 괴리가 커 보일 수 있다");
			}

			if (tokens.length) {
				lines.push("", "bStock 토큰 (1토큰 = 1주 가정)");
				for (const t of tokens) {
					lines.push(
						`- ${t.asset} ${qtyText(t.qty)} [${t.wallet}] · ${t.price ? usd(t.price) : "가격 없음"} vs 본주 ${t.ticker} ${t.underlying ? usd(t.underlying) : "—"}${t.pct !== null ? ` → ${sign(t.pct)}` : ""}`,
					);
				}
			}

			if (open) {
				lines.push("", `미체결 ${open.length}건`);
				for (const o of open) {
					lines.push(`- ${o.symbol} ${o.side === "BUY" ? "매수" : "매도"} ${o.qty ? `${o.qty}주` : `${o.notional} USDC`}${o.limitPrice ? ` @ $${o.limitPrice}` : " 시장가"} · 체결 ${o.filledQty} · ${o.status} (orderId=${o.orderId})`);
				}
			}
			if (warnings.length) lines.push("", ...warnings.map((w) => `⚠️ ${w}`));

			const details: BinanceStockAccountDetails = { kind: "binance-stock-account", funding, spot, rows, tokens, open, warnings };
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details };
		},
	});
}
