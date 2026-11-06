/** 보유 자산 표의 줄 만들기 — 주식·합친 종목·코인·직접 입력을 같은 모양(HoldRow)으로 */
import type { BrokerHolding, CryptoHoldingDto, ManualAssetDto } from "@alphafolio/protocol";
import { compactWon, type GroupedHolding } from "../../lib/portfolio.ts";
import { MANUAL_KIND_LABEL } from "../ManualAssetEditor.tsx";
import { approxShort, money, pctOf, qty, shortMoney, sign, signedShort, usd, usdPrice, usdt, won } from "./format.ts";

export const WALLET: Record<string, string> = { SPOT: "현물", FUNDING: "펀딩", EARN: "Earn 유연", EARN_LOCKED: "Earn 고정" };
export const BROKER_LABEL: Record<string, string> = { kis: "한국투자", toss: "토스", binance: "Binance", manual: "직접 입력" };

export type Kind = "domesticStock" | "overseasStock" | "crypto" | "manual";
export const KIND_CHIPS: Array<{ key: Kind | "all"; label: string }> = [
	{ key: "all", label: "전체" },
	{ key: "domesticStock", label: "국내주식" },
	{ key: "overseasStock", label: "해외주식" },
	{ key: "crypto", label: "코인" },
	{ key: "manual", label: "직접 입력" },
];
export type Sort = "value" | "pnl" | "name";

/** 1달러 미만 코인 — 기본은 접어 둔다 (거래하고 남은 잔돈) */
export const isDust = (c: CryptoHoldingDto): boolean => c.valueUsd !== null && c.valueUsd < 1;

/** 보유 자산 표의 한 줄 — 주식·합친 종목·코인·직접 입력을 같은 모양으로 */
export interface HoldRow {
	key: string;
	kind: Kind;
	name: string;
	sym: string | null;
	meta: string;
	metaWarn?: boolean;
	price: string | null;
	value: string;
	valueSub: string;
	/** 모바일 평가 — 원래 통화로 짧게 */
	valueShort: string;
	valueKrw: number;
	pnl: string | null;
	/** 모바일 손익 — 원래 통화로 짧게 */
	pnlShort: string | null;
	pnlPct: number | null;
	pnlNote?: string;
	pnlTitle?: string;
	manual?: ManualAssetDto & { valueKrw: number };
}

/** 평단 — 0 이면 모른다 (Binance 체결 내역에 없던 것·bStock 토큰) */
export const avgText = (h: BrokerHolding): string => (h.avgPrice > 0 ? money(h.avgPrice, h.currency) : "—");

export function stockRow(h: BrokerHolding, total: number): HoldRow {
	const known = h.avgPrice > 0;
	return {
		key: `${h.broker}-${h.market}-${h.symbol}`,
		kind: h.market === "domestic" ? "domesticStock" : "overseasStock",
		name: h.name,
		sym: h.name !== h.symbol ? h.symbol : null,
		meta: [`${qty(h.quantity)}주`, `평단 ${avgText(h)}`, BROKER_LABEL[h.broker] ?? h.broker, h.note].filter(Boolean).join(" · "),
		price: money(h.price, h.currency),
		value: money(h.value, h.currency),
		valueSub: h.currency === "USD" ? approxShort(h.valueKrw) : pctOf(h.valueKrw, total),
		valueShort: shortMoney(h.value, h.currency),
		valueKrw: h.valueKrw,
		pnl: known ? `${sign(h.profit)}${money(Math.abs(h.profit), h.currency)}` : null,
		pnlShort: known ? signedShort(h.profit, h.currency) : null,
		pnlPct: known ? h.profitPct : null,
	};
}

