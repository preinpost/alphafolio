/**
 * KIS 접근 토큰 캐시 — D1 보관.
 *
 * ⚠️ 메모리에만 두면 안 된다. **KIS 는 토큰을 발급할 때마다 사용자 휴대폰으로
 *    알림톡/SMS 를 보낸다.** 컨테이너가 재시작하거나 여러 인스턴스가 뜨면
 *    문자 폭탄이 되므로 반드시 프로세스 밖에 보존한다.
 *
 * 토큰도 자격증명이므로 시크릿과 같은 방식으로 암호화한다 (다만 HKDF info 가
 * 달라서 키가 분리된다 — 한쪽 암호문을 다른 쪽으로 복호화할 수 없다).
 *
 * 메모리 캐시를 앞에 두는 이유: 토큰은 호출마다 필요한데 D1 왕복은 수십 ms 다.
 */
import { d1Query, type D1Config } from "@alphafolio/ledger";
import type { CachedToken, TokenStore } from "@alphafolio/broker";
import { decryptValue, deriveKey, encryptValue } from "./crypto.ts";

const HKDF_INFO = "broker-access-token";

export function createBrokerTokenStore(d1: () => D1Config, masterSecret: string): TokenStore {
	const key = deriveKey(masterSecret, HKDF_INFO);
	const memory = new Map<string, CachedToken>();

	return {
		async get(cacheKey) {
			const hit = memory.get(cacheKey);
			if (hit) return hit.expiresAt > Date.now() ? hit : null;

			try {
				const r = await d1Query<{ token_enc: string; expires_at: number }>(
					d1(),
					"SELECT token_enc, expires_at FROM broker_tokens WHERE cache_key = ?",
					[cacheKey],
				);
				const row = r.results[0];
				if (!row) return null;
				if (row.expires_at <= Date.now()) return null;

				const token = decryptValue(row.token_enc, key);
				const value: CachedToken = { token, expiresAt: row.expires_at };
				memory.set(cacheKey, value);
				return value;
			} catch (err) {
				// 복호화 실패(마스터 키 변경)나 D1 장애로 토큰 발급 자체를 막지는 않는다.
				// 재발급은 SMS 를 유발하므로 원인은 로그에 남긴다.
				console.warn(`[broker] 토큰 캐시 조회 실패 — 재발급합니다: ${err instanceof Error ? err.message : err}`);
				return null;
			}
		},

		async set(cacheKey, value) {
			memory.set(cacheKey, value);
			try {
				await d1Query(
					d1(),
					`INSERT INTO broker_tokens (cache_key, token_enc, expires_at, updated_at) VALUES (?, ?, ?, ?)
					 ON CONFLICT(cache_key) DO UPDATE SET
					   token_enc = excluded.token_enc,
					   expires_at = excluded.expires_at,
					   updated_at = excluded.updated_at`,
					[cacheKey, encryptValue(value.token, key), value.expiresAt, new Date().toISOString()],
				);
			} catch (err) {
				// 저장 실패해도 이번 세션은 메모리 캐시로 동작한다 (재시작 시 재발급)
				console.warn(`[broker] 토큰 캐시 저장 실패: ${err instanceof Error ? err.message : err}`);
			}
		},

		async delete(cacheKey) {
			memory.delete(cacheKey);
			try {
				await d1Query(d1(), "DELETE FROM broker_tokens WHERE cache_key = ?", [cacheKey]);
			} catch {
				/* 캐시 삭제 실패는 무시 — 다음 호출에서 어차피 재발급된다 */
			}
		},
	};
}
