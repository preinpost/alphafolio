/**
 * MCP OAuth 클라이언트 — 서버가 사용자 대신 OAuth 클라이언트가 된다 (토큰은 서버에만 있다).
 *
 * MCP 인증 규격(2025-06-18)이 요구하는 조합:
 *   - RFC 9728 보호 리소스 메타데이터 → 인가 서버 찾기
 *   - RFC 8414 인가 서버 메타데이터 (없으면 OIDC discovery)
 *   - RFC 7591 동적 클라이언트 등록(DCR) — client_id 를 미리 발급받지 않는다
 *   - PKCE S256 필수, RFC 8707 `resource` 파라미터 (토큰이 이 MCP 서버용이라고 못박는다)
 *
 * 저장은 하지 않는다 — 호출부(서버)가 사용자별로 암호화해 보관한다.
 * 모든 요청은 주입된 fetch(net.ts safeFetch)로 나간다: 메타데이터가 알려준 주소도 사용자 입력과 같은 취급.
 */
import { createHash, randomBytes } from "node:crypto";
import { McpAuthError } from "./client.ts";
import { parseRemoteUrl, type FetchLike, type NetPolicy } from "./net.ts";

export interface AuthServerMetadata {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint?: string;
	revocation_endpoint?: string;
	scopes_supported?: string[];
	code_challenge_methods_supported?: string[];
	token_endpoint_auth_methods_supported?: string[];
}

export interface OAuthDiscovery {
	/** 토큰을 요청할 리소스 (보호 리소스 메타데이터의 resource, 없으면 MCP URL) */
	resource: string;
	authServer: AuthServerMetadata;
	/** 요청할 scope (없으면 빈 배열 — scope 파라미터를 보내지 않는다) */
	scopes: string[];
}

/** DCR 결과. public client 면 secret 이 없다 */
export interface OAuthClient {
	clientId: string;
	clientSecret?: string;
	authMethod: "none" | "client_secret_post" | "client_secret_basic";
}

export interface TokenSet {
	accessToken: string;
	refreshToken?: string;
	/** epoch ms. 서버가 expires_in 을 안 주면 없다 */
	expiresAt?: number;
	scope?: string;
}

/** 인가 서버 오류 응답 (RFC 6749 §5.2). invalid_grant = 다시 로그인해야 한다 */
export class OAuthError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, status: number, description?: string) {
		super(`OAuth 오류 ${code}${description ? ` — ${description}` : ""} (HTTP ${status})`);
		this.code = code;
		this.status = status;
	}
	/** 저장된 토큰으로는 더 이상 안 된다 (재연결 필요) */
	get needsReconnect(): boolean {
		return this.code === "invalid_grant" || this.code === "invalid_client" || this.code === "unauthorized_client";
	}
}

const TIMEOUT_MS = 15_000;

