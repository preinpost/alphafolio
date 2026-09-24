/**
 * 테스트용 원격 MCP 서버 + OAuth 인가 서버 — fetch 만 흉내 낸다 (네트워크 없음).
 * TradingView 실측(2026-09-23/24)과 같은 모양: 401 + resource_metadata, 경로형 보호 리소스 메타데이터, DCR, PKCE S256.
 */
import { pkceChallenge } from "../src/oauth.ts";
import type { FetchLike } from "../src/net.ts";
import type { McpTool } from "../src/client.ts";

export const MCP_URL = "https://mcp.example.com/mcp";
export const ISSUER = "https://auth.example.com";

export interface FakeOptions {
	tools?: McpTool[];
	/** 응답을 SSE 로 */
	sse?: boolean;
	/** 이 토큰만 받는다. undefined 면 인증 없음 */
	acceptToken?: () => string | undefined;
	/** refresh token 회전 */
	rotateRefresh?: boolean;
	/** tools/call 결과 */
	callResult?: (name: string, args: Record<string, unknown>) => unknown;
}

export interface FakeServer {
	fetch: FetchLike;
	log: Array<{ method: string; url: string; rpc?: string; headers: Record<string, string>; body?: string }>;
	/** 발급한 토큰 */
	issued: { access: string[]; refresh: string[] };
	registered: Array<Record<string, unknown>>;
	/** 인가 화면에서 발급한 코드 → challenge */
	authorize: (authUrl: string) => string;
	sessions: Set<string>;
	revoked: string[];
	/** 다음 토큰 요청을 이 오류로 */
	failNextToken?: { status: number; error: string };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function createFakeServer(opts: FakeOptions = {}): FakeServer {
	let n = 0;
	const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string; resource: string | null }>();
	const refreshValid = new Set<string>();
	const server: FakeServer = {
		log: [],
		issued: { access: [], refresh: [] },
		registered: [],
		sessions: new Set(),
		revoked: [],
		authorize: (authUrl) => {
			const u = new URL(authUrl);
			const code = `code-${++n}`;
			codes.set(code, {
				challenge: u.searchParams.get("code_challenge") ?? "",
				clientId: u.searchParams.get("client_id") ?? "",
				redirectUri: u.searchParams.get("redirect_uri") ?? "",
				resource: u.searchParams.get("resource"),
			});
			return code;
		},
		fetch: async (url, init) => {
			const u = new URL(url);
			const entry: FakeServer["log"][number] = { method: init.method, url, headers: init.headers, ...(init.body ? { body: init.body } : {}) };
			server.log.push(entry);

			// ── 메타데이터 ──
			if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") {
				return json(200, { resource: MCP_URL, authorization_servers: [ISSUER], scopes_supported: ["mcp:read", "mcp:tools"] });
			}
			if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
				return json(200, {
					issuer: ISSUER,
					authorization_endpoint: `${ISSUER}/oauth/authorize`,
					token_endpoint: `${ISSUER}/oauth/token`,
					registration_endpoint: `${ISSUER}/oauth/register`,
					revocation_endpoint: `${ISSUER}/oauth/revoke`,
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
				});
			}
			if (url === `${ISSUER}/oauth/register`) {
				const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
				server.registered.push(body);
				return json(201, { client_id: `client-${server.registered.length}`, token_endpoint_auth_method: "none", redirect_uris: body.redirect_uris });
			}
			if (url === `${ISSUER}/oauth/token`) {
				const form = new URLSearchParams(init.body ?? "");
				if (server.failNextToken) {
					const f = server.failNextToken;
					delete server.failNextToken;
					return json(f.status, { error: f.error });
				}
				const issue = (keepRefresh?: string) => {
					const access = `at-${++n}`;
					server.issued.access.push(access);
					let refresh = keepRefresh;
					if (!refresh) {
						refresh = `rt-${++n}`;
						server.issued.refresh.push(refresh);
						refreshValid.add(refresh);
					}
					// 회전하지 않는 서버는 refresh_token 을 다시 싣지 않는다 (RFC 6749 §6 — 클라이언트가 기존 값을 유지해야 한다)
					return json(200, {
						access_token: access,
						token_type: "Bearer",
						expires_in: 3600,
						...(keepRefresh ? {} : { refresh_token: refresh }),
						scope: "mcp:read mcp:tools",
					});
				};
				if (form.get("grant_type") === "authorization_code") {
					const c = codes.get(form.get("code") ?? "");
					codes.delete(form.get("code") ?? "");
					if (!c) return json(400, { error: "invalid_grant" });
					if (pkceChallenge(form.get("code_verifier") ?? "") !== c.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE" });
					if (form.get("client_id") !== c.clientId || form.get("redirect_uri") !== c.redirectUri) return json(400, { error: "invalid_grant" });
					if (form.get("resource") !== c.resource) return json(400, { error: "invalid_target" });
					return issue();
				}
				if (form.get("grant_type") === "refresh_token") {
					const rt = form.get("refresh_token") ?? "";
					if (!refreshValid.has(rt)) return json(400, { error: "invalid_grant" });
					if (opts.rotateRefresh) {
						refreshValid.delete(rt);
						return issue();
					}
					return issue(rt);
				}
				return json(400, { error: "unsupported_grant_type" });
			}
			if (url === `${ISSUER}/oauth/revoke`) {
				server.revoked.push(new URLSearchParams(init.body ?? "").get("token") ?? "");
				return new Response(null, { status: 200 });
			}

			// ── MCP ──
			if (u.origin + u.pathname === MCP_URL) {
				const want = opts.acceptToken?.();
				if (want !== undefined && init.headers.authorization !== `Bearer ${want}`) {
					return json(401, { detail: "auth" }, { "www-authenticate": `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"` });
				}
				if (init.method === "DELETE") {
					server.sessions.delete(init.headers["mcp-session-id"] ?? "");
					return new Response(null, { status: 204 });
				}
				const msg = JSON.parse(init.body ?? "{}") as { id?: number; method: string; params?: Record<string, unknown> };
				entry.rpc = msg.method;
				if (msg.method !== "initialize") {
					const sid = init.headers["mcp-session-id"];
					if (!sid || !server.sessions.has(sid)) return json(404, { error: "session" });
				}
				if (msg.id === undefined) return new Response(null, { status: 202 });
				let result: unknown;
				const extra: Record<string, string> = {};
				if (msg.method === "initialize") {
					const sid = `s-${++n}`;
					server.sessions.add(sid);
					extra["mcp-session-id"] = sid;
					result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake" } };
				} else if (msg.method === "tools/list") {
					result = { tools: opts.tools ?? [] };
				} else if (msg.method === "tools/call") {
					const p = msg.params as { name: string; arguments: Record<string, unknown> };
					result = opts.callResult?.(p.name, p.arguments) ?? { content: [{ type: "text", text: `called ${p.name}` }] };
				} else {
					return json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
				}
				const reply = { jsonrpc: "2.0", id: msg.id, result };
				if (opts.sse) {
					// 진행 알림 → 응답 순서. 여러 청크로 나눠 보낸다 (경계 처리)
					const text =
						`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n` +
						`event: message\ndata: ${JSON.stringify(reply)}\n\n`;
					const chunks = [text.slice(0, 30), text.slice(30, 77), text.slice(77)];
					const stream = new ReadableStream<Uint8Array>({
						start(c) {
							for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
							c.close();
						},
					});
					return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", ...extra } });
				}
				return json(200, reply, extra);
			}
			return json(404, { error: "not found", url });
		},
	};
	return server;
}
