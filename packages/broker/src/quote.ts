/**
 * 시세 조회 — 증권사·시장 자동 선택.
 *
 * 심볼만 주면 어느 시장인지 판단한다:
 *   - 숫자 6자리  → 국내 (예: 005930)
 *   - 그 외 영문  → 해외 (KIS 는 NAS→NYS→AMS 순으로 탐색)
 *
 * 증권사는 **KIS 우선, 실패하면 토스**다. KIS 가 PER·PBR·52주·전일대비까지 주는 반면
 * 토스 `/api/v1/prices` 는 현재가만 주기 때문이다. 둘 다 없으면 설정 안내로 실패한다.
 */
import {
	domesticChart,
	domesticPrice,
	overseasChart,
	overseasPriceAuto,
	type ChartPeriod,
} from "./kis/api.ts";
import type { KisContext } from "./kis/client.ts";
import {
	toDomesticBars,
	toDomesticQuote,
	toOverseasBars,
	toOverseasQuote,
	toTossBars,
	toTossQuote,
	type Bar,
	type BrokerId,
	type Quote,
} from "./normalize.ts";
import { resolveName } from "./names.ts";
import { NoBrokerConfiguredError, type BrokerAccess } from "./portfolio.ts";
import { tossCandles, tossPrices } from "./toss/api.ts";
import type { TossContext } from "./toss/client.ts";

export function isDomesticSymbol(symbol: string): boolean {
	return /^\d{6}$/.test(symbol.trim());
}

export function normalizeSymbol(symbol: string): string {
	return symbol.trim().toUpperCase();
}

/** 설정된 증권사 컨텍스트를 순서대로 돌려준다 (미설정은 건너뛴다). */
function available(access: BrokerAccess): Array<
	{ id: "kis"; ctx: KisContext } | { id: "toss"; ctx: TossContext }
> {
	const out: Array<{ id: "kis"; ctx: KisContext } | { id: "toss"; ctx: TossContext }> = [];
	if (access.kis) {
		try {
			out.push({ id: "kis", ctx: access.kis() });
		} catch {
			/* 미설정 */
		}
	}
	if (access.toss) {
		try {
			out.push({ id: "toss", ctx: access.toss() });
		} catch {
			/* 미설정 */
		}
	}
	return out;
}

export interface QuoteResult extends Quote {
	/** 어느 증권사 시세인지 — 토스는 등락 정보가 없어 UI 표시가 달라진다 */
	source: BrokerId;
}

export async function fetchQuote(access: BrokerAccess, rawSymbol: string): Promise<QuoteResult> {
	const symbol = normalizeSymbol(rawSymbol);
	const brokers = available(access);
	if (brokers.length === 0) throw new NoBrokerConfiguredError();

	/** 시세 API 들이 종목명을 주지 않아 별도로 채운다 (names.ts 참고). */
	const withName = async (q: QuoteResult): Promise<QuoteResult> =>
		q.name && q.name !== q.symbol ? q : { ...q, name: await resolveName(access, q.symbol) };

	let lastError: unknown;
	for (const broker of brokers) {
		try {
			if (broker.id === "kis") {
				if (isDomesticSymbol(symbol)) {
					return await withName({ ...toDomesticQuote(await domesticPrice(broker.ctx, symbol), symbol), source: "kis" });
				}
				const { data, excd } = await overseasPriceAuto(broker.ctx, symbol);
				return await withName({ ...toOverseasQuote(data, symbol, excd), source: "kis" });
			}

			const prices = await tossPrices(broker.ctx, [symbol]);
			const hit = prices[0];
			if (hit && Number(hit.lastPrice) > 0) return await withName({ ...toTossQuote(hit), source: "toss" });
			lastError = new Error(`토스에서 ${symbol} 시세를 찾지 못했습니다.`);
		} catch (err) {
			lastError = err;
		}
	}

	throw lastError ?? new Error(`시세를 찾지 못했습니다: ${symbol}`);
}

export interface ChartResult {
	symbol: string;
	name: string;
	market: "domestic" | "overseas";
	period: ChartPeriod;
	bars: Bar[];
	source: BrokerId;
	/** 요청과 다른 봉 단위로 대체된 경우의 안내 (토스는 일봉만 지원). */
	note?: string;
}

export async function fetchChart(
	access: BrokerAccess,
	rawSymbol: string,
	period: ChartPeriod,
): Promise<ChartResult> {
	const symbol = normalizeSymbol(rawSymbol);
	const brokers = available(access);
	if (brokers.length === 0) throw new NoBrokerConfiguredError();

	let lastError: unknown;
	for (const broker of brokers) {
		try {
			if (broker.id === "kis") {
				if (isDomesticSymbol(symbol)) {
					const res = await domesticChart(broker.ctx, symbol, period);
					// output1 에 종목명이 들어 있다 (요약 객체)
					const summary = (Array.isArray(res.output1) ? res.output1[0] : res.output1) as
						| Record<string, unknown>
						| undefined;
					return {
						symbol,
						name: String(summary?.hts_kor_isnm ?? symbol),
						market: "domestic",
						period,
						bars: toDomesticBars(res),
						source: "kis",
					};
				}

				// 해외는 차트 API 에 거래소가 필요해서 현재가로 먼저 거래소를 찾는다
				const { excd } = await overseasPriceAuto(broker.ctx, symbol);
				const res = await overseasChart(broker.ctx, symbol, excd, period);
				return {
					symbol,
					name: await resolveName(access, symbol),
					market: "overseas",
					period,
					bars: toOverseasBars(res),
					source: "kis",
				};
			}

			// 토스는 일봉/1분봉만 있다 — 주·월봉 요청은 일봉으로 대체하고 알린다
			const page = await tossCandles(broker.ctx, symbol, { interval: "1d", count: 200 });
			const bars = toTossBars(page.candles);
			if (bars.length === 0) {
				lastError = new Error(`토스에서 ${symbol} 차트를 찾지 못했습니다.`);
				continue;
			}
			return {
				symbol,
				name: await resolveName(access, symbol),
				market: isDomesticSymbol(symbol) ? "domestic" : "overseas",
				period: "D",
				bars,
				source: "toss",
				note: period === "D" ? undefined : "토스는 일봉만 제공해 일봉으로 조회했습니다.",
			};
		} catch (err) {
			lastError = err;
		}
	}

	throw lastError ?? new Error(`차트를 찾지 못했습니다: ${symbol}`);
}