async function getJson(fetch: FetchLike, url: string): Promise<Record<string, unknown> | null> {
	try {
		const res = await fetch(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) {
			await res.body?.cancel().catch(() => undefined);
			return null;
		}
		const body = (await res.json().catch(() => null)) as unknown;
		return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** WWW-Authenticate 의 key="value" 쌍 (Bearer 파라미터) */
export function parseWwwAuthenticate(header: string | null): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const m of header.matchAll(/([a-zA-Z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
		const key = m[1];
		if (key) out[key.toLowerCase()] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
	}
	return out;
}

/** RFC 9728 §3.1 — 경로가 있으면 well-known 을 호스트 뒤에 끼운다 */
function wellKnown(base: URL, suffix: string): string[] {
	const path = base.pathname.replace(/\/$/, "");
	const out = [];
	if (path && path !== "/") out.push(`${base.origin}/.well-known/${suffix}${path}`);
	out.push(`${base.origin}/.well-known/${suffix}`);
	return out;
}

/** RFC 8414 + OIDC — 발급자 경로가 있으면 삽입형과 덧붙임형 둘 다 시도 */
function authServerCandidates(issuer: URL): string[] {
	const path = issuer.pathname.replace(/\/$/, "");
	if (!path || path === "/") {
		return [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`];
	}
	return [
		`${issuer.origin}/.well-known/oauth-authorization-server${path}`,
		`${issuer.origin}/.well-known/openid-configuration${path}`,
		`${issuer.origin}${path}/.well-known/openid-configuration`,
	];
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}
function strs(v: unknown): string[] | undefined {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

/**
 * MCP 서버 URL → 인가 서버·리소스·scope.
 * 순서: well-known 보호 리소스 메타데이터 → (없으면) 인증 없이 initialize 를 보내 401 의 resource_metadata 를 읽는다.
 */
export async function discoverOAuth(serverUrl: string, fetch: FetchLike, policy: NetPolicy): Promise<OAuthDiscovery> {
	const base = parseRemoteUrl(serverUrl, policy);
	let prm: Record<string, unknown> | null = null;
	let challengeScope: string | undefined;

	for (const u of wellKnown(base, "oauth-protected-resource")) {
		prm = await getJson(fetch, u);
		if (prm) break;
	}
	if (!prm) {
		const www = await probeChallenge(serverUrl, fetch);
		const params = parseWwwAuthenticate(www);
		challengeScope = params.scope;
		if (params.resource_metadata) prm = await getJson(fetch, parseRemoteUrl(params.resource_metadata, policy).toString());
	}

	const resource = str(prm?.resource) ?? base.toString();
	// 메타데이터가 다른 서버를 자기 리소스라고 주장하면 받지 않는다 (토큰이 엉뚱한 곳으로 가지 않게)
	if (new URL(resource).origin !== base.origin) throw new Error(`보호 리소스 메타데이터의 resource(${resource})가 MCP 서버와 다릅니다`);

	// 규격 이전 서버(2025-03-26)는 보호 리소스 메타데이터가 없고 MCP 서버 자신이 인가 서버다
	const issuer = strs(prm?.authorization_servers)?.[0] ?? base.origin;
	const issuerUrl = parseRemoteUrl(issuer, policy);
	let meta: Record<string, unknown> | null = null;
	for (const u of authServerCandidates(issuerUrl)) {
		meta = await getJson(fetch, u);
		if (meta) break;
	}
	if (!meta) throw new Error(`인가 서버 메타데이터를 찾지 못했습니다 (${issuer})`);

	const authServer: AuthServerMetadata = {
		issuer: str(meta.issuer) ?? issuer,
		authorization_endpoint: str(meta.authorization_endpoint) ?? "",
		token_endpoint: str(meta.token_endpoint) ?? "",
		...(str(meta.registration_endpoint) ? { registration_endpoint: str(meta.registration_endpoint) as string } : {}),
		...(str(meta.revocation_endpoint) ? { revocation_endpoint: str(meta.revocation_endpoint) as string } : {}),
		...(strs(meta.scopes_supported) ? { scopes_supported: strs(meta.scopes_supported) as string[] } : {}),
		...(strs(meta.code_challenge_methods_supported) ? { code_challenge_methods_supported: strs(meta.code_challenge_methods_supported) as string[] } : {}),
		...(strs(meta.token_endpoint_auth_methods_supported)
			? { token_endpoint_auth_methods_supported: strs(meta.token_endpoint_auth_methods_supported) as string[] }
			: {}),
	};
	if (!authServer.authorization_endpoint || !authServer.token_endpoint) throw new Error("인가 서버 메타데이터에 authorize/token 엔드포인트가 없습니다");
	// 엔드포인트도 원격이 알려준 주소 — 같은 URL 규칙 (https·내부 주소 금지)
	for (const e of [authServer.authorization_endpoint, authServer.token_endpoint, authServer.registration_endpoint, authServer.revocation_endpoint]) {
		if (e) parseRemoteUrl(e, policy);
	}
	const methods = authServer.code_challenge_methods_supported;
	if (methods && !methods.includes("S256")) throw new Error("인가 서버가 PKCE S256 을 지원하지 않습니다");

	const scopes = challengeScope?.split(/\s+/).filter(Boolean) ?? strs(prm?.scopes_supported) ?? authServer.scopes_supported ?? [];
	return { resource, authServer, scopes };
}

/** 인증 없이 initialize 를 보내 401 의 WWW-Authenticate 를 받는다 */
async function probeChallenge(serverUrl: string, fetch: FetchLike): Promise<string | null> {
	try {
		const res = await fetch(serverUrl, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "AlphaFolio", version: "1.0.0" } } }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		await res.body?.cancel().catch(() => undefined);
		return res.status === 401 || res.status === 403 ? res.headers.get("www-authenticate") : null;
	} catch {
		return null;
	}
}

/** RFC 7591 — public client 로 등록한다 (secret 을 줄 수 없는 서버도 있어 받으면 쓴다) */
export async function registerClient(as: AuthServerMetadata, redirectUri: string, fetch: FetchLike, clientName = "AlphaFolio"): Promise<OAuthClient> {
	if (!as.registration_endpoint) {
		throw new Error("이 인가 서버는 동적 클라이언트 등록을 지원하지 않습니다 — 미리 발급받은 client_id 가 필요해 지금은 연결할 수 없습니다");
	}
	const methods = as.token_endpoint_auth_methods_supported;
	const wantPublic = !methods || methods.includes("none");
	const res = await fetch(as.registration_endpoint, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({
			client_name: clientName,
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: wantPublic ? "none" : "client_secret_post",
		}),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok || !str(body.client_id)) {
		throw new OAuthError(str(body.error) ?? "registration_failed", res.status, str(body.error_description));
	}
	const method = str(body.token_endpoint_auth_method);
	const secret = str(body.client_secret);
	return {
		clientId: body.client_id as string,
		...(secret ? { clientSecret: secret } : {}),
		authMethod: method === "client_secret_basic" ? "client_secret_basic" : secret ? "client_secret_post" : "none",
	};
}

export interface Pkce {
	verifier: string;
	challenge: string;
}

/** RFC 7636 — verifier 43자(32바이트), challenge = base64url(sha256(verifier)) */
export function createPkce(): Pkce {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthorizeUrl(opts: {
	discovery: OAuthDiscovery;
	client: OAuthClient;
	redirectUri: string;
	state: string;
	challenge: string;
}): string {
	const url = new URL(opts.discovery.authServer.authorization_endpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", opts.client.clientId);
	url.searchParams.set("redirect_uri", opts.redirectUri);
	url.searchParams.set("state", opts.state);
	url.searchParams.set("code_challenge", opts.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("resource", opts.discovery.resource);
	if (opts.discovery.scopes.length > 0) url.searchParams.set("scope", opts.discovery.scopes.join(" "));
	return url.toString();
}

async function tokenRequest(
	endpoint: string,
	client: OAuthClient,
	form: Record<string, string>,
	fetch: FetchLike,
): Promise<Record<string, unknown>> {
	const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
	const body = new URLSearchParams(form);
	if (client.authMethod === "client_secret_basic" && client.clientSecret) {
		// RFC 6749 §2.3.1 — 각각 form-urlencode 한 뒤 base64
		const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
		headers.authorization = `Basic ${Buffer.from(`${enc(client.clientId)}:${enc(client.clientSecret)}`).toString("base64")}`;
	} else {
		body.set("client_id", client.clientId);
		if (client.authMethod === "client_secret_post" && client.clientSecret) body.set("client_secret", client.clientSecret);
	}
	const res = await fetch(endpoint, { method: "POST", headers, body: body.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
	const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) throw new OAuthError(str(json.error) ?? "token_request_failed", res.status, str(json.error_description));
	return json;
}

function toTokenSet(json: Record<string, unknown>, now: number, previousRefresh?: string): TokenSet {
	const accessToken = str(json.access_token);
	if (!accessToken) throw new OAuthError("invalid_token_response", 200, "access_token 이 없습니다");
	const tokenType = str(json.token_type);
	if (tokenType && tokenType.toLowerCase() !== "bearer") throw new OAuthError("unsupported_token_type", 200, tokenType);
	const expiresIn = Number(json.expires_in);
	const refresh = str(json.refresh_token) ?? previousRefresh;
	const scope = str(json.scope);
	return {
		accessToken,
		...(refresh ? { refreshToken: refresh } : {}),
		...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
		...(scope ? { scope } : {}),
	};
}

export async function exchangeCode(opts: {
	authServer: AuthServerMetadata;
	client: OAuthClient;
	code: string;
	verifier: string;
	redirectUri: string;
	resource: string;
	fetch: FetchLike;
	now?: number;
}): Promise<TokenSet> {
	const json = await tokenRequest(
		opts.authServer.token_endpoint,
		opts.client,
		{ grant_type: "authorization_code", code: opts.code, code_verifier: opts.verifier, redirect_uri: opts.redirectUri, resource: opts.resource },
		opts.fetch,
	);
	return toTokenSet(json, opts.now ?? Date.now());
}

/**
 * 갱신. 서버가 refresh token 을 회전(새로 발급)하면 새 값을, 아니면 기존 값을 유지한다.
 * 회전하는 서버에서 동시에 두 번 갱신하면 한쪽이 옛 refresh token 을 써서 invalid_grant 가 난다 —
 * 호출부가 사용자·서버별로 단일비행을 보장해야 한다.
 */
export async function refreshTokens(opts: {
	tokenEndpoint: string;
	client: OAuthClient;
	refreshToken: string;
	resource: string;
	fetch: FetchLike;
	now?: number;
}): Promise<TokenSet> {
	const json = await tokenRequest(
		opts.tokenEndpoint,
		opts.client,
		{ grant_type: "refresh_token", refresh_token: opts.refreshToken, resource: opts.resource },
		opts.fetch,
	);
	return toTokenSet(json, opts.now ?? Date.now(), opts.refreshToken);
}

/** RFC 7009 — 최선. 실패해도 로컬 토큰은 지운다 (호출부) */
export async function revokeToken(opts: {
	revocationEndpoint: string;
	client: OAuthClient;
	token: string;
	hint: "access_token" | "refresh_token";
	fetch: FetchLike;
}): Promise<boolean> {
	try {
		await tokenRequest(opts.revocationEndpoint, opts.client, { token: opts.token, token_type_hint: opts.hint }, opts.fetch);
		return true;
	} catch {
		return false;
	}
}

/** 인증이 필요하다는 신호인지 (401 이거나 OAuth 재연결이 필요한 오류) */
export function isAuthFailure(err: unknown): boolean {
	return err instanceof McpAuthError || (err instanceof OAuthError && err.needsReconnect);
}
