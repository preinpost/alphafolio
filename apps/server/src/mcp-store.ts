/**
 * 사용자별 원격 MCP 서버 설정 — D1 `user_mcp_servers` (PLAN §38).
 *
 * 증권 키와 같은 원칙:
 *   - 사용자별. 자격증명(고정 헤더·OAuth 토큰)은 행 단위 AES-256-GCM, 키는 AF_AUTH_SECRET 에서 HKDF 파생
 *     (info 가 달라 user_secrets·broker_tokens 암호문과 섞이지 않는다)
 *   - 호출 시점에 읽는다 (메모리 캐시 — 기동 때 적재, 쓰기마다 갱신)
 *   - 화면으로는 **상태만** 내려보낸다 (연결됨·만료 시각·헤더 이름). 토큰·헤더 값은 절대 내보내지 않는다
 *
 * 원격 HTTP 만 받는다. stdio(`command`)는 필드 자체가 없다 — 공유 서버에서 사용자 입력 명령 실행 = 원격 코드 실행.
 */
import { randomBytes } from "node:crypto";
import { d1Query, type D1Config } from "@alphafolio/ledger";
import { parseRemoteUrl, PRESETS, type NetPolicy, type OAuthClient, type TokenSet } from "@alphafolio/mcp";
import { decryptValue, deriveKey, encryptValue } from "./crypto.ts";

export type McpAuthKind = "oauth" | "headers" | "none";

/** OAuth 연결 결과 — 갱신·폐기에 필요한 것까지 함께 둔다 (갱신할 때마다 디스커버리를 다시 하지 않게) */
export interface StoredOAuth {
	tokens: TokenSet;
	client: OAuthClient;
	issuer: string;
	tokenEndpoint: string;
	revocationEndpoint?: string;
	resource: string;
	connectedAt: string;
}

export interface McpServerRecord {
	id: string;
	name: string;
	url: string;
	auth: McpAuthKind;
	preset?: string;
	headers?: Record<string, string>;
	oauth?: StoredOAuth;
	createdAt: string;
	updatedAt: string;
}

/** 화면용 — 자격증명 값 없음 */
export interface McpServerStatus {
	id: string;
	name: string;
	url: string;
	auth: McpAuthKind;
	preset: string | null;
	/** 고정 헤더 이름만 (값은 없음) */
	headerNames: string[];
	/** oauth: 토큰이 있다 / headers·none: 항상 true */
	connected: boolean;
	/** access token 만료 (epoch ms) — refresh token 이 있으면 자동 갱신된다 */
	expiresAt: number | null;
	/** 갱신 실패 등으로 끊긴 이유 (다시 연결 안내) */
	problem: string | null;
}

export class McpConfigError extends Error {
	readonly status = 400;
}

export const MAX_SERVERS_PER_USER = 10;
const NAME_MAX = 40;
const MAX_HEADERS = 5;
/** 우리가 채우는 헤더 — 사용자가 덮어쓰면 프로토콜이 깨지거나 요청 밀수가 된다 */
const RESERVED_HEADERS = new Set([
	"host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "te", "upgrade",
	"mcp-session-id", "mcp-protocol-version", "user-agent", "cookie", "proxy-authorization", "expect",
]);

/** 고정 헤더 검증. bearer 는 Authorization 한 줄로 바꿔 부른다 (mcp-api) */
export function normalizeHeaders(input: unknown): Record<string, string> {
	if (input === undefined || input === null) return {};
	if (typeof input !== "object" || Array.isArray(input)) throw new McpConfigError("headers 는 { 이름: 값 } 이어야 합니다");
	const out: Record<string, string> = {};
	for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
		const name = rawName.trim().toLowerCase();
		const value = String(rawValue ?? "").trim();
		if (!name) continue;
		if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new McpConfigError(`헤더 이름이 올바르지 않습니다: ${rawName}`);
		if (RESERVED_HEADERS.has(name)) throw new McpConfigError(`직접 넣을 수 없는 헤더입니다: ${rawName}`);
		if (!value) throw new McpConfigError(`헤더 값이 비어 있습니다: ${rawName}`);
		if (value.length > 4096 || /[\r\n\0]/.test(value)) throw new McpConfigError(`헤더 값이 올바르지 않습니다: ${rawName}`);
		out[name] = value;
	}
	if (Object.keys(out).length > MAX_HEADERS) throw new McpConfigError(`헤더는 ${MAX_HEADERS}개까지입니다`);
	return out;
}

