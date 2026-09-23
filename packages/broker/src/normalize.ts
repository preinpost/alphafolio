/**
 * KIS 원시 응답 → 앱 타입.
 *
 * KIS 는 모든 수치를 **문자열**로 주고 필드명이 API마다 다르다. 그 차이를
 * 여기서 흡수해, 툴·UI·집계는 정규화된 타입만 다루게 한다.
 */
import type { KisResponse } from "./kis/client.ts";
import type { TossCandle, TossHoldings, TossPrice } from "./toss/api.ts";

export interface Quote {
	symbol: string;
	name: string;
	market: "domestic" | "overseas";
	/** 해외만 — 실제로 조회된 거래소 */
	exchange?: string;
	currency: "KRW" | "USD";
	price: number;
	change: number;
	changePct: number;
	volume: number | null;
	/** 국내만 — 없으면 null */
	per: number | null;
	pbr: number | null;
	high52: number | null;
	low52: number | null;
}

export interface Bar {
	date: string; // YYYYMMDD
	open: number;
	high: number;
	low: number;
	close: number;
	volume?: number;
}

export type BrokerId = "kis" | "toss";

export interface Holding {
	/** 어느 증권사 계좌의 잔고인가 — 두 곳을 함께 쓰면 합산되므로 구분이 필요하다 */
	broker: BrokerId;
	symbol: string;
	name: string;
	market: "domestic" | "overseas";
	currency: "KRW" | "USD";
	quantity: number;
	avgPrice: number;
	price: number;
	/** 평가금액 (해당 통화 기준) */
	value: number;
	profit: number;
	profitPct: number;
	/** 원화 환산 평가금액 — 해외는 환율 적용, 국내는 value 와 같다 */
	valueKrw: number;
}

export interface PortfolioSummary {
	holdings: Holding[];
	/** 실제로 조회에 성공한 증권사 */
	brokers: BrokerId[];
	/** 주식 평가금액 합계 (원화 환산) */
	stockValueKrw: number;
	/** 예수금 (원화) — 국내 계좌 기준 */
	cashKrw: number;
	/**
	 * 달러 예수금 (토스 매수가능금액, USD). 원화로 환산하지 않고 따로 둔다 — 미국 주식은 달러로 주문하고,
	 * 원화 예수금과 합치면 총자산·스냅샷 기록의 뜻이 바뀐다. 두 금액은 서로를 포함하지 않는다 (실측, PLAN §30).
	 */
	cashUsd: number;
	/** 평가손익 합계 (원화 환산) */
	profitKrw: number;
	/** 적용한 USD/KRW 환율 */
	usdKrw: number;
	/** 조회하지 못한 구간 (예: 해외 계좌 미개설) — 사용자에게 그대로 알린다 */
	warnings: string[];
}

// ── 파싱 헬퍼 ───────────────────────────────────────────────────────────

function num(v: unknown): number {
	const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, ""));
	return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
	if (v === undefined || v === null || String(v).trim() === "") return null;
	const n = Number(String(v).replace(/,/g, ""));
	return Number.isFinite(n) ? n : null;
}

