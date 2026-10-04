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

/**
 * 자산 출처 — 포트폴리오에 잔고를 보태는 계좌. 증권사(BrokerId)보다 넓다.
 * BrokerId 는 주문 경로(actions·quote)에도 쓰이므로 코인 거래소를 거기 섞지 않는다.
 */
export type SourceId = BrokerId | "binance" | "manual";

export interface Holding {
	/**
	 * 어느 계좌의 잔고인가 — 여러 곳을 함께 쓰면 합산되므로 구분이 필요하다.
	 * binance(미국 주식·bStock)는 전체 조회에만 있다 — 주문·타점이 쓰는 STOCK_SOURCES 조회에는 kis·toss 만 온다.
	 */
	broker: SourceId;
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
	/** 잔고가 추정이거나 주식이 아닌 것 (예: 체결 내역 추정 · bStock 토큰). avgPrice 0 = 평단 모름 */
	note?: string;
}

/**
 * 코인 잔고 — 지갑을 합친 자산별 수량과 USD 평가.
 * 거래소가 평단을 주지 않아 손익은 없다 (입금한 코인은 원가를 알 수도 없다).
 */
export interface CryptoHolding {
	source: "binance";
	asset: string;
	quantity: number;
	/** 지갑별 수량 (SPOT·FUNDING·EARN·EARN_LOCKED) */
	wallets: Array<{ wallet: string; quantity: number }>;
	/** USD 가격 — USDT 등 달러 스테이블 마켓 기준, 스테이블코인은 1. 못 찾으면 null */
	priceUsd: number | null;
	valueUsd: number | null;
	/** 원화 환산 — 가격·환율이 없으면 0 */
	valueKrw: number;
	/** 달러 스테이블코인 — 배분에서 현금성으로 본다 */
	stable: boolean;
	/**
	 * 평단 추정 (USD) — 현물 체결({자산}USDT·USDC·FDUSD)의 이동평균. 입금·Convert·보상으로 들어온 수량은 원가를 모른다.
	 * costCoverage = 체결로 설명되는 수량 / 보유 수량 (1 이면 전부). 손익은 체결로 설명되는 수량만큼만.
	 */
	avgPriceUsd: number | null;
	costCoverage: number | null;
	profitUsd: number | null;
	profitPct: number | null;
}

/** 직접 입력 자산 종류 — deposit 은 현금성, 나머지는 배분에서 "기타" */
export type ManualKind = "deposit" | "pension" | "real_estate" | "investment" | "other";
export const MANUAL_KINDS: readonly ManualKind[] = ["deposit", "pension", "real_estate", "investment", "other"];

/** 직접 입력 자산 — API 가 없는 곳(은행·연금·부동산·다른 거래소). 사용자가 적은 금액 그대로, 시세가 없다 */
export interface ManualAsset {
	id: string;
	name: string;
	kind: ManualKind;
	currency: "KRW" | "USD";
	amount: number;
	memo: string | null;
	/** 마지막으로 금액을 고친 때 (ISO) — 오래된 값인지 화면이 알린다 */
	updatedAt: string;
}

export interface ManualHolding extends ManualAsset {
	/** 원화 환산 — USD 인데 환율이 없으면 0 */
	valueKrw: number;
}

/** 출처(계좌)별 합계 — 계좌 카드에 쓴다. 금액은 모두 원화 환산 */
export interface SourceSummary {
	id: SourceId;
	label: string;
	/** partial = 일부 구간만 실패 (warnings) · skipped = 연결됐지만 합계에서 뺐다 (예: 테스트넷) */
	status: "ok" | "partial" | "failed" | "skipped";
	valueKrw: number;
	stockKrw: number;
	/** 원화·달러 예수금 + 스테이블코인 */
	cashKrw: number;
	/** 스테이블코인을 뺀 코인 */
	cryptoKrw: number;
	/** 직접 입력 자산 중 현금성이 아닌 것 (연금·부동산 등) */
	otherKrw: number;
	warnings: string[];
	/** failed·skipped 사유 */
	error?: string;
}