const HKDF_INFO = "mcp-credentials";
const HKDF_INFO_CLIENT = "mcp-oauth-client";

interface Row {
	member: string;
	id: string;
	name: string;
	url: string;
	auth: string;
	preset: string | null;
	headers_enc: string | null;
	tokens_enc: string | null;
	created_at: string;
	updated_at: string;
}

export class McpStore {
	private readonly d1: () => D1Config;
	private readonly key: Buffer;
	private readonly clientKey: Buffer;
	private readonly policy: NetPolicy;
	private cache = new Map<string, Map<string, McpServerRecord>>();
	private clients = new Map<string, OAuthClient>();
	/** 메모리만 — 재시작하면 사라진다 (토큰이 없으면 어차피 "연결 필요") */
	private readonly problems = new Map<string, string>();
	private loaded = false;

	constructor(d1: () => D1Config, masterSecret: string, policy: NetPolicy) {
		this.d1 = d1;
		this.key = deriveKey(masterSecret, HKDF_INFO);
		this.clientKey = deriveKey(masterSecret, HKDF_INFO_CLIENT);
		this.policy = policy;
	}

	async load(): Promise<void> {
		const rows = await d1Query<Row>(this.d1(), "SELECT * FROM user_mcp_servers");
		const next = new Map<string, Map<string, McpServerRecord>>();
		let failed = 0;
		for (const row of rows.results) {
			const rec: McpServerRecord = {
				id: row.id,
				name: row.name,
				url: row.url,
				auth: (["oauth", "headers", "none"].includes(row.auth) ? row.auth : "none") as McpAuthKind,
				...(row.preset ? { preset: row.preset } : {}),
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			};
			// 복호화 실패(마스터 키 변경)면 자격증명 없이 올린다 — 설정은 보이고 "연결 필요" 로 뜬다
			try {
				if (row.headers_enc) rec.headers = JSON.parse(decryptValue(row.headers_enc, this.key)) as Record<string, string>;
				if (row.tokens_enc) rec.oauth = JSON.parse(decryptValue(row.tokens_enc, this.key)) as StoredOAuth;
			} catch {
				failed += 1;
			}
			const bucket = next.get(row.member) ?? new Map<string, McpServerRecord>();
			bucket.set(rec.id, rec);
			next.set(row.member, bucket);
		}
		const clientRows = await d1Query<{ issuer: string; redirect_uri: string; client_enc: string }>(this.d1(), "SELECT * FROM mcp_oauth_clients");
		const clients = new Map<string, OAuthClient>();
		for (const r of clientRows.results) {
			try {
				clients.set(clientCacheKey(r.issuer, r.redirect_uri), JSON.parse(decryptValue(r.client_enc, this.clientKey)) as OAuthClient);
			} catch {
				/* 다시 등록하면 된다 */
			}
		}
		this.cache = next;
		this.clients = clients;
		this.loaded = true;
		if (failed > 0) console.warn(`[mcp] 자격증명 ${failed}건을 복호화하지 못했습니다 (AF_AUTH_SECRET 변경?) — 해당 서버는 다시 연결해야 합니다`);
	}

	get ready(): boolean {
		return this.loaded;
	}