function rows(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function obj(value: unknown): Record<string, unknown> {
	// KIS 는 output2 를 객체로 줄 때도 있고 1개짜리 배열로 줄 때도 있다
	if (Array.isArray(value)) return (value[0] as Record<string, unknown>) ?? {};
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

// ── 현재가 ──────────────────────────────────────────────────────────────

export function toDomesticQuote(res: KisResponse, symbol: string): Quote {
	const o = obj(res.output);
	const price = num(o.stck_prpr);
	return {
		symbol,
		name: String(o.hts_kor_isnm ?? symbol),
		market: "domestic",
		currency: "KRW",
		price,
		change: num(o.prdy_vrss),
		changePct: num(o.prdy_ctrt),
		volume: numOrNull(o.acml_vol),
		per: numOrNull(o.per),
		pbr: numOrNull(o.pbr),
		high52: numOrNull(o.w52_hgpr),
		low52: numOrNull(o.w52_lwpr),
	};
}

export function toOverseasQuote(res: KisResponse, symbol: string, exchange: string): Quote {
	const o = obj(res.output);
	return {
		symbol,
		// 해외 현재가 응답에는 종목명이 없다 (rsym 은 조회코드)
		name: symbol,
		market: "overseas",
		exchange,
		currency: "USD",
		price: num(o.last),
		change: num(o.diff),
		changePct: num(o.rate),
		volume: numOrNull(o.tvol),
		per: null,
		pbr: null,
		high52: null,
		low52: null,
	};
}

// ── 차트 ────────────────────────────────────────────────────────────────

export function toDomesticBars(res: KisResponse): Bar[] {
	const out: Bar[] = [];
	for (const r of rows(res.output2)) {
		const date = String(r.stck_bsop_date ?? "");
		if (!date) continue;
		out.push({
			date,
			open: num(r.stck_oprc),
			high: num(r.stck_hgpr),
			low: num(r.stck_lwpr),
			close: num(r.stck_clpr),
			volume: numOrNull(r.acml_vol) ?? undefined,
		});
	}
	return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function toOverseasBars(res: KisResponse): Bar[] {
	const out: Bar[] = [];
	for (const r of rows(res.output2)) {
		const date = String(r.xymd ?? "");
		if (!date) continue;
		out.push({
			date,
			open: num(r.open),
			high: num(r.high),
			low: num(r.low),
			close: num(r.clos),
			volume: numOrNull(r.tvol) ?? undefined,
		});
	}
	return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── 잔고 ────────────────────────────────────────────────────────────────

export function toDomesticHoldings(res: KisResponse): { holdings: Holding[]; cashKrw: number } {
	const holdings: Holding[] = [];
	for (const r of rows(res.output1)) {
		const quantity = num(r.hldg_qty);
		if (quantity <= 0) continue; // 잔고 0인 과거 종목 제외
		const value = num(r.evlu_amt);
		holdings.push({
			broker: "kis",
			symbol: String(r.pdno ?? ""),
			name: String(r.prdt_name ?? r.pdno ?? ""),
			market: "domestic",
			currency: "KRW",
			quantity,
			avgPrice: num(r.pchs_avg_pric),
			price: num(r.prpr),
			value,
			profit: num(r.evlu_pfls_amt),
			profitPct: num(r.evlu_pfls_rt),
			valueKrw: value,
		});
	}

	const summary = obj(res.output2);
	return { holdings, cashKrw: num(summary.dnca_tot_amt) };
}

/**
 * 해외 체결기준현재잔고(CTRP6504R) → 보유종목 + 환율.
 *
 * 평가금액 필드가 통화구분에 따라 의미가 바뀌는 것을 피해
 * **수량 × 현재가**로 직접 계산한다.
 */
export function toOverseasHoldings(res: KisResponse): { holdings: Holding[]; usdKrw: number | null } {
	const holdings: Holding[] = [];
	let rate: number | null = null;

	for (const r of rows(res.output1)) {
		const quantity = num(r.cblc_qty13);
		if (quantity <= 0) continue;

		const price = num(r.ovrs_now_pric1);
		const avgPrice = num(r.avg_unpr3);
		const value = quantity * price;
		const rowRate = numOrNull(r.bass_exrt);
		if (rowRate && rowRate > 0) rate ??= rowRate;

		holdings.push({
			broker: "kis",
			symbol: String(r.pdno ?? ""),
			name: String(r.prdt_name ?? r.pdno ?? ""),
			market: "overseas",
			currency: (String(r.buy_crcy_cd ?? "USD") === "KRW" ? "KRW" : "USD") as Holding["currency"],
			quantity,
			avgPrice,
			price,
			value,
			profit: num(r.evlu_pfls_amt2),
			profitPct: num(r.evlu_pfls_rt1),
			valueKrw: rowRate && rowRate > 0 ? Math.round(value * rowRate) : 0,
		});
	}

	// 보유종목이 없어도 output2(통화별)에 최초고시환율이 온다
	if (rate === null) {
		for (const r of rows(res.output2)) {
			if (String(r.crcy_cd ?? "") !== "USD") continue;
			const v = numOrNull(r.frst_bltn_exrt);
			if (v && v > 0) {
				rate = v;
				break;
			}
		}
	}

	// 환율을 뒤늦게 찾았으면 원화 환산을 채운다
	if (rate !== null) {
		for (const h of holdings) {
			if (h.valueKrw === 0) h.valueKrw = Math.round(h.value * rate);
		}
	}

	return { holdings, usdKrw: rate };
}

// ── 토스 ────────────────────────────────────────────────────────────────

export function toTossQuote(p: TossPrice): Quote {
	const domestic = String(p.currency ?? "KRW").toUpperCase() === "KRW";
	return {
		symbol: p.symbol,
		// 토스 현재가 응답에는 종목명이 없다
		name: p.symbol,
		market: domestic ? "domestic" : "overseas",
		currency: domestic ? "KRW" : "USD",
		price: num(p.lastPrice),
		// 토스 prices 는 전일대비를 주지 않는다 — 0 으로 두고 UI 가 등락을 숨긴다
		change: 0,
		changePct: 0,
		volume: null,
		per: null,
		pbr: null,
		high52: null,
		low52: null,
	};
}

export function toTossBars(candles: TossCandle[]): Bar[] {
	const bars: Bar[] = [];
	for (const c of candles) {
		if (!c.timestamp) continue;
		// 토스는 ISO 8601 타임스탬프 — 차트 축은 YYYYMMDD 로 통일한다
		const date = c.timestamp.slice(0, 10).replace(/-/g, "");
		const open = num(c.openPrice);
		const high = num(c.highPrice);
		const low = num(c.lowPrice);
		const close = num(c.closePrice);
		if (!date || close === 0) continue;
		bars.push({ date, open, high, low, close, volume: numOrNull(c.volume) ?? undefined });
	}
	return bars.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 토스 보유종목 → 정규화.
 *
 * 토스는 손익률을 **소수비율**(0.1077 = 10.77%)로 주므로 퍼센트로 바꾼다.
 * 원화 환산은 KRW 종목이면 그대로, USD 종목이면 환율을 곱한다.
 */
export function toTossHoldings(res: TossHoldings, usdKrw: number): Holding[] {
	const out: Holding[] = [];
	for (const it of res.items ?? []) {
		const quantity = num(it.quantity);
		if (quantity <= 0) continue;

		const currency = String(it.currency ?? "KRW").toUpperCase() === "KRW" ? "KRW" : "USD";
		const value = num(it.marketValue?.amount);
		out.push({
			broker: "toss",
			symbol: it.symbol,
			name: it.name || it.symbol,
			market: it.marketCountry === "US" ? "overseas" : "domestic",
			currency,
			quantity,
			avgPrice: num(it.averagePurchasePrice),
			price: num(it.lastPrice),
			value,
			profit: num(it.profitLoss?.amount),
			profitPct: Math.round(num(it.profitLoss?.rate) * 10000) / 100,
			valueKrw: currency === "KRW" ? Math.round(value) : Math.round(value * usdKrw),
		});
	}
	return out;
}