/** 자산 배분 (원화 환산) — 합계가 netWorthKrw */
export interface Allocation {
	domesticStock: number;
	overseasStock: number;
	crypto: number;
	/** 원화·달러 예수금 + 스테이블코인 + 직접 입력 예금 */
	cash: number;
	/** 직접 입력 자산 — 연금·부동산·기타 투자·기타 */
	other: number;
}

export interface PortfolioSummary {
	/** 주식 보유 (KIS·토스) — 주문·타점·점검이 보는 목록이라 코인은 따로 둔다 */
	holdings: Holding[];
	/** 실제로 조회에 성공한 증권사 */
	brokers: BrokerId[];
	/** 주식 평가금액 합계 (원화 환산) */
	stockValueKrw: number;
	/** 예수금 (원화) — 국내 계좌 기준 */
	cashKrw: number;
	/**
	 * 달러 예수금 (토스 매수가능금액 + KIS 외화출금가능금액, USD). 원화로 환산하지 않고 따로 둔다 — 미국 주식은 달러로 주문하고,
	 * 원화 예수금과 합치면 총자산·스냅샷 기록의 뜻이 바뀐다. 토스 두 금액은 서로를 포함하지 않는다 (실측, PLAN §30).
	 */
	cashUsd: number;
	/** 평가손익 합계 (원화 환산) */
	profitKrw: number;
	/** 적용한 USD/KRW 환율 */
	usdKrw: number;
	/** 환율 출처 — "토스" · "KIS" · "ECB 2026-10-02"(증권 계좌 환율이 없을 때 공개 환율). 환율이 없으면 null */
	fxSource: string | null;
	/** 조회하지 못한 구간 (예: 해외 계좌 미개설) — 사용자에게 그대로 알린다 */
	warnings: string[];

	// ── 통합 현황 (여러 계좌를 원화로 환산해 모은 값) ──
	// 위 필드(주식·원화 예수금·달러 예수금)의 뜻은 그대로 두고, 환산 합계는 여기에만 싣는다 (PLAN §30).
	/** 코인 잔고 (평가금액 순) */
	crypto: CryptoHolding[];
	/** 직접 입력 자산 (금액 순) */
	manual: ManualHolding[];
	/** 코인 평가 합계 (스테이블코인 포함, 원화 환산) */
	cryptoValueKrw: number;
	/** 총자산 — 주식 + 원화·달러 예수금 + 코인 + 직접 입력 (원화 환산). 환율이 없으면 환산 못 한 것은 빠진다 */
	netWorthKrw: number;
	allocation: Allocation;
	/** 연결된 계좌별 상태·합계 (미설정 계좌는 없다) */
	sources: SourceSummary[];
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
export function toOverseasHoldings(res: KisResponse): { holdings: Holding[]; usdKrw: number | null; cashUsd: number } {
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

	// output2 는 통화별 — 보유종목이 없어도 최초고시환율이 온다.
	// 달러 예수금은 외화출금가능금액(frcr_drwg_psbl_amt_1): 실제 외화만이다. 외화예수금액2(frcr_dncl_amt_2)는 설명이
	// "외화사용가능금액"이라 통합증거금 계좌면 원화 환산분이 섞여 원화 예수금과 두 번 셀 수 있다 (실측 전 — TODO.md)
	let cashUsd = 0;
	for (const r of rows(res.output2)) {
		if (String(r.crcy_cd ?? "") !== "USD") continue;
		cashUsd = num(r.frcr_drwg_psbl_amt_1);
		const v = numOrNull(r.frst_bltn_exrt);
		if (rate === null && v && v > 0) rate = v;
		break;
	}

	// 환율을 뒤늦게 찾았으면 원화 환산을 채운다
	if (rate !== null) {
		for (const h of holdings) {
			if (h.valueKrw === 0) h.valueKrw = Math.round(h.value * rate);
		}
	}

	return { holdings, usdKrw: rate, cashUsd };
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
