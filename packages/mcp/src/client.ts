/**
 * MCP 클라이언트 — Streamable HTTP 전송만 (원격 서버 전용, stdio 없음).
 *
 * `@modelcontextprotocol/sdk` 를 쓰지 않은 이유 (PLAN §38): 클라이언트로 쓰는 부분은 JSON-RPC POST 몇 종류뿐인데
 * SDK 는 express·hono·cross-spawn 등 서버·stdio 의존을 통째로 끌고 온다 (서버 런타임 의존성이 지금 ws 하나).
 * 그리고 우리가 막아야 하는 것(SSRF·리다이렉트·응답 크기)을 fetch 교체로 맞추기가 더 번거롭다.
 *
 * 규격: MCP 2025-06-18 Streamable HTTP
 *   - 요청마다 POST, Accept 에 application/json 과 text/event-stream 둘 다
 *   - 응답은 JSON 한 개 또는 SSE 스트림 (스트림이면 우리 id 의 응답이 올 때까지 읽는다)
 *   - initialize 응답의 Mcp-Session-Id 를 이후 요청에 싣는다. 404 면 세션 만료 → 다시 initialize
 *   - 401/403 → 인증 실패. onUnauthorized 가 토큰을 갱신하면 한 번만 다시 보낸다
 */
import type { FetchLike } from "./net.ts";

export const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "AlphaFolio", version: "1.0.0" };

export interface McpTool {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; mimeType?: string; data?: string }
	| { type: "audio"; mimeType?: string }
	| { type: "resource"; resource: { uri?: string; text?: string; mimeType?: string } }
	| { type: "resource_link"; uri?: string; name?: string; description?: string }
	| { type: string; [k: string]: unknown };

export interface McpCallResult {
	content?: McpContent[];
	structuredContent?: unknown;
	isError?: boolean;
}

/** 401/403 — 토큰이 없거나 만료·폐기됐다 */
export class McpAuthError extends Error {
	readonly status: number;
	/** WWW-Authenticate 헤더 원문 (resource_metadata·scope 를 읽는다) */
	readonly wwwAuthenticate: string | null;
	constructor(status: number, wwwAuthenticate: string | null, message?: string) {
		super(message ?? `MCP 서버가 인증을 거부했습니다 (HTTP ${status})`);
		this.status = status;
		this.wwwAuthenticate = wwwAuthenticate;
	}
}

export class McpHttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** JSON-RPC 오류 응답 */
export class McpRpcError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

export interface McpSessionOptions {
	url: string;
	fetch: FetchLike;
	/** 요청마다 부른다 — 갱신된 토큰이 바로 쓰이게 */
	headers: () => Promise<Record<string, string>> | Record<string, string>;
	/** 401/403 을 받으면 부른다. true 면 (토큰을 갱신했으니) 한 번 다시 보낸다 */
	onUnauthorized?: () => Promise<boolean>;
	timeoutMs?: number;
}

interface RpcMessage {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 10;

export class McpSession {
	private readonly opts: McpSessionOptions;
	private sessionId: string | null = null;
	private protocolVersion: string | null = null;
	private ready: Promise<void> | null = null;
	private nextId = 1;
	/** 서버 안내문 (initialize 의 instructions) — 모델에게 보여줄 수 있다 */
	instructions: string | null = null;
	serverName: string | null = null;

	constructor(opts: McpSessionOptions) {
		this.opts = opts;
	}

	async listTools(): Promise<McpTool[]> {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_LIST_PAGES; page++) {
			const r = (await this.request("tools/list", cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string };
			tools.push(...(r.tools ?? []).filter((t) => t && typeof t.name === "string"));
			if (!r.nextCursor) break;
			cursor = r.nextCursor;
		}
		return tools;
	}

