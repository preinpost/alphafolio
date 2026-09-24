/**
 * MCP OAuth — 서버가 사용자 대신 OAuth 클라이언트가 된다 (PLAN §38).
 *
 *   설정 화면 [연결] → POST /api/mcp/servers/:id/oauth/start (인증된 요청 — 사용자에 묶인 state·PKCE 를 메모리에, 10분)
 *     → 브라우저가 인가 서버로 이동 (TradingView 로그인·동의)
 *     → GET /api/mcp/oauth/callback?code&state (공개 경로 — state 가 곧 사용자 확인. 1회용)
 *     → 코드 교환 → 토큰을 사용자별로 암호화 저장 → 설정 화면(웹) 또는 완료 페이지(앱)
 *
 * start 를 GET 리다이렉트가 아니라 POST + URL 반환으로 둔 이유: 인증이 Bearer 헤더라 브라우저 이동으로는 사용자를 알 수 없다.
 *
 * 갱신: 만료 60초 전이면 호출 전에, 401 이면 한 번 강제로. **사용자·서버별 단일비행** —
 * refresh token 을 회전하는 서버에서 동시에 두 번 갱신하면 늦은 쪽이 폐기된 토큰을 써서 연결이 통째로 끊긴다.
 * 갱신이 invalid_grant 면 토큰을 지우고 "다시 연결" 상태로 둔다. 네트워크 오류는 토큰을 지우지 않는다.
 */
import { randomBytes } from "node:crypto";
import {
	buildAuthorizeUrl,
	createPkce,
	discoverOAuth,
	exchangeCode,
	McpNeedsAuthError,
	OAuthError,
	refreshTokens,
	registerClient,
	revokeToken,
	type FetchLike,
	type NetPolicy,
	type OAuthClient,
	type OAuthDiscovery,
} from "@alphafolio/mcp";
import { McpConfigError, type McpStore, type StoredOAuth } from "./mcp-store.ts";

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_PER_USER = 5;
/** 이만큼 남았으면 미리 갱신한다 */
const REFRESH_SKEW_MS = 60_000;

export type OAuthClientKind = "web" | "app";

interface Pending {
	user: string;
	serverId: string;
	verifier: string;
	discovery: OAuthDiscovery;
	client: OAuthClient;
	redirectUri: string;
	clientKind: OAuthClientKind;
	expiresAt: number;
}

export interface CallbackResult {
	ok: boolean;
	message: string;
	clientKind: OAuthClientKind;
	serverName?: string;
}

export interface McpAuthOptions {
	store: McpStore;
	/** AF_PUBLIC_URL — 없으면 OAuth 연결을 시작하지 않는다 (Host 헤더로 추측하지 않는다) */
	publicUrl: string | undefined;
	fetch: FetchLike;
	policy: NetPolicy;
	now?: () => number;
}

export const CALLBACK_PATH = "/api/mcp/oauth/callback";

export class McpAuthManager {
	private readonly opts: McpAuthOptions;
	private readonly pending = new Map<string, Pending>();
	private readonly refreshing = new Map<string, Promise<StoredOAuth>>();
	private readonly registering = new Map<string, Promise<OAuthClient>>();
	private readonly now: () => number;

	constructor(opts: McpAuthOptions) {
		this.opts = opts;
		this.now = opts.now ?? Date.now;
	}

	get redirectUri(): string | null {
		return this.opts.publicUrl ? `${this.opts.publicUrl}${CALLBACK_PATH}` : null;
	}

