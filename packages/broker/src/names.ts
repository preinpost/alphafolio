/**
 * 종목명 해석.
 *
 * 왜 필요한가: 시세·랭킹 API 들이 **종목명을 주지 않는다.**
 *   - KIS 현재가(FHKST01010100): 업종명은 있지만 종목명이 없다
 *   - 토스 /api/v1/prices, /api/v1/rankings: 심볼만 준다
 * 그대로 두면 화면에 "005930" 이 뜬다.
 *
 * 해석 순서:
 *   1. 토스 `/api/v1/stocks` — 한 번에 200개, 국내·해외 모두 한글명 (애플 등). 가장 싸다.
 *   2. KIS `search-stock-info` — 국내만, 1건씩. 토스를 안 쓰는 사용자용 폴백.
 *
 * 종목명은 거의 바뀌지 않으므로 프로세스 메모리에 캐시한다.
 */
import { kisGet, type KisContext } from "./kis/client.ts";
import { tossGet, type TossContext } from "./toss/client.ts";

const cache = new Map<string, string>();

export interface NameResolverAccess {
	kis?: () => KisContext;
	toss?: () => TossContext;
}

interface TossStockInfo {
	symbol: string;
	name?: string;
	englishName?: string;
}

async function fromToss(ctx: TossContext, symbols: string[]): Promise<void> {
	// 200개 제한 — 넘으면 나눠 부른다
	for (let i = 0; i < symbols.length; i += 200) {
		const batch = symbols.slice(i, i + 200);
		const rows = await tossGet<TossStockInfo[]>(ctx, "/api/v1/stocks", {
			query: { symbols: batch.join(",") },
			group: "MARKET_DATA",
		});
		for (const r of rows ?? []) {
			const name = r.name ?? r.englishName;
			if (r.symbol && name) cache.set(r.symbol.toUpperCase(), name);
		}
	}
}

async function fromKis(ctx: KisContext, symbol: string): Promise<void> {
	// 국내 6자리만 지원 (해외 종목명 조회 API 는 별도 체계라 여기서 다루지 않는다)
	if (!/^\d{6}$/.test(symbol)) return;

	const res = await kisGet(ctx, {
		label: `종목정보 ${symbol}`,
		path: "/uapi/domestic-stock/v1/quotations/search-stock-info",
		trId: "CTPF1002R",
		query: { PRDT_TYPE_CD: "300", PDNO: symbol },
	});
	const out = (Array.isArray(res.output) ? res.output[0] : res.output) as Record<string, unknown> | undefined;
	const name = out?.prdt_abrv_name ?? out?.prdt_name;
	if (typeof name === "string" && name.trim()) cache.set(symbol, name.trim());
}

/**
 * 심볼 → 종목명 맵. 찾지 못한 심볼은 맵에 없다 (호출부가 심볼로 폴백한다).
 * 이름 해석 실패가 본래 조회를 실패시키면 안 되므로 모든 오류를 삼킨다.
 */
export async function resolveNames(
	access: NameResolverAccess,
	rawSymbols: string[],
): Promise<Map<string, string>> {
	const symbols = [...new Set(rawSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
	const missing = symbols.filter((s) => !cache.has(s));

	if (missing.length > 0 && access.toss) {
		try {
			await fromToss(access.toss(), missing);
		} catch {
			/* 이름은 부가 정보다 — 실패해도 조회 자체는 살린다 */
		}
	}

	const stillMissing = symbols.filter((s) => !cache.has(s));
	if (stillMissing.length > 0 && access.kis) {
		try {
			const ctx = access.kis();
			// KIS 는 1건씩이라 과한 호출을 막기 위해 소량만 시도한다
			for (const s of stillMissing.slice(0, 10)) await fromKis(ctx, s);
		} catch {
			/* 폴백도 실패하면 심볼을 그대로 쓴다 */
		}
	}

	const out = new Map<string, string>();
	for (const s of symbols) {
		const hit = cache.get(s);
		if (hit) out.set(s, hit);
	}
	return out;
}

/** 단일 심볼 편의 함수. 못 찾으면 심볼을 그대로 돌려준다. */
export async function resolveName(access: NameResolverAccess, symbol: string): Promise<string> {
	const key = symbol.trim().toUpperCase();
	const map = await resolveNames(access, [key]);
	return map.get(key) ?? symbol;
}
