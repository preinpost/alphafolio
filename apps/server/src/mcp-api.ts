/**
 * /api/mcp/* — 설정 화면용 MCP 서버 관리 + OAuth 콜백 (PLAN §38).
 *
 * 에이전트는 여기에 올 수 없다 (사용자 인증 토큰이 없다). 서버 추가·연결·삭제는 사람이 화면에서만 한다 —
 * 뉴스·웹 본문의 지시로 모델이 새 MCP 서버를 붙이는 일이 없게.
 */
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { judgeTool, McpSession, PRESETS, rawResult, renderCallResult, summarizeResult, type FetchLike, type McpServerHandle, type SummaryLine } from "@alphafolio/mcp";
import { explainMcpError, type McpWriteRequest } from "@alphafolio/mcp/tools";
import { HttpError, readJson } from "./ledger-api.ts";
import { createOrderToken, ORDER_TOKEN_TTL_MS, type OrderTokenGuard, type VerifyFailure } from "./order-tokens.ts";
import type { McpAuthManager, OAuthClientKind } from "./mcp-auth.ts";
import { McpConfigError, normalizeHeaders, type McpServerRecord, type McpStore } from "./mcp-store.ts";

export interface McpApiDeps {
	store: McpStore;
	auth: McpAuthManager;
	fetch: FetchLike;
	publicUrl: string | undefined;
	/** 쓰기 확인 토큰 (PLAN §39) — 서명 키는 mcpConfirmSecret(마스터) */
	confirm: { secret: string; guard: OrderTokenGuard<McpWritePayload> };
}

// ── 쓰기 확인 (PLAN §39) ────────────────────────────────────────────────
// 주문 확인 토큰과 같은 구조(서명·1회용·2분)를 쓰되 **서명 키를 따로 파생**한다 —
// MCP 토큰을 /api/orders/execute 에 넣거나 그 반대로 쓰면 서명 검증에서 떨어진다.

export interface McpWritePayload {
	u: string;
	mcp: McpWriteRequest;
	exp: number;
	nonce: string;
}

export function mcpConfirmSecret(master: string): string {
	return createHmac("sha256", master).update("alphafolio/mcp-confirm/v1").digest("hex");
}

/** mcp_call 이 쓰기 툴을 준비할 때 — 서버·툴·인자 전체를 서명한다 */
export function prepareMcpWrite(deps: McpApiDeps, user: string) {
	return (req: McpWriteRequest): { token: string; expiresAt: number } => {
		const { token, payload } = createOrderToken({ u: user, mcp: req }, deps.confirm.secret);
		console.log(`[mcp] 쓰기 준비 user=${user} server=${req.serverId} tool=${req.tool} nonce=${payload.nonce}`);
		return { token, expiresAt: payload.exp };
	};
}

function confirmFailure(reason: VerifyFailure): string {
	switch (reason) {
		case "expired":
			return `확인 시간이 지났습니다 (${ORDER_TOKEN_TTL_MS / 60_000}분). 챗에서 다시 요청해 주세요.`;
		case "used":
			return "이미 처리한 요청입니다.";
		case "wrong-user":
			return "다른 사용자의 확인 카드입니다.";
		default:
			return "확인 정보가 올바르지 않습니다.";
	}
}

/** 사람이 카드에서 [확인] 을 눌렀다 — 실제로 외부 계정이 바뀌는 유일한 경로 */
/** 확인 카드가 받는 실행 결과 — 원본 JSON 은 raw 로만 (카드가 접어 둔다) */
export interface McpExecuteResult {
	ok: boolean;
	message: string;
	/** 사람이 볼 요약 (알림 id·조건·만료 등). JSON 이 아니면 비고 detail 이 곧 내용 */
	summary: SummaryLine[];
	/** 짧은 본문 — 실패 사유나 JSON 이 아닌 응답 */
	detail: string;
	/** 원본 응답 (펼쳐 볼 때만) */
	raw: string;
}

async function executeMcpWrite(deps: McpApiDeps, user: string, token: string): Promise<McpExecuteResult> {
	const verified = deps.confirm.guard.verify(token, deps.confirm.secret, user);
	if (!verified.ok) throw new HttpError(400, confirmFailure(verified.reason));
	const { mcp, nonce } = verified.payload;
	// 보내기 **전에** 소비한다 — 더블클릭·재전송이 두 번 실행되지 않게 (실패해도 재사용 없음)
	deps.confirm.guard.consume(nonce);

	const rec = deps.store.get(user, mcp.serverId);
	if (!rec) throw new HttpError(400, "그 사이 MCP 서버 설정이 삭제됐습니다.");
	// 준비한 뒤 서버 주소를 바꿨다면 다른 곳으로 보내지 않는다
	if (rec.url !== mcp.url) throw new HttpError(400, "그 사이 MCP 서버 주소가 바뀌었습니다. 챗에서 다시 요청해 주세요.");
	const h = handleFor(deps, user, rec);
	if (h.state === "needs_auth") throw new HttpError(400, `${rec.name} 연결이 필요합니다 — 설정 → 연결 → MCP 서버`);

	console.log(`[mcp] 쓰기 실행 user=${user} server=${mcp.serverId} tool=${mcp.tool} nonce=${nonce}`);
	const session = new McpSession({
		url: h.url,
		fetch: deps.fetch,
		headers: () => h.headers(),
		...(h.onUnauthorized ? { onUnauthorized: h.onUnauthorized } : {}),
	});
	try {
		const result = await session.callTool(mcp.tool, mcp.args);
		const summary = result.isError ? [] : summarizeResult(result, mcp.tool, h.preset);
		// 요약이 됐으면 본문은 원본으로만, 안 되면(JSON 이 아닌 응답·실패 사유) 짧게 보여 준다
		const detail = summary.length ? "" : renderCallResult(result, 500).text;
		const raw = rawResult(result);
		return result.isError
			? { ok: false, message: `${rec.name} 가 거절했습니다`, summary, detail, raw }
			: { ok: true, message: `${rec.name} 에서 실행했습니다`, summary, detail, raw };
	} catch (err) {
		// 네트워크 오류는 실행 여부를 모른다 — 다시 누르지 말고 조회로 확인하게
		return { ok: false, message: `${explainMcpError(rec.name, err)} (실행됐는지 알 수 없으니 목록을 조회해 확인하세요)`, summary: [], detail: "", raw: "" };
	} finally {
		void session.close();
	}
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

	// ⚠️ 확인 카드의 [확인] 버튼만 부른다. 에이전트는 사용자 인증 토큰이 없어 여기에 올 수 없다
	if (path === "/api/mcp/execute" && req.method === "POST") {
		const body = await readJson(req);
		return executeMcpWrite(deps, user, String(body.token ?? ""));
	}

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
			const reads = tools.filter((t) => judgeTool(t, h.preset).mode === "read").length;
			const writes = tools.length - reads;
			return {
				ok: true,
				message: `연결 성공 — 툴 ${tools.length}개: 읽기 ${reads}개는 바로, 쓰기 ${writes}개는 확인 카드로`,
				reads,
				writes,
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
