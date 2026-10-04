/**
 * 공개 환율 — 증권 계좌(토스·KIS)에서 환율을 얻지 못했을 때만 쓰는 대체 출처.
 *
 * Frankfurter (ECB 기준환율, 키 없음, 영업일 하루 한 번 갱신): `GET https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW`
 * → `{ amount: 1, base: "USD", date: "2026-10-02", rates: { KRW: 1348.28 } }` (실측 2026-10-04).
 * 실시간이 아니라 전 영업일 값이라 화면에 기준일을 밝힌다. 1시간 캐시, 실패는 캐시하지 않는다.
 */
const URL_ = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW";
const TTL = 60 * 60_000;

let cache: { at: number; v: { rate: number; date: string } } | null = null;

export async function publicUsdKrw(now = Date.now()): Promise<{ rate: number; date: string } | null> {
	if (cache && now - cache.at < TTL) return cache.v;
	try {
		const res = await fetch(URL_, { signal: AbortSignal.timeout(5_000) });
		if (!res.ok) return null;
		const body = (await res.json()) as { date?: string; rates?: { KRW?: number } };
		const rate = Number(body.rates?.KRW);
		if (!Number.isFinite(rate) || rate <= 0) return null;
		const v = { rate, date: String(body.date ?? "") };
		cache = { at: now, v };
		return v;
	} catch {
		return null;
	}
}

/** 테스트 */
export function clearPublicFxCache(): void {
	cache = null;
}
