/**
 * binance_stock_account — Binance **미국 주식 계좌 조회** (조회만 — 주문은 binance_stock_order).
 *
 *   잔고   Funding 지갑(`POST /sapi/v1/asset/get-funding-asset`) · 현물(MAIN) 지갑의 USDC·USDT
 *          매수 대금 walletType 기본 CARD — Funding 인지 아직 실측 전 (TODO.md), 두 지갑을 다 보여 준다
 *   보유   Funding·현물 지갑의 `EQ_{티커}` 잔고가 수량 (주식의 내부 자산 코드 — @binance/stocks 문서). 평단은 체결 내역(전 종목) 이동평균.
 *          지갑에 EQ_ 가 없으면 체결 내역(매수 − 매도)으로 추정 — 주식 API 에 보유 조회가 없다 (sources/binance.ts 와 같은 규칙)
 *   괴리   Binance 호가(bid·ask, ~5초 지연) vs 본주 현재가(KIS·토스 — market_price 와 같은 길)
 *   토큰   Funding·현물에 있는 bStock(AAPLB 등) — 현물 AAPLBUSDT 가격 vs 본주 (1토큰 = 1주 가정)
 *   수수료 /sapi/v1/equity/order/history 의 fee (주문별 누적 USD) — 종목별 합계·체결 금액 대비 %, 최근 체결 주문
 *   미체결 /sapi/v1/equity/order/open-orders
 *
 * 한 곳이 실패해도 나머지는 보여 주고, 빠진 것은 경고로 알린다 (portfolio.ts 와 같은 원칙).
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { BrokerAccess } from "../portfolio.ts";
import { fetchQuote } from "../quote.ts";
import { bStockOf } from "./bstocks.ts";
import {
	EQUITY_SINCE,
	equityHoldings,
	equityOpenOrders,
	equityOrderHistory,
	equityPositions,
	equityQuote,
	equityTicker,
	feesFromOrders,
	fundingAssets,
	midOf,
	premiumOf,
	type EquityFees,
	type EquityHolding,
	type EquityOrder,
	type FundingAsset,
	type Premium,
} from "./stocks.ts";
import { lastPrice, type BinanceCreds } from "./trade.ts";
import { spotWallet } from "./wallet.ts";

const CASH = ["USDC", "USDT"];
/** 한 번에 괴리를 볼 종목 수 — 호가·본주 시세를 종목마다 두 번씩 부른다 */
const MAX_SYMBOLS = 15;
const MAX_TOKENS = 10;
/** 최근 체결 주문 몇 건을 보여 줄지 */
const RECENT_FILLED = 5;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const rel = (a: number, b: number): number => round2(((a - b) / b) * 100);

const sign = (n: number): string => `${n >= 0 ? "+" : ""}${n}%`;
const usd = (n: number): string => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const qtyText = (n: number): string => String(Number(n.toPrecision(10)));
const feePct = (fee: number, filled: number): string => `${Number(((fee / filled) * 100).toFixed(4))}%`;

function cashLines(label: string, rows: Array<{ asset: string; free: string; locked?: string }>): string[] {
	const hit = rows.filter((r) => CASH.includes(r.asset));
	if (hit.length === 0) return [`- ${label}: USDC·USDT 없음`];
	return hit.map((r) => `- ${label} ${r.asset}: ${r.free}${r.locked && Number(r.locked) > 0 ? ` (묶임 ${r.locked})` : ""}`);
}

interface Row {
	symbol: string;
	holding: (EquityHolding & { fromWallet: boolean }) | null;
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
	fees: EquityFees[] | null;
	recent: EquityOrder[];
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
			"Binance **미국 주식 직접 거래** 계좌를 조회한다 (조회만). Funding·현물 지갑의 USDC·USDT 잔고, 보유 주식(지갑 EQ_ 잔고 수량 · 체결 내역 평단 · 평가손익), " +
			"Binance 호가와 본주(나스닥·NYSE) 현재가의 괴리(%), 보유 bStock 토큰, 실제로 낸 수수료(주문 내역 fee — 종목별 합계·%·최근 체결), 미체결 주문. " +
			"사용자가 바이낸스 주식 잔고·보유·괴리·프리미엄·USDC·수수료를 물으면 이 툴. symbols 로 보유하지 않은 종목의 괴리도 본다 (예 'PANW,NVDA'). " +
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

			const [funding, spotRows, fills, open, history] = await Promise.all([
				soft("Funding 지갑", fundingAssets(creds)),
				soft("현물 지갑", spotWallet(creds)),
				soft("체결 내역(평단)", equityHoldings(creds)),
				soft("미체결", equityOpenOrders(creds)),
				soft("주문 내역(수수료)", equityOrderHistory(creds, null, EQUITY_SINCE)),
			]);
			const spot = spotRows ? Object.fromEntries(spotRows.map((a) => [a.asset, a.free])) : null;

