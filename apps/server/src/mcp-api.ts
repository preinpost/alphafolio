/**
 * /api/mcp/* — 설정 화면용 MCP 서버 관리 + OAuth 콜백 (PLAN §38).
 *
 * 에이전트는 여기에 올 수 없다 (사용자 인증 토큰이 없다). 서버 추가·연결·삭제는 사람이 화면에서만 한다 —
 * 뉴스·웹 본문의 지시로 모델이 새 MCP 서버를 붙이는 일이 없게.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { judgeTool, McpSession, PRESETS, type FetchLike, type McpServerHandle } from "@alphafolio/mcp";
import { explainMcpError } from "@alphafolio/mcp/tools";
import { HttpError, readJson } from "./ledger-api.ts";
import type { McpAuthManager, OAuthClientKind } from "./mcp-auth.ts";
import { McpConfigError, normalizeHeaders, type McpServerRecord, type McpStore } from "./mcp-store.ts";

export interface McpApiDeps {
	store: McpStore;
	auth: McpAuthManager;
	fetch: FetchLike;
	publicUrl: string | undefined;
}

function handleFor(deps: McpApiDeps, user: string, rec: McpServerRecord): McpServerHandle {
	const preset = rec.preset ? PRESETS[rec.preset] : undefined;
	let lastToken: string | undefined;
	return {
		id: rec.id,
		name: rec.name,
		url: rec.url,
		...(preset ? { preset } : {}),
		state: rec.auth === "oauth" && !rec.oauth ? "needs_auth" : "ready",
		version: rec.updatedAt,
		headers: async () => {
			if (rec.auth === "oauth") {
				const h = await deps.auth.accessHeaders(user, rec.id);
				lastToken = h.authorization?.slice("Bearer ".length);
				return h;
			}
			// 호출 시점에 다시 읽는다 — 설정을 바꾸면 바로 반영
			return { ...(deps.store.get(user, rec.id)?.headers ?? {}) };
		},
		...(rec.auth === "oauth" ? { onUnauthorized: () => deps.auth.onUnauthorized(user, rec.id, lastToken) } : {}),
	};
}

/** mcp_call 이 호출마다 읽는 이 사용자의 서버 목록 */
export function mcpHandles(deps: McpApiDeps, user: string): McpServerHandle[] {
	return deps.store.list(user).map((rec) => handleFor(deps, user, rec));
}

function listing(deps: McpApiDeps, user: string) {
	const items = deps.store.status(user);
	return {
		items,
		presets: Object.values(PRESETS).map((p) => ({ id: p.id, name: p.name, url: p.url, added: items.some((i) => i.preset === p.id) })),
		/** AF_PUBLIC_URL 이 없으면 OAuth 연결 버튼을 막는다 */
		oauthReady: !!deps.auth.redirectUri,
		storageReady: deps.store.ready,
	};
}

function asConfigError(err: unknown): never {
	if (err instanceof McpConfigError) throw new HttpError(400, err.message);
	throw err;
}

