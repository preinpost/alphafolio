/**
 * 국내주식 재무·컨센서스 정규화.
 *
 * KIS 응답의 함정 두 가지를 여기서 흡수한다:
 *
 * 1. **`99.99` 는 값이 아니라 "미제공" 표식이다.** 손익계산서의 감가상각비·판관비·
 *    영업외손익·특별손익이 이 값으로 온다. 그대로 쓰면 가짜 숫자가 리포트에 실린다.
 *
 * 2. **분기 데이터는 연단위 누적 합산이다** (FID_DIV_CLS_CODE=1).
 *    202603 = 1분기, 202606 = 상반기 누적. 그래서 직전 분기와 비교하면 안 되고
 *    **전년 동기(같은 월)와 비교**해야 한다.
 *
 * 컨센서스의 추정 실적 표(output2/3)는 **의도적으로 해석하지 않는다** —
 * 과거 연도는 실제와 맞는데 추정 연도(E) 값이 실제 규모와 10배 이상 어긋나
 * 단위/스펙을 신뢰할 수 없다. 틀린 추정치를 내보내느니 투자의견만 준다.
 */
import type { KisResponse } from "./kis/client.ts";

/** KIS 가 "미제공"으로 쓰는 표식. 값으로 취급하면 안 된다. */
const NOT_PROVIDED = 99.99;

function num(v: unknown): number | null {
	const s = String(v ?? "").replace(/,/g, "").trim();
	if (s === "") return null;
	const n = Number(s);
	if (!Number.isFinite(n)) return null;
	return n === NOT_PROVIDED ? null : n;
}

function rows(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/**
 * KIS 는 같은 output 을 **배열로 줄 때도 있고 객체로 줄 때도 있다.**
 * (컨센서스 output1 은 단일 객체로 온다 — 배열만 가정하면 조용히 빈 값이 되고,
 *  그게 "미커버"로 잘못 표시된다.)
 */
function one(value: unknown): Record<string, unknown> {
	if (Array.isArray(value)) return (value[0] as Record<string, unknown>) ?? {};
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export interface FinancialPeriod {
	/** 결산 년월 YYYYMM (연단위 누적 기준) */
	period: string;
	/** 억원 */
	revenue: number | null;
	operatingProfit: number | null;
	netIncome: number | null;
	/** % */
	revenueGrowth: number | null;
	operatingGrowth: number | null;
	netGrowth: number | null;
	roe: number | null;
	eps: number | null;
	bps: number | null;
	/** 부채비율 % */
	debtRatio: number | null;
	/** 유보율 % */
	reserveRatio: number | null;
}

export interface Consensus {
	/** 한국투자 리서치 커버 여부 — 미커버는 "데이터 없음"과 다르다 */
	covered: boolean;
	/**
	 * 조회 자체가 실패한 경우의 사유. 이게 있으면 covered=false 를
	 * "미커버"로 말하면 안 된다 (원인을 모르는 것과 커버 안 되는 것은 다르다).
	 */
	error: string | null;
	/** 투자의견 (예: 매수) */
	rating: string | null;
	/** 담당 애널리스트 */
	analyst: string | null;
	/** 추정 기준일 YYYYMMDD */
	estimatedAt: string | null;
}

export interface Financials {
	symbol: string;
	/** 최신 → 과거 순 */
	periods: FinancialPeriod[];
	consensus: Consensus;
	/** 전년 동기 대비 (최신 분기 기준) */
	yoy: { revenue: number | null; operatingProfit: number | null; netIncome: number | null } | null;
}

/** 재무비율 + 손익계산서를 결산년월로 합친다. */
export function mergeFinancials(
	ratios: KisResponse,
	income: KisResponse,
	limit = 8,
): FinancialPeriod[] {
	const byPeriod = new Map<string, FinancialPeriod>();

	const ensure = (period: string): FinancialPeriod => {
		let hit = byPeriod.get(period);
		if (!hit) {
			hit = {
				period,
				revenue: null,
				operatingProfit: null,
				netIncome: null,
				revenueGrowth: null,
				operatingGrowth: null,
				netGrowth: null,
				roe: null,
				eps: null,
				bps: null,
				debtRatio: null,
				reserveRatio: null,
			};
			byPeriod.set(period, hit);
		}
		return hit;
	};

	for (const r of rows(ratios.output)) {
		const period = String(r.stac_yymm ?? "");
		if (!period) continue;
		const p = ensure(period);
		p.revenueGrowth = num(r.grs);
		p.operatingGrowth = num(r.bsop_prfi_inrt);
		p.netGrowth = num(r.ntin_inrt);
		p.roe = num(r.roe_val);
		p.eps = num(r.eps);
		p.bps = num(r.bps);
		p.debtRatio = num(r.lblt_rate);
		p.reserveRatio = num(r.rsrv_rate);
	}

	for (const r of rows(income.output)) {
		const period = String(r.stac_yymm ?? "");
		if (!period) continue;
		const p = ensure(period);
		p.revenue = num(r.sale_account);
		p.operatingProfit = num(r.bsop_prti);
		p.netIncome = num(r.thtr_ntin);
	}

	return [...byPeriod.values()].sort((a, b) => b.period.localeCompare(a.period)).slice(0, limit);
}

export function parseConsensus(res: KisResponse): Consensus {
	const out = one(res.output1);
	const str = (v: unknown): string | null => {
		const s = String(v ?? "").trim();
		return s === "" || s === "0" || s === "0.00" ? null : s;
	};

	const rating = str(out.rcmd_name);
	const analyst = str(out.name1);
	const estimatedAt = str(out.estdate);

	return {
		// 커버되지 않는 종목은 output1 에 이름·의견이 비어서 온다 (rt_cd 는 정상 0)
		covered: Boolean(rating ?? analyst ?? estimatedAt),
		error: null,
		rating,
		analyst,
		estimatedAt,
	};
}

/** 조회 실패 — "미커버"와 구분해서 전달한다. */
export function consensusError(message: string): Consensus {
	return { covered: false, error: message, rating: null, analyst: null, estimatedAt: null };
}

/**
 * 전년 동기 대비 증감률.
 *
 * 분기 값이 연단위 누적이라 직전 분기와 비교하면 의미가 없다 —
 * 같은 월(예: 202606 vs 202506)끼리 비교해야 한다.
 */
export function yoyChange(
	periods: FinancialPeriod[],
): { revenue: number | null; operatingProfit: number | null; netIncome: number | null } | null {
	const latest = periods[0];
	if (!latest || latest.period.length !== 6) return null;

	const year = Number(latest.period.slice(0, 4));
	const month = latest.period.slice(4);
	const prior = periods.find((p) => p.period === `${year - 1}${month}`);
	if (!prior) return null;

	const pct = (now: number | null, before: number | null): number | null => {
		if (now === null || before === null || before === 0) return null;
		// 적자 → 흑자처럼 부호가 바뀌면 증감률이 의미를 잃는다
		if (before < 0) return null;
		return Math.round(((now - before) / before) * 1000) / 10;
	};

	return {
		revenue: pct(latest.revenue, prior.revenue),
		operatingProfit: pct(latest.operatingProfit, prior.operatingProfit),
		netIncome: pct(latest.netIncome, prior.netIncome),
	};
}

/** 억원 단위 금액을 읽기 좋게 (1조 이상은 조 단위). */
export function formatEok(value: number | null): string {
	if (value === null) return "—";
	const abs = Math.abs(value);
	if (abs >= 10_000) return `${(value / 10_000).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}조원`;
	return `${Math.round(value).toLocaleString("ko-KR")}억원`;
}
