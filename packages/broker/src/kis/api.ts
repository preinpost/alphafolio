/**
 * KIS 타입드 API 래퍼 — 실제로 쓰는 것만.
 *
 * 조회 전용이다. 주문 API 는 의도적으로 넣지 않았다 (Phase 3 범위 밖 —
 * 넣으려면 확인 UX·권한 설계를 먼저 해야 한다).
 */
import { accountParams, kisGet, type KisContext, type KisResponse } from "./client.ts";

// ── 현재가 ──────────────────────────────────────────────────────────────

/** 국내주식 현재가 (FHKST01010100). */
export function domesticPrice(ctx: KisContext, symbol: string): Promise<KisResponse> {
	return kisGet(ctx, {
		label: `국내 현재가 ${symbol}`,
		path: "/uapi/domestic-stock/v1/quotations/inquire-price",
		trId: "FHKST01010100",
		query: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol },
	});
}

/** 해외 거래소 코드 — 티커만 주어졌을 때 이 순서로 찾는다. */
export const OVERSEAS_EXCHANGES = ["NAS", "NYS", "AMS"] as const;
export type OverseasExchange = (typeof OVERSEAS_EXCHANGES)[number];

/** 해외주식 현재체결가 (HHDFS00000300). */
export function overseasPrice(ctx: KisContext, symbol: string, excd: string): Promise<KisResponse> {
	return kisGet(ctx, {
		label: `해외 현재가 ${symbol}@${excd}`,
		path: "/uapi/overseas-price/v1/quotations/price",
		trId: "HHDFS00000300",
		query: { AUTH: "", EXCD: excd, SYMB: symbol },
	});
}

/**
 * 거래소를 모를 때 NAS→NYS→AMS 순으로 찾는다.
 * 미상장 거래소는 에러가 아니라 **빈 output** 을 주므로 값으로 판별한다.
 */
export async function overseasPriceAuto(
	ctx: KisContext,
	symbol: string,
): Promise<{ data: KisResponse; excd: OverseasExchange }> {
	let lastError: unknown;
	for (const excd of OVERSEAS_EXCHANGES) {
		try {
			const data = await overseasPrice(ctx, symbol, excd);
			const out = data.output as Record<string, unknown> | undefined;
			const last = out?.last;
			if (last !== undefined && String(last).trim() !== "" && Number(last) > 0) {
				return { data, excd };
			}
		} catch (err) {
			lastError = err;
		}
	}
	if (lastError) throw lastError;
	throw new Error(`해외 시세를 찾지 못했습니다: ${symbol} (NAS/NYS/AMS 모두 빈 응답 — 티커를 확인하세요)`);
}

// ── 기간별 시세 ─────────────────────────────────────────────────────────

export type ChartPeriod = "D" | "W" | "M";

