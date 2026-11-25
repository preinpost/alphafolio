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
import { localClock, localDate, MARKETS, mondayOf, SPECIAL_DAYS } from "./triggers/market-time.ts";
import { NoBrokerConfiguredError, type BrokerAccess } from "./portfolio.ts";
import { tossCandles, tossPrices } from "./toss/api.ts";
import type { TossContext } from "./toss/client.ts";
import { isCryptoPair } from "./crypto-chart.ts";

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

/** 시세로 인정할 수 있는 가격인가 — 0·음수·NaN 은 "없는 종목"의 빈 응답이다. */
export function isTradablePrice(price: number): boolean {
	return Number.isFinite(price) && price > 0;
}

export class QuoteNotFoundError extends Error {
	constructor(symbol: string) {
		super(
			`${symbol} 시세가 없습니다 — 종목코드가 틀렸거나 상장되지 않은(거래정지·상장폐지) 종목일 수 있습니다. ` +
				"지수·원자재·비상장 상품은 시세 툴 대상이 아닙니다 (원자재·지수는 data 툴 twelve).",
		);
		this.name = "QuoteNotFoundError";
	}
}

/**
 * 이 툴이 다루지 않는 심볼이면 브로커를 부르기 전에 이유를 돌려준다.
 * ^지수 는 토스 /prices 가 "요청 필드가 올바르지 않습니다" 로 거절한다 (실측 7건).
 * USDT·USDC 접미 코인은 주식 시세에 없다 — 코인은 market_technical(binance) 가 현재가·지표를 같이 준다.
 */
export function unsupportedSymbolError(symbol: string): Error | null {
	if (symbol.startsWith("^")) {
		return new Error(`${symbol} 은(는) 지수라 시세·차트 툴이 지원하지 않습니다 — 해외 지수는 data 툴(twelve)로 조회하세요.`);
	}
	if (isCryptoPair(symbol)) {
		return new Error(
			`${symbol} 은(는) 코인(Binance) 심볼입니다 — 주식 시세가 아닙니다. market_technical 에 market='binance' 로 조회하세요 (현재가·지표 함께).`,
		);
	}
	return null;
}

const BROKER_LABEL: Record<BrokerId, string> = { kis: "KIS", toss: "토스" };

interface BrokerFailure {
	id: BrokerId;
	err: unknown;
}

/**
 * 모든 브로커가 실패했을 때 돌려줄 에러. 한 곳뿐이면 그 에러를 그대로(기존 메시지 유지),
 * 여러 곳이면 **각 브로커의 사유를 전부** 합친다 — 앞 브로커의 원인(KIS 모의투자 미지원 등)이 뒤 브로커의 "찾지 못함"에 가려지지 않게.
 */
export function combineBrokerFailures(failures: BrokerFailure[], fallback: string): unknown {
	const [only] = failures;
	if (failures.length === 0) return new Error(fallback);
	if (failures.length === 1) return only?.err;
	return new Error(
		failures.map((f) => `${BROKER_LABEL[f.id]}: ${f.err instanceof Error ? f.err.message : String(f.err)}`).join(" · "),
	);
}

export async function fetchQuote(access: BrokerAccess, rawSymbol: string): Promise<QuoteResult> {
	const symbol = normalizeSymbol(rawSymbol);
	const brokers = available(access);
	if (brokers.length === 0) throw new NoBrokerConfiguredError();

	/** 시세 API 들이 종목명을 주지 않아 별도로 채운다 (names.ts 참고). */
	const withName = async (q: QuoteResult): Promise<QuoteResult> =>
		q.name && q.name !== q.symbol ? q : { ...q, name: await resolveName(access, q.symbol) };

	const unsupported = unsupportedSymbolError(symbol);
	if (unsupported) throw unsupported;

	const failures: BrokerFailure[] = [];
	for (const broker of brokers) {
		try {
			if (broker.id === "kis") {
				const q = isDomesticSymbol(symbol)
					? toDomesticQuote(await domesticPrice(broker.ctx, symbol), symbol)
					: await overseasPriceAuto(broker.ctx, symbol).then(({ data, excd }) => toOverseasQuote(data, symbol, excd));
				// KIS 는 없는 종목코드에 오류 대신 **0으로 채운 정상 응답**을 준다 (rt_cd=0, 현재가 0).
				// 성공으로 받으면 시세 0원이 화면에 뜨고, order_prepare 의 괴리율 검사가 0% 가 되어
				// 자릿수 오타 방어가 꺼진다. 다음 브로커로 넘긴다.
				if (!isTradablePrice(q.price)) {
					failures.push({ id: "kis", err: new QuoteNotFoundError(symbol) });
					continue;
				}
				return await withName({ ...q, source: "kis" });
			}

			const prices = await tossPrices(broker.ctx, [symbol]);
			const hit = prices[0];
			if (hit && Number(hit.lastPrice) > 0) return await withName({ ...toTossQuote(hit), source: "toss" });
			failures.push({ id: "toss", err: new QuoteNotFoundError(symbol) });
		} catch (err) {
			failures.push({ id: broker.id, err });
		}
	}

	throw combineBrokerFailures(failures, `시세를 찾지 못했습니다: ${symbol}`);
}

/**
 * 주식 차트의 마지막 봉이 아직 닫히지 않았는가 (정규장 기준).
 * 장중 봉은 거래량이 덜 쌓여 "20봉 평균 대비 배수" 가 낮게 나온다 — 모델이 거래량 부족으로 읽지 않게 툴이 알린다.
 * 월봉은 이번 달 봉이면 진행 중으로 본다 (월말 마지막 거래일 마감 뒤도 진행 중으로 나오지만 알림용이라 둔다).
 */
export function stockBarOpen(domestic: boolean, period: ChartPeriod, lastDate: string | undefined, now = Date.now()): boolean {
	if (!lastDate || !/^\d{8}$/.test(lastDate)) return false;
	const venue = domestic ? "krx" : "us";
	const m = MARKETS[venue];
	const { ymd: today, hm } = localClock(now, m.tz);
	const last = `${lastDate.slice(0, 4)}-${lastDate.slice(4, 6)}-${lastDate.slice(6, 8)}`;
	const beforeClose = hm < (SPECIAL_DAYS[venue][today]?.close ?? m.close);
	if (period === "D") return last === today && beforeClose;
	if (period === "M") return last.slice(0, 7) === today.slice(0, 7);
	const { weekday } = localDate(now, m.tz);
	if (weekday === 0 || weekday === 6 || (weekday === 5 && !beforeClose)) return false;
	return mondayOf(last) === mondayOf(today);
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
	const unsupported = unsupportedSymbolError(symbol);
	if (unsupported) throw unsupported;

	const failures: BrokerFailure[] = [];
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
				failures.push({ id: "toss", err: new Error(`토스에서 ${symbol} 차트를 찾지 못했습니다.`) });
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
			failures.push({ id: broker.id, err });
		}
	}

	const err = combineBrokerFailures(failures, `차트를 찾지 못했습니다: ${symbol}`);
	// 없다는 응답이면 데이터 소스 밖의 종목일 수 있다 — 다음 행동을 알려준다 (원자재·비상장·폐지 종목 실측)
	const msg = err instanceof Error ? err.message : String(err);
	if (err instanceof Error && /찾을 수 없|찾지 못|없습니다/.test(msg)) {
		err.message = `${msg}\n※ 주식 차트 소스에 없는 종목입니다 — 원자재·지수·비상장·폐지 종목일 수 있습니다 (원자재는 data 툴 twelve, 관련 ETF 티커로 다시 조회).`;
	}
	throw err;
}
