/** 토스증권 — 보유 종목 + 원화·달러 예수금 + 실시간 환율. */
import { toTossHoldings, type Holding } from "../normalize.ts";
import { defaultAccountSeq, tossBuyingPower, tossExchangeRate, tossHoldings } from "../toss/api.ts";
import type { TossContext } from "../toss/client.ts";
import { reason, type AssetSource, type SourceResult } from "./types.ts";

async function fetchToss(ctx: TossContext): Promise<SourceResult> {
	const warnings: string[] = [];
	const seq = await defaultAccountSeq(ctx);

	const [holdingsRes, cashRes, usdCashRes, rateRes] = await Promise.allSettled([
		tossHoldings(ctx, seq),
		tossBuyingPower(ctx, seq, "KRW"),
		tossBuyingPower(ctx, seq, "USD"),
		tossExchangeRate(ctx),
	]);

	let usdKrw = 0;
	if (rateRes.status === "fulfilled") {
		const r = Number(rateRes.value.midRate ?? rateRes.value.rate);
		if (Number.isFinite(r) && r > 0) usdKrw = r;
	}

	let holdings: Holding[] = [];
	if (holdingsRes.status === "fulfilled") {
		holdings = toTossHoldings(holdingsRes.value, usdKrw);
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

	return { holdings, crypto: [], manual: [], cashKrw, cashUsd, usdKrw, warnings };
}

export const tossSource: AssetSource = {
	id: "toss",
	label: "토스",
	connect(access) {
		if (!access.toss) return null;
		const ctx = access.toss();
		return { run: () => fetchToss(ctx) };
	},
};