	async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<McpCallResult> {
		return (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as McpCallResult;
	}

	/** 세션 종료 (최선) — 실패해도 상관없다 */
	async close(): Promise<void> {
		if (!this.sessionId) return;
		const headers = { ...(await this.opts.headers()), "mcp-session-id": this.sessionId };
		this.sessionId = null;
		this.ready = null;
		await this.opts.fetch(this.opts.url, { method: "DELETE", headers, signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
	}

	private async request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
		await this.initialize();
		try {
			return await this.rpc(method, params, timeoutMs);
		} catch (err) {
			// 세션 만료 — 규격상 404. 새 세션으로 한 번만 다시
			if (err instanceof McpHttpError && err.status === 404 && this.sessionId) {
				this.sessionId = null;
				this.ready = null;
				await this.initialize();
				return this.rpc(method, params, timeoutMs);
			}
			throw err;
		}
	}

	private initialize(): Promise<void> {
		if (!this.ready) {
			this.ready = (async () => {
				const r = (await this.rpc("initialize", {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: CLIENT_INFO,
				})) as { protocolVersion?: string; instructions?: string; serverInfo?: { name?: string } };
				this.protocolVersion = r.protocolVersion ?? PROTOCOL_VERSION;
				this.instructions = typeof r.instructions === "string" ? r.instructions : null;
				this.serverName = r.serverInfo?.name ?? null;
				await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
			})().catch((err: unknown) => {
				this.ready = null; // 실패는 캐시하지 않는다 — 토큰을 고치면 다시 시도할 수 있어야 한다
				throw err;
			});
		}
		return this.ready;
	}

	private async rpc(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
		const id = this.nextId++;
		const reply = await this.send({ jsonrpc: "2.0", id, method, params }, timeoutMs);
		if (!reply) throw new McpHttpError(502, `MCP 서버가 ${method} 에 응답하지 않았습니다`);
		if (reply.error) throw new McpRpcError(reply.error.code, `MCP 오류 (${reply.error.code}): ${reply.error.message}`);
		return reply.result ?? {};
	}

	/** 보내고, id 가 있으면 그 응답을 돌려준다. 알림(id 없음)은 202 를 기대한다. */
	private async send(message: RpcMessage, timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, retried = false): Promise<RpcMessage | null> {
		const headers: Record<string, string> = {
			...(await this.opts.headers()),
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
		if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;

		const signal = AbortSignal.timeout(timeoutMs);
		let res: Response;
		try {
			res = await this.opts.fetch(this.opts.url, { method: "POST", headers, body: JSON.stringify(message), signal });
		} catch (err) {
			if (signal.aborted) throw new McpHttpError(504, `MCP 서버 응답 시간 초과 (${Math.round(timeoutMs / 1000)}초)`);
			throw new McpHttpError(502, `MCP 서버에 연결하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
		}

		if (res.status === 401 || res.status === 403) {
			const www = res.headers.get("www-authenticate");
			await res.body?.cancel().catch(() => undefined);
			if (!retried && this.opts.onUnauthorized && (await this.opts.onUnauthorized())) {
				return this.send(message, timeoutMs, true);
			}
			throw new McpAuthError(res.status, www);
		}

		if (message.method === "initialize") {
			const sid = res.headers.get("mcp-session-id");
			if (sid) this.sessionId = sid;
		}

		if (res.status >= 300 && res.status < 400) {
			await res.body?.cancel().catch(() => undefined);
			throw new McpHttpError(res.status, `MCP 서버가 다른 주소로 보냈습니다 (HTTP ${res.status}) — 따라가지 않습니다. URL 을 확인하세요`);
		}
		if (!res.ok) {
			const text = (await res.text().catch(() => "")).slice(0, 300);
			throw new McpHttpError(res.status, `MCP 서버 오류 (HTTP ${res.status})${text ? `: ${text}` : ""}`);
		}

		if (message.id === undefined) {
			await res.body?.cancel().catch(() => undefined);
			return null;
		}

		const type = res.headers.get("content-type") ?? "";
		if (type.includes("text/event-stream")) return readSseReply(res, message.id);

		const body = (await res.json().catch(() => null)) as RpcMessage | RpcMessage[] | null;
		const list = Array.isArray(body) ? body : body ? [body] : [];
		return list.find((m) => m && m.id === message.id && (m.result !== undefined || m.error !== undefined)) ?? null;
	}
}

/**
 * SSE 에서 우리 요청의 응답을 찾는다. 서버가 보내는 진행 알림(notifications/progress 등)은 건너뛴다.
 * 응답을 받으면 스트림을 닫는다.
 */
export async function readSseReply(res: Response, id: number | string): Promise<RpcMessage | null> {
	if (!res.body) return null;
	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	let data: string[] = [];

	const dispatch = (): RpcMessage | null => {
		if (data.length === 0) return null;
		const payload = data.join("\n");
		data = [];
		try {
			const parsed = JSON.parse(payload) as RpcMessage | RpcMessage[];
			for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
				if (m && m.id === id && (m.result !== undefined || m.error !== undefined)) return m;
			}
		} catch {
			/* JSON 이 아닌 이벤트는 무시 */
		}
		return null;
	};

	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (value) buffer += value;
			let nl: number;
			while ((nl = buffer.search(/\r?\n/)) >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(buffer[nl] === "\r" ? nl + 2 : nl + 1);
				if (line === "") {
					const hit = dispatch();
					if (hit) return hit;
				} else if (line.startsWith("data:")) {
					data.push(line.slice(5).replace(/^ /, ""));
				}
				// event:·id:·retry:·주석(:) 은 쓰지 않는다
			}
			if (done) return dispatch();
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}
