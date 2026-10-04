/** 한국투자증권 — 국내·해외 잔고. */
import { domesticBalance, overseasBalance } from "../kis/api.ts";
import type { KisContext } from "../kis/client.ts";
import { toDomesticHoldings, toOverseasHoldings, type Holding } from "../normalize.ts";
import { emptyResult, reason, type AssetSource, type SourceResult } from "./types.ts";

async function fetchKis(ctx: KisContext): Promise<SourceResult> {
	const warnings: string[] = [];

	// 두 호출은 독립이므로 병렬로 — 레이트 리밋은 client 가 앱키 단위로 잡는다
	const [domestic, overseas] = await Promise.allSettled([domesticBalance(ctx), overseasBalance(ctx)]);

	let holdings: Holding[] = [];
	let cashKrw = 0;
	let cashUsd = 0;
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
		cashUsd = parsed.cashUsd;
	} else {
		warnings.push(`KIS 해외 잔고를 불러오지 못했습니다: ${reason(overseas.reason)}`);
	}

	return { ...emptyResult(), holdings, cashKrw, cashUsd, usdKrw, warnings };
}

export const kisSource: AssetSource = {
	id: "kis",
	label: "KIS",
	connect(access) {
		if (!access.kis) return null;
		const ctx = access.kis();
		return { run: () => fetchKis(ctx) };
	},
};