/** 처리한 경로면 응답 본문, 아니면 undefined */
export async function handleMcp(req: IncomingMessage, path: string, user: string, deps: McpApiDeps): Promise<unknown> {
	if (path === "/api/mcp/servers" && req.method === "GET") return listing(deps, user);

	if (path === "/api/mcp/servers" && req.method === "POST") {
		const body = await readJson(req);
		try {
			const presetId = typeof body.preset === "string" ? body.preset : undefined;
			if (presetId) {
				const p = PRESETS[presetId];
				if (!p) throw new McpConfigError(`알 수 없는 프리셋: ${presetId}`);
				await deps.store.add(user, { name: p.name, url: p.url, auth: p.auth, preset: p.id });
			} else {
				const kind = String(body.auth ?? "none");
				if (!["oauth", "bearer", "headers", "none"].includes(kind)) throw new McpConfigError(`알 수 없는 인증 방식: ${kind}`);
				let headers: Record<string, string> = {};
				if (kind === "bearer") {
					const token = String(body.token ?? "").trim();
					if (!token) throw new McpConfigError("Bearer 토큰을 입력하세요");
					headers = normalizeHeaders({ authorization: `Bearer ${token.replace(/^Bearer\s+/i, "")}` });
				} else if (kind === "headers") {
					headers = normalizeHeaders(body.headers);
				}
				await deps.store.add(user, {
					name: String(body.name ?? ""),
					url: String(body.url ?? ""),
					auth: kind === "bearer" ? "headers" : (kind as "oauth" | "headers" | "none"),
					headers,
				});
			}
		} catch (err) {
			asConfigError(err);
		}
		return listing(deps, user);
	}

	const m = /^\/api\/mcp\/servers\/([^/]+)(\/[a-z/]+)?$/.exec(path);
	if (!m) return undefined;
	const id = decodeURIComponent(m[1] ?? "");
	const action = m[2] ?? "";
	const rec = deps.store.get(user, id);
	if (!rec) throw new HttpError(404, "없는 MCP 서버입니다");

	if (action === "" && req.method === "DELETE") {
		// 폐기 실패해도 지운다 — 사용자는 이 서버를 더 이상 쓰지 않겠다고 했다
		await deps.auth.disconnect(user, id).catch(() => undefined);
		await deps.store.remove(user, id);
		return listing(deps, user);
	}

	if (action === "/oauth/start" && req.method === "POST") {
		const body = await readJson(req);
		const clientKind: OAuthClientKind = body.client === "app" ? "app" : "web";
		try {
			return await deps.auth.start(user, id, clientKind);
		} catch (err) {
			asConfigError(err);
		}
	}

	if (action === "/disconnect" && req.method === "POST") {
		await deps.auth.disconnect(user, id);
		return listing(deps, user);
	}

	// 연결 테스트 — 새 세션으로 툴 목록을 받아 읽기/차단 개수를 보여 준다 (툴을 호출하지는 않는다)
	if (action === "/test" && req.method === "POST") {
		const h = handleFor(deps, user, rec);
		if (h.state === "needs_auth") return { ok: false, message: "먼저 [연결] 로 로그인하세요" };
		const session = new McpSession({
			url: h.url,
			fetch: deps.fetch,
			headers: () => h.headers(),
			...(h.onUnauthorized ? { onUnauthorized: h.onUnauthorized } : {}),
		});
		try {
			const tools = await session.listTools();
			const allowed = tools.filter((t) => judgeTool(t, h.preset).allowed).length;
			return {
				ok: true,
				message: `연결 성공 — 툴 ${tools.length}개 중 읽기 ${allowed}개 사용 (${tools.length - allowed}개 차단)`,
				allowed,
				blocked: tools.length - allowed,
			};
		} catch (err) {
			return { ok: false, message: explainMcpError(rec.name, err) };
		} finally {
			void session.close();
		}
	}

	return undefined;
}

// ── OAuth 콜백 (공개 경로) ──────────────────────────────────────────────

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/**
 * 인가 서버가 브라우저를 여기로 돌려보낸다. 인증 헤더가 없으므로 state 로만 사용자를 찾는다 (1회용·10분).
 * 웹: 설정 화면으로 되돌린다. 앱: 시스템 브라우저에서 열렸으므로 "앱으로 돌아가세요" 페이지 (앱은 포그라운드 때 상태를 다시 읽는다).
 */
export async function handleMcpCallback(url: URL, res: ServerResponse, deps: McpApiDeps): Promise<void> {
	const result = await deps.auth.callback(url.searchParams);
	if (result.clientKind === "web" && deps.publicUrl) {
		const back = new URL(`${deps.publicUrl}/settings/connect`);
		back.searchParams.set("mcp", result.ok ? "ok" : "error");
		back.searchParams.set("msg", result.message.slice(0, 200));
		res.writeHead(302, { location: back.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" });
		res.end();
		return;
	}
	const title = result.ok ? "연결되었습니다" : "연결하지 못했습니다";
	const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AlphaFolio · ${escapeHtml(title)}</title>
<style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f8fb;color:#1c2330}
main{max-width:22rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#5b6576;margin:0}</style></head>
<body><main><h1>${result.ok ? "✅" : "⚠️"} ${escapeHtml(title)}</h1><p>${escapeHtml(result.message)}</p>
<p style="margin-top:1rem">이 창을 닫고 AlphaFolio 앱으로 돌아가세요.</p></main></body></html>`;
	res.writeHead(result.ok ? 200 : 400, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
	});
	res.end(html);
}
