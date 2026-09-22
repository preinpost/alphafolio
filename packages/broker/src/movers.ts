/**
 * 시장 랭킹 — 거래대금·거래량·상승률·하락률 상위.
 *
 * "오늘 뭐가 주도했어?" 같은 질문에 답하는 경로다. 토스 `/api/v1/rankings` 한 번이면
 * 되고, 종목명은 별도로 해석한다 (랭킹 응답에 이름이 없다).
 *
 * ⚠️ **섹터/테마 랭킹 API 는 없다.** 종목 단위 랭킹만 제공하므로, 섹터는
 *    상위 종목 구성을 보고 사람이/모델이 판단해야 한다. 이 한계를 숨기지 않는다.
 */
import { resolveNames, type NameResolverAccess } from "./names.ts";
import { tossGet, type TossContext } from "./toss/client.ts";

export const MOVER_TYPES = ["trading_amount", "trading_volume", "gainers", "losers"] as const;
export type MoverType = (typeof MOVER_TYPES)[number];

const TOSS_TYPE: Record<MoverType, string> = {
	trading_amount: "MARKET_TRADING_AMOUNT",
	trading_volume: "MARKET_TRADING_VOLUME",
	gainers: "TOP_GAINERS",
	losers: "TOP_LOSERS",
};

export const MOVER_DURATIONS = ["realtime", "1d", "1w", "1mo", "3mo", "6mo", "1y"] as const;
export type MoverDuration = (typeof MOVER_DURATIONS)[number];

interface RawRankingItem {
	rank: number;
	symbol: string;
	currency: string;
	price: { lastPrice: string; basePrice: string; changeRate: string };
	tradingVolume: string;
	tradingAmount: string;
}

export interface Mover {
	rank: number;
	symbol: string;
	name: string;
	currency: "KRW" | "USD";
	price: number;
	/** 등락률 % (토스는 소수비율로 준다 — 여기서 퍼센트로 바꾼다) */
	changePct: number;
	tradingAmount: number;
	tradingVolume: number;
}

export interface MoversResult {
	type: MoverType;
	market: "KR" | "US";
	duration: MoverDuration;
	/** 랭킹 집계 기준 시각 (없으면 null) */
	rankedAt: string | null;
	movers: Mover[];
	/** 요청과 다른 기간으로 대체된 경우의 안내 */
	note?: string;
}

/**
 * 타입별 기본 기간.
 * ⚠️ `TOP_GAINERS`/`TOP_LOSERS` 는 **realtime 을 지원하지 않는다**
 *    (지정하면 400 unsupported-ranking-duration). 그래서 등락률 랭킹은 1d 가 기본이다.
 */
function defaultDuration(type: MoverType): MoverDuration {
	return type === "gainers" || type === "losers" ? "1d" : "realtime";
}

function num(v: unknown): number {
	const n = Number(String(v ?? "").replace(/,/g, ""));
	return Number.isFinite(n) ? n : 0;
}

export async function fetchMovers(
	ctx: TossContext,
	names: NameResolverAccess,
	opts: { type: MoverType; market: "KR" | "US"; duration?: MoverDuration; count?: number },
): Promise<MoversResult> {
	const requested = opts.duration ?? defaultDuration(opts.type);

	// 등락률 랭킹에 realtime 이 들어오면 에러 대신 1d 로 바꾸고 알린다
	const unsupported = requested === "realtime" && (opts.type === "gainers" || opts.type === "losers");
	const duration: MoverDuration = unsupported ? "1d" : requested;
	const note = unsupported ? "등락률 랭킹은 실시간을 지원하지 않아 1일 기준으로 조회했습니다." : undefined;

	const count = Math.min(Math.max(opts.count ?? 10, 1), 30);

	const res = await tossGet<{ rankedAt: string | null; rankings: RawRankingItem[] }>(ctx, "/api/v1/rankings", {
		query: {
			type: TOSS_TYPE[opts.type],
			marketCountry: opts.market,
			duration,
			count,
			excludeInvestmentCaution: true,
		},
		group: "MARKET_DATA",
	});

	const items = res.rankings ?? [];
	const nameMap = await resolveNames(names, items.map((r) => r.symbol));

	const movers: Mover[] = items.map((r) => ({
		rank: r.rank,
		symbol: r.symbol,
		name: nameMap.get(r.symbol.toUpperCase()) ?? r.symbol,
		currency: String(r.currency ?? "KRW").toUpperCase() === "KRW" ? "KRW" : "USD",
		price: num(r.price?.lastPrice),
		changePct: Math.round(num(r.price?.changeRate) * 10000) / 100,
		tradingAmount: num(r.tradingAmount),
		tradingVolume: num(r.tradingVolume),
	}));

	return {
		type: opts.type,
		market: opts.market,
		duration,
		rankedAt: res.rankedAt ?? null,
		movers,
		...(note ? { note } : {}),
	};
}
