/**
 * 포트폴리오 집계 — 여러 증권사 잔고를 합쳐 원화 기준으로 정리한다.
 *
 * 한 곳이 실패해도(계좌 미개설, 권한 없음 등) 전체를 실패시키지 않는다.
 * 대신 warnings 에 담아 **무엇이 빠졌는지 그대로 알린다** — 조용히 0원으로
 * 처리하면 자산이 줄어든 것처럼 보여서 더 위험하다.
 *
 * 설정하지 않은 증권사는 경고를 내지 않는다 (안 쓰는 브로커를 매번 알릴 이유가 없다).
 */
import { domesticBalance, overseasBalance } from "./kis/api.ts";
import type { KisContext } from "./kis/client.ts";
import {
	toDomesticHoldings,
	toOverseasHoldings,
	toTossHoldings,
	type BrokerId,
	type Holding,
	type PortfolioSummary,
} from "./normalize.ts";
import { defaultAccountSeq, tossBuyingPower, tossExchangeRate, tossHoldings } from "./toss/api.ts";
import type { TossContext } from "./toss/client.ts";

/**
 * 사용 가능한 증권사 접근자. **설정된 것만** 넘긴다.
 * 컨텍스트 생성이 호출 시점에 일어나므로, 사용자가 키를 나중에 넣어도 재시작이 필요 없다.
 */
export interface BrokerAccess {
	kis?: () => KisContext;
	toss?: () => TossContext;
	/** Binance 현물 — 거래(binance_order)에만 쓴다. 키가 없으면 만들 때 throw */
	binance?: () => { key: string; secret: string; testnet?: boolean };
}

export class NoBrokerConfiguredError extends Error {
	constructor() {
		super(
			"연결된 증권 계정이 없습니다. 설정 화면의 '증권 (KIS)' 또는 '증권 (토스)' 에서 키를 입력하세요. " +
				"키는 사용자별로 저장됩니다.",
		);
		this.name = "NoBrokerConfiguredError";
	}
}