	/** 인가 URL 을 만든다. 화면이 그 주소로 이동한다 */
	async start(user: string, serverId: string, clientKind: OAuthClientKind): Promise<{ url: string }> {
		const redirectUri = this.redirectUri;
		if (!redirectUri) throw new McpConfigError("서버에 AF_PUBLIC_URL 이 설정되지 않아 OAuth 로그인을 할 수 없습니다 — 관리자에게 요청하세요");
		const rec = this.opts.store.get(user, serverId);
		if (!rec) throw new McpConfigError("없는 MCP 서버입니다");
		if (rec.auth !== "oauth") throw new McpConfigError("OAuth 서버가 아닙니다");

		const discovery = await discoverOAuth(rec.url, this.opts.fetch, this.opts.policy).catch((err: unknown) => {
			throw new McpConfigError(`인증 정보를 찾지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
		});
		const client = await this.clientFor(discovery, redirectUri);

		this.prune();
		const mine = [...this.pending.entries()].filter(([, p]) => p.user === user);
		// 연결 버튼을 여러 번 눌러도 오래된 것부터 버린다 (메모리 상한)
		for (const [state] of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_PER_USER + 1))) this.pending.delete(state);

		const pkce = createPkce();
		const state = randomBytes(24).toString("base64url");
		this.pending.set(state, {
			user,
			serverId,
			verifier: pkce.verifier,
			discovery,
			client,
			redirectUri,
			clientKind,
			expiresAt: this.now() + STATE_TTL_MS,
		});
		return { url: buildAuthorizeUrl({ discovery, client, redirectUri, state, challenge: pkce.challenge }) };
	}

	/** 인가 서버가 돌려보낸 요청. 어떤 경우에도 throw 하지 않고 화면에 보일 결과를 돌려준다 */
	async callback(params: URLSearchParams): Promise<CallbackResult> {
		const state = params.get("state") ?? "";
		const p = this.pending.get(state);
		// 1회용 — 성공·실패와 무관하게 먼저 지운다
		this.pending.delete(state);
		if (!p || p.expiresAt < this.now()) {
			return { ok: false, clientKind: p?.clientKind ?? "web", message: "연결 요청이 만료됐거나 올바르지 않습니다. 설정에서 다시 [연결] 을 눌러 주세요." };
		}
		const rec = this.opts.store.get(p.user, p.serverId);
		if (!rec) return { ok: false, clientKind: p.clientKind, message: "그 사이 서버 설정이 삭제됐습니다." };

		const error = params.get("error");
		if (error) {
			const desc = params.get("error_description");
			const message = error === "access_denied" ? "연결을 취소했습니다." : `인가 서버가 거절했습니다: ${error}${desc ? ` — ${desc.slice(0, 200)}` : ""}`;
			return { ok: false, clientKind: p.clientKind, serverName: rec.name, message };
		}
		// RFC 9207 — 인가 서버가 iss 를 주면 우리가 보낸 곳과 같아야 한다 (믹스업 공격)
		const iss = params.get("iss");
		if (iss && iss !== p.discovery.authServer.issuer) {
			return { ok: false, clientKind: p.clientKind, serverName: rec.name, message: "응답한 인가 서버가 요청한 곳과 다릅니다." };
		}
		const code = params.get("code");
		if (!code) return { ok: false, clientKind: p.clientKind, serverName: rec.name, message: "인가 코드가 없습니다." };

		try {
			const tokens = await exchangeCode({
				authServer: p.discovery.authServer,
				client: p.client,
				code,
				verifier: p.verifier,
				redirectUri: p.redirectUri,
				resource: p.discovery.resource,
				fetch: this.opts.fetch,
				now: this.now(),
			});
			await this.opts.store.setOAuth(p.user, p.serverId, {
				tokens,
				client: p.client,
				issuer: p.discovery.authServer.issuer,
				tokenEndpoint: p.discovery.authServer.token_endpoint,
				...(p.discovery.authServer.revocation_endpoint ? { revocationEndpoint: p.discovery.authServer.revocation_endpoint } : {}),
				resource: p.discovery.resource,
				connectedAt: new Date(this.now()).toISOString(),
			});
			this.opts.store.setProblem(p.user, p.serverId, null);
			console.log(`[mcp] 연결 user=${p.user} server=${p.serverId}`);
			return { ok: true, clientKind: p.clientKind, serverName: rec.name, message: `${rec.name} 연결됨` };
		} catch (err) {
			if (err instanceof OAuthError && err.code === "invalid_client") {
				await this.opts.store.forgetClient(p.discovery.authServer.issuer, p.redirectUri).catch(() => undefined);
			}
			console.warn(`[mcp] 코드 교환 실패 user=${p.user} server=${p.serverId}: ${err instanceof Error ? err.message : err}`);
			return { ok: false, clientKind: p.clientKind, serverName: rec.name, message: `토큰을 받지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	/** mcp_call 이 요청마다 부른다 */
	async accessHeaders(user: string, serverId: string): Promise<Record<string, string>> {
		const rec = this.opts.store.get(user, serverId);
		if (!rec?.oauth) throw new McpNeedsAuthError("연결(로그인)이 필요합니다. 설정 → 연결 → MCP 서버에서 [연결] 을 눌러 주세요.");
		let oauth = rec.oauth;
		const exp = oauth.tokens.expiresAt;
		if (exp !== undefined && exp - REFRESH_SKEW_MS <= this.now()) oauth = await this.refresh(user, serverId);
		return { authorization: `Bearer ${oauth.tokens.accessToken}` };
	}

	/** 401 을 받았을 때 — 갱신했으면 true (한 번 재시도). 갱신할 수 없으면 false */
	async onUnauthorized(user: string, serverId: string, failedToken?: string): Promise<boolean> {
		const rec = this.opts.store.get(user, serverId);
		if (!rec?.oauth) return false;
		if (!rec.oauth.tokens.refreshToken) {
			this.opts.store.setProblem(user, serverId, "서버가 토큰을 거부했습니다 — 다시 연결해 주세요");
			return false;
		}
		// 이미 다른 요청이 갱신해 토큰이 바뀌었으면 갱신하지 않고 새 토큰으로 재시도
		if (failedToken && rec.oauth.tokens.accessToken !== failedToken) return true;
		try {
			await this.refresh(user, serverId);
			return true;
		} catch {
			return false;
		}
	}

	private refresh(user: string, serverId: string): Promise<StoredOAuth> {
		const key = `${user}\n${serverId}`;
		const inFlight = this.refreshing.get(key);
		if (inFlight) return inFlight;
		const run = this.doRefresh(user, serverId).finally(() => this.refreshing.delete(key));
		this.refreshing.set(key, run);
		return run;
	}

	private async doRefresh(user: string, serverId: string): Promise<StoredOAuth> {
		const rec = this.opts.store.get(user, serverId);
		const oauth = rec?.oauth;
		if (!rec || !oauth) throw new McpNeedsAuthError("연결(로그인)이 필요합니다. 설정 → 연결 → MCP 서버에서 [연결] 을 눌러 주세요.");
		if (!oauth.tokens.refreshToken) {
			await this.opts.store.setOAuth(user, serverId, null);
			this.opts.store.setProblem(user, serverId, "로그인이 만료됐습니다 (갱신 토큰 없음)");
			throw new McpNeedsAuthError("로그인이 만료됐습니다. 설정 → 연결 → MCP 서버에서 다시 연결해 주세요.");
		}
		try {
			const tokens = await refreshTokens({
				tokenEndpoint: oauth.tokenEndpoint,
				client: oauth.client,
				refreshToken: oauth.tokens.refreshToken,
				resource: oauth.resource,
				fetch: this.opts.fetch,
				now: this.now(),
			});
			const next: StoredOAuth = { ...oauth, tokens };
			await this.opts.store.setOAuth(user, serverId, next);
			return next;
		} catch (err) {
			if (err instanceof OAuthError && err.needsReconnect) {
				await this.opts.store.setOAuth(user, serverId, null);
				this.opts.store.setProblem(user, serverId, "로그인이 만료됐습니다");
				console.warn(`[mcp] 갱신 거절 → 연결 해제 user=${user} server=${serverId}: ${err.code}`);
				throw new McpNeedsAuthError("로그인이 만료됐습니다. 설정 → 연결 → MCP 서버에서 다시 연결해 주세요.");
			}
			throw err;
		}
	}

	/** 연결 해제 — 인가 서버에 폐기를 요청하고(최선) 저장 토큰을 지운다 */
	async disconnect(user: string, serverId: string): Promise<void> {
		const rec = this.opts.store.get(user, serverId);
		const oauth = rec?.oauth;
		if (!rec || !oauth) return;
		if (oauth.revocationEndpoint) {
			const revoke = (token: string, hint: "access_token" | "refresh_token") =>
				revokeToken({ revocationEndpoint: oauth.revocationEndpoint as string, client: oauth.client, token, hint, fetch: this.opts.fetch });
			await Promise.all([
				oauth.tokens.refreshToken ? revoke(oauth.tokens.refreshToken, "refresh_token") : Promise.resolve(true),
				revoke(oauth.tokens.accessToken, "access_token"),
			]);
		}
		await this.opts.store.setOAuth(user, serverId, null);
		this.opts.store.setProblem(user, serverId, null);
		console.log(`[mcp] 연결 해제 user=${user} server=${serverId}`);
	}

	/** DCR 은 인가 서버·redirect_uri 마다 서버 전역 1회 (동시 요청도 한 번만 등록) */
	private clientFor(discovery: OAuthDiscovery, redirectUri: string): Promise<OAuthClient> {
		const issuer = discovery.authServer.issuer;
		const cached = this.opts.store.getClient(issuer, redirectUri);
		if (cached) return Promise.resolve(cached);
		const key = `${issuer}\n${redirectUri}`;
		const inFlight = this.registering.get(key);
		if (inFlight) return inFlight;
		const run = (async () => {
			const client = await registerClient(discovery.authServer, redirectUri, this.opts.fetch).catch((err: unknown) => {
				throw new McpConfigError(`클라이언트 등록 실패: ${err instanceof Error ? err.message : String(err)}`);
			});
			await this.opts.store.saveClient(issuer, redirectUri, client);
			console.log(`[mcp] OAuth 클라이언트 등록 issuer=${issuer}`);
			return client;
		})().finally(() => this.registering.delete(key));
		this.registering.set(key, run);
		return run;
	}

	private prune(): void {
		const now = this.now();
		for (const [state, p] of this.pending) if (p.expiresAt < now) this.pending.delete(state);
	}
}