function ymd(date: Date): string {
	return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

/** 국내주식 기간별시세 (FHKST03010100). 한 번에 최대 100봉. */
export function domesticChart(
	ctx: KisContext,
	symbol: string,
	period: ChartPeriod,
	opts?: { from?: string; to?: string },
): Promise<KisResponse> {
	const to = opts?.to ?? ymd(new Date());
	const spanDays = period === "D" ? 150 : period === "W" ? 900 : 3600;
	const from = opts?.from ?? ymd(new Date(Date.now() - spanDays * 86_400_000));

	return kisGet(ctx, {
		label: `국내 차트 ${symbol}`,
		path: "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
		trId: "FHKST03010100",
		query: {
			FID_COND_MRKT_DIV_CODE: "J",
			FID_INPUT_ISCD: symbol,
			FID_INPUT_DATE_1: from,
			FID_INPUT_DATE_2: to,
			FID_PERIOD_DIV_CODE: period,
			FID_ORG_ADJ_PRC: "0", // 수정주가 반영
		},
	});
}

/** 해외주식 기간별시세 (HHDFS76240000). 한 번에 최대 100행. */
export function overseasChart(
	ctx: KisContext,
	symbol: string,
	excd: string,
	period: ChartPeriod,
	opts?: { bymd?: string },
): Promise<KisResponse> {
	const gubn = period === "D" ? "0" : period === "W" ? "1" : "2";
	return kisGet(ctx, {
		label: `해외 차트 ${symbol}@${excd}`,
		path: "/uapi/overseas-price/v1/quotations/dailyprice",
		trId: "HHDFS76240000",
		query: {
			AUTH: "",
			EXCD: excd,
			SYMB: symbol,
			GUBN: gubn,
			BYMD: opts?.bymd ?? "",
			MODP: "1", // 수정주가 반영
		},
	});
}

// ── 잔고 ────────────────────────────────────────────────────────────────

/** 국내 주식잔고 (TTTC8434R / 모의 VTTC8434R). */
export function domesticBalance(ctx: KisContext): Promise<KisResponse> {
	return kisGet(ctx, {
		label: "국내 잔고",
		path: "/uapi/domestic-stock/v1/trading/inquire-balance",
		trId: ctx.creds.env === "paper" ? "VTTC8434R" : "TTTC8434R",
		query: {
			...accountParams(ctx.creds),
			AFHR_FLPR_YN: "N",
			OFL_YN: "",
			INQR_DVSN: "01",
			UNPR_DVSN: "01",
			FUND_STTL_ICLD_YN: "N",
			FNCG_AMT_AUTO_RDPT_YN: "N",
			PRCS_DVSN: "00",
			CTX_AREA_FK100: "",
			CTX_AREA_NK100: "",
		},
	});
}

/**
 * 해외주식 체결기준현재잔고 (CTRP6504R / 모의 VTRP6504R).
 *
 * 거래소별로 나눠 조회해야 하는 TTTS3012R 대신 이걸 쓴다:
 *   - NATN_CD=000 으로 **전 국가를 한 번에** 받는다 (호출 수 = 1)
 *   - 응답에 **기준환율(bass_exrt)** 이 들어 있어 원화 환산을 외부 환율 소스 없이 한다
 *
 * WCRC_FRCR_DVSN_CD=02(외화) 로 받아서 금액은 현지통화 기준으로 두고,
 * 원화 환산은 bass_exrt 로 우리가 계산한다 (필드 의미가 통화구분에 따라
 * 달라지는 걸 피하려는 의도).
 */
export function overseasBalance(ctx: KisContext): Promise<KisResponse> {
	return kisGet(ctx, {
		label: "해외 잔고",
		path: "/uapi/overseas-stock/v1/trading/inquire-present-balance",
		trId: ctx.creds.env === "paper" ? "VTRP6504R" : "CTRP6504R",
		query: {
			...accountParams(ctx.creds),
			WCRC_FRCR_DVSN_CD: "02", // 외화 기준
			NATN_CD: "000", // 전체 국가
			TR_MKET_CD: "00", // 전체 시장
			INQR_DVSN_CD: "00", // 전체
		},
	});
}

// ── 재무·컨센서스 (국내 전용) ───────────────────────────────────────────

/**
 * 국내주식 재무비율 (FHKST66430300).
 * ⚠️ FID_DIV_CLS_CODE=1 은 분기지만 **연단위 누적 합산** 기준이다
 *    (1Q→3개월, 2Q→6개월 …). 분기 단독 실적이 아니므로 해석에 주의.
 */
export function domesticFinancialRatios(ctx: KisContext, symbol: string): Promise<KisResponse> {
	return kisGet(ctx, {
		label: `재무비율 ${symbol}`,
		path: "/uapi/domestic-stock/v1/finance/financial-ratio",
		trId: "FHKST66430300",
		query: { FID_DIV_CLS_CODE: "1", fid_cond_mrkt_div_code: "J", fid_input_iscd: symbol },
	});
}

/** 국내주식 손익계산서 (FHKST66430200). 위와 같은 누적 합산 주의. */
export function domesticIncomeStatement(ctx: KisContext, symbol: string): Promise<KisResponse> {
	return kisGet(ctx, {
		label: `손익계산서 ${symbol}`,
		path: "/uapi/domestic-stock/v1/finance/income-statement",
		trId: "FHKST66430200",
		query: { FID_DIV_CLS_CODE: "1", fid_cond_mrkt_div_code: "J", fid_input_iscd: symbol },
	});
}

/**
 * 국내주식 종목추정실적 = 애널리스트 컨센서스 (HHKST668300C0).
 *
 * ⚠️ **한국투자 리서치가 커버하는 기업만** 값이 온다 (대형주 위주).
 *    중소형주는 빈 응답이 정상이며, 이를 "데이터 없음"이 아니라 "커버 안 됨"으로
 *    구분해 알려야 한다.
 */
export function domesticConsensus(ctx: KisContext, symbol: string): Promise<KisResponse> {
	return kisGet(ctx, {
		label: `컨센서스 ${symbol}`,
		path: "/uapi/domestic-stock/v1/quotations/estimate-perform",
		trId: "HHKST668300C0",
		query: { SHT_CD: symbol },
	});
}