export function groupedRow(g: GroupedHolding, total: number): HoldRow {
	const known = g.parts.filter((h) => h.avgPrice > 0);
	const profit = known.reduce((s, h) => s + h.profit, 0);
	return {
		key: g.key,
		kind: g.market === "domestic" ? "domesticStock" : "overseasStock",
		name: g.name,
		sym: g.name !== g.symbol ? g.symbol : null,
		meta: `${qty(g.quantity)}주 · ${g.parts.map((h) => `${BROKER_LABEL[h.broker] ?? h.broker} ${qty(h.quantity)}`).join(" + ")}`,
		price: g.parts[0] ? money(g.parts[0].price, g.currency) : null,
		value: money(g.value, g.currency),
		valueSub: g.currency === "USD" ? approxShort(g.valueKrw) : pctOf(g.valueKrw, total),
		valueShort: shortMoney(g.value, g.currency),
		valueKrw: g.valueKrw,
		pnl: g.profitPct !== null ? `${sign(profit)}${money(Math.abs(profit), g.currency)}` : null,
		pnlShort: g.profitPct !== null ? signedShort(profit, g.currency) : null,
		pnlPct: g.profitPct,
	};
}

export function cryptoRow(c: CryptoHoldingDto): HoldRow {
	// 평단은 현물 체결로 추정 — 입금·보상분이 섞이면 "일부"
	const partial = c.costCoverage !== null && c.costCoverage < 0.95;
	return {
		key: `${c.source}-${c.asset}`,
		kind: "crypto",
		name: c.asset,
		sym: c.stable ? "스테이블" : null,
		meta: [qty(c.quantity), c.avgPriceUsd !== null ? `평단 ${usdPrice(c.avgPriceUsd)}` : null, c.wallets.map((w) => WALLET[w.wallet] ?? w.wallet).join("·"), BROKER_LABEL[c.source]]
			.filter(Boolean)
			.join(" · "),
		price: c.priceUsd !== null ? usdPrice(c.priceUsd) : null,
		value: c.valueUsd === null ? "시세 없음" : usdt(c.valueUsd),
		valueSub: approxShort(c.valueKrw),
		valueShort: c.valueUsd === null ? "시세 없음" : usdt(c.valueUsd),
		valueKrw: c.valueKrw,
		pnl: c.profitUsd !== null && c.profitPct !== null ? `${sign(c.profitUsd)}${usd(Math.abs(c.profitUsd))}` : null,
		pnlShort: c.profitUsd !== null && c.profitPct !== null ? signedShort(c.profitUsd, "USD") : null,
		pnlPct: c.profitPct,
		...(partial ? { pnlNote: "일부" } : {}),
		...(c.avgPriceUsd !== null
			? { pnlTitle: `평단 ${usdPrice(c.avgPriceUsd)} (현물 체결 추정${partial ? `, 보유의 ${Math.round((c.costCoverage ?? 0) * 100)}%만 설명됨` : ""})` }
			: {}),
	};
}

/** 며칠 전에 고쳤나 — 시세가 없는 값이라 오래되면 알린다 */
export function ageText(iso: string): string {
	const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
	if (!(days >= 1)) return "오늘 갱신";
	return days >= 30 ? `${Math.floor(days / 30)}개월 전 갱신` : `${days}일 전 갱신`;
}

export function manualRow(m: ManualAssetDto & { valueKrw: number }, total: number): HoldRow {
	return {
		key: `manual-${m.id}`,
		kind: "manual",
		name: m.name,
		sym: null,
		meta: [MANUAL_KIND_LABEL[m.kind], ageText(m.updatedAt), m.memo].filter(Boolean).join(" · "),
		metaWarn: Date.now() - Date.parse(m.updatedAt) > 90 * 86_400_000,
		price: null,
		value: m.currency === "KRW" ? won(m.valueKrw) : usd(m.amount),
		valueSub: m.currency === "USD" ? approxShort(m.valueKrw) : pctOf(m.valueKrw, total),
		valueShort: m.currency === "KRW" ? compactWon(m.valueKrw) : usd(m.amount),
		valueKrw: m.valueKrw,
		pnl: null,
		pnlShort: null,
		pnlPct: null,
		manual: m,
	};
}
