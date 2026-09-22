/**
 * KIS 접근 토큰 — 발급·캐시.
 *
 * ⚠️ **토큰 발급은 사용자 휴대폰으로 알림톡/SMS 를 보낸다.**
 *    컨테이너가 재시작할 때마다 재발급하면 문자 폭탄이 되므로, 캐시는 반드시
 *    프로세스 밖(서버는 D1)에 보존한다. 그래서 TokenStore 를 주입받는다.
 *
 * 캐시 키는 `${소유자}:${env}:${appKey 해시}` — 사용자가 키를 교체하면
 * 해시가 달라져 옛 토큰을 재사용하지 않는다.
 */
import { createHash } from "node:crypto";
import { baseUrl, KisError, type KisCredentials, type KisEnv } from "./types.ts";
import { issueOnce, type CachedToken, type TokenStore } from "../tokens.ts";

export type { CachedToken, TokenStore } from "../tokens.ts";
export { memoryTokenStore } from "../tokens.ts";

export function appKeyHash(appKey: string): string {
	return createHash("sha256").update(appKey).digest("hex").slice(0, 16);
}

export function tokenKey(owner: string, env: KisEnv, appKey: string): string {
	return `kis:${owner}:${env}:${appKeyHash(appKey)}`;
}

async function issueToken(creds: KisCredentials, store: TokenStore, key: string): Promise<string> {
	const res = await fetch(`${baseUrl(creds.env)}/oauth2/tokenP`, {
		method: "POST",
		headers: { "content-type": "application/json; charset=UTF-8" },
		body: JSON.stringify({
			grant_type: "client_credentials",
			appkey: creds.appKey,
			appsecret: creds.appSecret,
		}),
	});

	const text = await res.text();
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new KisError(`토큰 발급 실패 (HTTP ${res.status}): ${text.slice(0, 200)}`, {
			status: res.status,
			api: "oauth2/tokenP",
		});
	}

	const token = json.access_token;
	if (typeof token !== "string" || !token) {
		const code = typeof json.error_code === "string" ? json.error_code : undefined;
		throw new KisError(
			`토큰 발급 실패: ${typeof json.error_description === "string" ? json.error_description : text.slice(0, 200)}`,
			{ status: res.status, code, api: "oauth2/tokenP" },
		);
	}

	const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 86_400;
	await store.set(key, { token, expiresAt: Date.now() + (expiresIn - 60) * 1000 });
	return token;
}

/** 유효한 토큰을 돌려준다. 캐시가 살아 있으면 재발급하지 않는다. */
export async function getToken(creds: KisCredentials, store: TokenStore, owner: string): Promise<string> {
	const key = tokenKey(owner, creds.env, creds.appKey);

	const cached = await store.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.token;

	return issueOnce(key, () => issueToken(creds, store, key));
}

/** 토큰이 서버에서 거부됐을 때 캐시를 버린다 (다음 호출에서 재발급). */
export async function invalidateToken(
	creds: KisCredentials,
	store: TokenStore,
	owner: string,
): Promise<void> {
	await store.delete(tokenKey(owner, creds.env, creds.appKey));
}