			// 주식 EQ_ 잔고 — Funding·현물 어디든, 묶인 것(주문·동결)도 내 주식이다
			const eqWallet = new Map<string, number>();
			const addEq = (asset: string, qty: number): void => {
				const t = equityTicker(asset);
				if (t && qty > 0) eqWallet.set(t, Number(((eqWallet.get(t) ?? 0) + qty).toPrecision(12)));
			};
			for (const a of funding ?? []) addEq(a.asset, Number(a.free) + Number(a.locked) + Number(a.freeze));
			for (const a of spotRows ?? []) addEq(a.asset, Number(a.free) + Number(a.locked ?? 0));
			const fromWallet = eqWallet.size > 0;
			const holdings = fromWallet || fills ? equityPositions(eqWallet, fills) : null;
			const fillQty = new Map((fills ?? []).map((h) => [h.symbol, h.qty]));
			const fees = history ? feesFromOrders(history) : null;
			const recent = (history ?? [])
				.filter((o) => Number(o.filledQty) > 0)
				.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
				.slice(0, RECENT_FILLED);

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
			if (spotRows) lines.push(...cashLines("현물(MAIN)", spotRows));
			lines.push("  ※ 매수 대금은 기본 CARD 지갑에서 나간다 — Funding 과 같은지는 실주문으로 확인 전");

			lines.push("", `보유 (${fromWallet ? "지갑 EQ_ 잔고 · 평단은 체결 내역" : "체결 내역 추정"}, ${holdings ? `${holdings.length}종목` : "조회 실패"})`);
			let value = 0;
			let cost = 0;
			for (const r of rows.filter((x) => x.holding)) {
				const h = r.holding!;
				// 본주 시세가 없어도 Binance 호가로 평가한다
				const mid = midOf(r.quote);
				const px = mid ? round2(mid) : (r.underlying?.price ?? null);
				const v = px ? h.qty * px : null;
				if (v !== null && h.avgPrice) {
					value += v;
					cost += h.qty * h.avgPrice;
				}
				const pnl = v !== null && h.avgPrice ? ` · 평가 ${usd(v)} (${sign(rel(px!, h.avgPrice))})` : v !== null ? ` · 평가 ${usd(v)}` : "";
				const est = fillQty.get(r.symbol) ?? 0;
				const diff = h.fromWallet && fills && Math.abs(est - h.qty) > 1e-9 ? ` (체결 내역으로는 ${qtyText(est)}주)` : "";
				lines.push(`- ${r.symbol} ${qtyText(h.qty)}주${diff} · 평단 ${h.avgPrice ? usd(h.avgPrice) : "—"}${pnl}`);
			}
			if (holdings?.length === 0) lines.push("- 없음");
			if (cost > 0) lines.push(`  합계 평가 ${usd(value)} · 원가 ${usd(cost)} (${sign(rel(value, cost))})`);
			if (holdings?.length) {
				lines.push(
					fromWallet
						? "  ※ 평단은 체결 내역 이동평균 — bStock 에서 되돌린 주식·입고분은 원가를 몰라 평단이 다를 수 있다"
						: "  ※ 지갑에 EQ_ 잔고가 없어 체결 내역으로 추정 — 앱에서 bStock 으로 바꾼 주식·입출고는 안 잡혀 실제와 다를 수 있다",
				);
			}

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

			if (fees) {
				const fee = fees.reduce((a, e) => a + e.fee, 0);
				const filled = fees.reduce((a, e) => a + e.filled, 0);
				lines.push("", `수수료 (주문 내역 fee, 체결된 주문 ${fees.reduce((a, e) => a + e.orders, 0)}건)`);
				for (const e of fees) lines.push(`- ${e.symbol}: $${e.fee} / 체결 ${usd(e.filled)}${e.filled > 0 ? ` (${feePct(e.fee, e.filled)})` : ""} · ${e.orders}건`);
				if (fees.length === 0) lines.push("- 체결된 주문 없음");
				else lines.push(`  합계 $${Number(fee.toFixed(6))} / 체결 ${usd(filled)}${filled > 0 ? ` (${feePct(fee, filled)})` : ""}`);
				for (const o of recent) {
					const at = o.createdAt ? new Date(o.createdAt).toISOString().slice(0, 16).replace("T", " ") : "—";
					lines.push(`  · ${at} UTC ${o.symbol} ${o.side === "BUY" ? "매수" : "매도"} ${o.filledQty}주 @ ${o.avgFilledPrice ? `$${o.avgFilledPrice}` : "—"} · ${o.orderType} ${o.session ?? ""} · 수수료 ${o.fee === null ? "응답에 없음" : `$${o.fee}`}`);
				}
				lines.push("  ※ 호가 폭(스프레드)은 수수료에 안 들어간다 — 위 괴리의 '호가 폭' 참고");
			}

			if (open) {
				lines.push("", `미체결 ${open.length}건`);
				for (const o of open) {
					lines.push(
						`- ${o.symbol} ${o.side === "BUY" ? "매수" : "매도"} ${o.qty ? `${o.qty}주` : `${o.notional} USDC`}${o.limitPrice ? ` @ $${o.limitPrice}` : " 시장가"} · 체결 ${o.filledQty} · ${o.status}` +
							`${o.fee && Number(o.fee) > 0 ? ` · 수수료(예약) $${o.fee}` : ""} (orderId=${o.orderId})`,
					);
				}
			}
			if (warnings.length) lines.push("", ...warnings.map((w) => `⚠️ ${w}`));

			const details: BinanceStockAccountDetails = { kind: "binance-stock-account", funding, spot, rows, tokens, fees, recent, open, warnings };
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details };
		},
	});
}