function reason(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface BrokerResult {
	holdings: Holding[];
	cashKrw: number;
	/** KIS 는 지금 쓰는 잔고 API 에 외화 예수금이 없어 0 (TODO) */
	cashUsd: number;
	usdKrw: number;
	warnings: string[];
}

async function fetchKis(ctx: KisContext): Promise<BrokerResult> {
	const warnings: string[] = [];

	// 두 호출은 독립이므로 병렬로 — 레이트 리밋은 client 가 앱키 단위로 잡는다
	const [domestic, overseas] = await Promise.allSettled([domesticBalance(ctx), overseasBalance(ctx)]);

	let holdings: Holding[] = [];
	let cashKrw = 0;
	let usdKrw = 0;

	if (domestic.status === "fulfilled") {
		const parsed = toDomesticHoldings(domestic.value);
		holdings = holdings.concat(parsed.holdings);
		cashKrw = parsed.cashKrw;
	} else {
		warnings.push(`KIS 국내 잔고를 불러오지 못했습니다: ${reason(domestic.reason)}`);
	}

	if (overseas.status === "fulfilled") {
		const parsed = toOverseasHoldings(overseas.value);
		holdings = holdings.concat(parsed.holdings);
		if (parsed.usdKrw) usdKrw = parsed.usdKrw;
		else if (parsed.holdings.length > 0) {
			warnings.push("KIS 해외 보유종목의 환율을 찾지 못해 원화 환산이 빠졌습니다.");
		}
	} else {
		warnings.push(`KIS 해외 잔고를 불러오지 못했습니다: ${reason(overseas.reason)}`);
	}

	return { holdings, cashKrw, cashUsd: 0, usdKrw, warnings };
}

async function fetchToss(ctx: TossContext): Promise<BrokerResult> {
	const warnings: string[] = [];
	const seq = await defaultAccountSeq(ctx);

	const [holdingsRes, cashRes, usdCashRes, rateRes] = await Promise.allSettled([
		tossHoldings(ctx, seq),
		tossBuyingPower(ctx, seq, "KRW"),
		tossBuyingPower(ctx, seq, "USD"),
		tossExchangeRate(ctx),
	]);

	// 환율을 먼저 확보해야 USD 종목을 원화로 환산할 수 있다
	let usdKrw = 0;
	if (rateRes.status === "fulfilled") {
		const r = Number(rateRes.value.midRate ?? rateRes.value.rate);
		if (Number.isFinite(r) && r > 0) usdKrw = r;
	}

	let holdings: Holding[] = [];
	if (holdingsRes.status === "fulfilled") {
		holdings = toTossHoldings(holdingsRes.value, usdKrw);
		if (usdKrw === 0 && holdings.some((h) => h.currency === "USD")) {
			warnings.push("토스 환율 조회에 실패해 해외 종목의 원화 환산이 빠졌습니다.");
		}
	} else {
		warnings.push(`토스 보유종목을 불러오지 못했습니다: ${reason(holdingsRes.reason)}`);
	}

	let cashKrw = 0;
	if (cashRes.status === "fulfilled") {
		const c = Number(cashRes.value.cashBuyingPower);
		if (Number.isFinite(c)) cashKrw = c;
	} else {
		warnings.push(`토스 예수금을 불러오지 못했습니다: ${reason(cashRes.reason)}`);
	}

	let cashUsd = 0;
	if (usdCashRes.status === "fulfilled") {
		const c = Number(usdCashRes.value.cashBuyingPower);
		if (Number.isFinite(c)) cashUsd = c;
	} else {
		warnings.push(`토스 달러 예수금을 불러오지 못했습니다: ${reason(usdCashRes.reason)}`);
	}

	return { holdings, cashKrw, cashUsd, usdKrw, warnings };
}

export async function fetchPortfolio(access: BrokerAccess): Promise<PortfolioSummary> {
	const tasks: Array<{ id: BrokerId; run: Promise<BrokerResult> }> = [];

	// 컨텍스트 생성 자체가 throw 할 수 있다(자격증명 누락) — 그건 "미설정"으로 본다
	if (access.kis) {
		try {
			tasks.push({ id: "kis", run: fetchKis(access.kis()) });
		} catch {
			/* 미설정 — 경고하지 않는다 */
		}
	}
	if (access.toss) {
		try {
			tasks.push({ id: "toss", run: fetchToss(access.toss()) });
		} catch {
			/* 미설정 */
		}
	}

	if (tasks.length === 0) throw new NoBrokerConfiguredError();

	const settled = await Promise.allSettled(tasks.map((t) => t.run));

	let holdings: Holding[] = [];
	let cashKrw = 0;
	let cashUsd = 0;
	let usdKrw = 0;
	const warnings: string[] = [];
	const brokers: BrokerId[] = [];

	settled.forEach((result, i) => {
		const id = tasks[i]!.id;
		if (result.status === "rejected") {
			warnings.push(`${id === "kis" ? "KIS" : "토스"} 조회 실패: ${reason(result.reason)}`);
			return;
		}
		brokers.push(id);
		holdings = holdings.concat(result.value.holdings);
		cashKrw += result.value.cashKrw;
		cashUsd += result.value.cashUsd;
		if (result.value.usdKrw > 0 && usdKrw === 0) usdKrw = result.value.usdKrw;
		warnings.push(...result.value.warnings);
	});

	// 한쪽에서만 환율을 얻었으면 아직 환산되지 않은 해외 종목에 적용한다
	if (usdKrw > 0) {
		for (const h of holdings) {
			if (h.valueKrw === 0 && h.currency === "USD") h.valueKrw = Math.round(h.value * usdKrw);
		}
	}

	const stockValueKrw = holdings.reduce((s, h) => s + h.valueKrw, 0);
	const profitKrw = holdings.reduce(
		(s, h) => s + (h.currency === "USD" ? Math.round(h.profit * usdKrw) : h.profit),
		0,
	);

	holdings.sort((a, b) => b.valueKrw - a.valueKrw);

	// 달러는 센트 단위로 (합산 부동소수점 잡음 제거)
	cashUsd = Math.round(cashUsd * 100) / 100;

	return { holdings, brokers, stockValueKrw, cashKrw, cashUsd, profitKrw, usdKrw, warnings };
}