	list(user: string): McpServerRecord[] {
		return [...(this.cache.get(user)?.values() ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	get(user: string, id: string): McpServerRecord | undefined {
		return this.cache.get(user)?.get(id);
	}

	status(user: string): McpServerStatus[] {
		return this.list(user).map((r) => ({
			id: r.id,
			name: r.name,
			url: r.url,
			auth: r.auth,
			preset: r.preset ?? null,
			headerNames: Object.keys(r.headers ?? {}),
			connected: r.auth !== "oauth" || !!r.oauth,
			expiresAt: r.oauth?.tokens.expiresAt ?? null,
			problem: this.problems.get(`${user}:${r.id}`) ?? null,
		}));
	}

	setProblem(user: string, id: string, problem: string | null): void {
		if (problem) this.problems.set(`${user}:${id}`, problem);
		else this.problems.delete(`${user}:${id}`);
	}

	async add(
		user: string,
		input: { name: string; url: string; auth: McpAuthKind; preset?: string; headers?: Record<string, string> },
	): Promise<McpServerRecord> {
		if (!this.loaded) throw new McpConfigError("저장소가 준비되지 않았습니다 (서버 DB 미설정)");
		const existing = this.list(user);
		if (existing.length >= MAX_SERVERS_PER_USER) throw new McpConfigError(`MCP 서버는 ${MAX_SERVERS_PER_USER}개까지 추가할 수 있습니다`);
		if (input.preset && !PRESETS[input.preset]) throw new McpConfigError(`알 수 없는 프리셋: ${input.preset}`);

		const name = input.name.trim();
		if (!name || [...name].length > NAME_MAX) throw new McpConfigError(`이름은 1~${NAME_MAX}자여야 합니다`);
		let url: string;
		try {
			url = parseRemoteUrl(input.url, this.policy).toString();
		} catch (err) {
			throw new McpConfigError(err instanceof Error ? err.message : String(err));
		}
		if (existing.some((s) => s.url === url)) throw new McpConfigError("이미 추가한 주소입니다");
		if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new McpConfigError("같은 이름의 서버가 있습니다");
		const headers = input.auth === "headers" ? (input.headers ?? {}) : {};
		if (input.auth === "headers" && Object.keys(headers).length === 0) throw new McpConfigError("헤더 인증에는 헤더(또는 Bearer 토큰)가 필요합니다");

		const now = new Date().toISOString();
		const rec: McpServerRecord = {
			id: input.preset && !existing.some((s) => s.id === input.preset) ? input.preset : `m${randomBytes(4).toString("hex")}`,
			name,
			url,
			auth: input.auth,
			...(input.preset ? { preset: input.preset } : {}),
			...(Object.keys(headers).length ? { headers } : {}),
			createdAt: now,
			updatedAt: now,
		};
		await d1Query(
			this.d1(),
			`INSERT INTO user_mcp_servers (member, id, name, url, auth, preset, headers_enc, tokens_enc, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
			[user, rec.id, rec.name, rec.url, rec.auth, rec.preset ?? null, rec.headers ? encryptValue(JSON.stringify(rec.headers), this.key) : null, now, now],
		);
		const bucket = this.cache.get(user) ?? new Map<string, McpServerRecord>();
		bucket.set(rec.id, rec);
		this.cache.set(user, bucket);
		return rec;
	}

	async remove(user: string, id: string): Promise<boolean> {
		const r = await d1Query(this.d1(), "DELETE FROM user_mcp_servers WHERE member = ? AND id = ?", [user, id]);
		this.cache.get(user)?.delete(id);
		this.problems.delete(`${user}:${id}`);
		return (r.meta.changes ?? 0) > 0;
	}

	/** OAuth 토큰 저장·삭제. 설정 버전(updatedAt)은 바꾸지 않는다 — 세션은 그대로 쓰고 헤더만 새 토큰으로 */
	async setOAuth(user: string, id: string, oauth: StoredOAuth | null): Promise<void> {
		const rec = this.get(user, id);
		if (!rec) throw new McpConfigError("없는 MCP 서버입니다");
		await d1Query(this.d1(), "UPDATE user_mcp_servers SET tokens_enc = ? WHERE member = ? AND id = ?", [
			oauth ? encryptValue(JSON.stringify(oauth), this.key) : null,
			user,
			id,
		]);
		if (oauth) rec.oauth = oauth;
		else delete rec.oauth;
	}

	getClient(issuer: string, redirectUri: string): OAuthClient | undefined {
		return this.clients.get(clientCacheKey(issuer, redirectUri));
	}

	async saveClient(issuer: string, redirectUri: string, client: OAuthClient): Promise<void> {
		this.clients.set(clientCacheKey(issuer, redirectUri), client);
		await d1Query(
			this.d1(),
			`INSERT INTO mcp_oauth_clients (issuer, redirect_uri, client_enc, created_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(issuer, redirect_uri) DO UPDATE SET client_enc = excluded.client_enc, created_at = excluded.created_at`,
			[issuer, redirectUri, encryptValue(JSON.stringify(client), this.clientKey), new Date().toISOString()],
		);
	}

	/** 인가 서버가 등록을 잊었을 때(invalid_client) — 다음 연결에서 다시 등록한다 */
	async forgetClient(issuer: string, redirectUri: string): Promise<void> {
		this.clients.delete(clientCacheKey(issuer, redirectUri));
		await d1Query(this.d1(), "DELETE FROM mcp_oauth_clients WHERE issuer = ? AND redirect_uri = ?", [issuer, redirectUri]);
	}
}

function clientCacheKey(issuer: string, redirectUri: string): string {
	return `${issuer}\n${redirectUri}`;
}
