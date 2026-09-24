/**
 * 서버별 세션·툴 목록 캐시.
 *
 * 툴 호출마다 initialize 를 다시 하면 왕복이 두 번 늘고, 툴 목록을 매번 받으면 35개 스키마가 매번 온다.
 * 설정(version)이 바뀌면 새 세션을 연다. 토큰은 세션에 박지 않는다 — 요청마다 handle.headers() 로 읽는다.
 */
import { McpSession, type McpTool } from "./client.ts";
import type { FetchLike } from "./net.ts";
import type { McpPreset } from "./policy.ts";

export interface McpServerHandle {
	/** 사용자 안에서 유일 */
	id: string;
	name: string;
	url: string;
	preset?: McpPreset;
	/** OAuth 서버인데 토큰이 없으면 needs_auth — 호출하지 않고 설정 안내 */
	state: "ready" | "needs_auth";
	/** 설정이 바뀌면 달라진다 (캐시 키) */
	version: string;
	/** 요청마다 부른다. 토큰을 쓸 수 없으면 McpNeedsAuthError */
	headers: () => Promise<Record<string, string>>;
	/** 401 을 받았을 때 — 토큰을 갱신했으면 true (한 번 재시도) */
	onUnauthorized?: () => Promise<boolean>;
}

/** 저장된 자격증명으로는 안 된다 — 사람이 설정에서 다시 연결해야 한다 */
export class McpNeedsAuthError extends Error {}

const TOOLS_TTL_MS = 10 * 60_000;

interface Entry {
	version: string;
	session: McpSession;
	tools?: { list: McpTool[]; at: number };
}

export class McpPool {
	private readonly fetch: FetchLike;
	private readonly entries = new Map<string, Entry>();
	private readonly now: () => number;

	constructor(fetch: FetchLike, now: () => number = Date.now) {
		this.fetch = fetch;
		this.now = now;
	}

	session(h: McpServerHandle): McpSession {
		const hit = this.entries.get(h.id);
		if (hit && hit.version === h.version) return hit.session;
		if (hit) void hit.session.close();
		const session = new McpSession({
			url: h.url,
			fetch: this.fetch,
			headers: () => h.headers(),
			...(h.onUnauthorized ? { onUnauthorized: h.onUnauthorized } : {}),
		});
		this.entries.set(h.id, { version: h.version, session });
		return session;
	}

	async tools(h: McpServerHandle, refresh = false): Promise<McpTool[]> {
		const session = this.session(h);
		const entry = this.entries.get(h.id) as Entry;
		if (!refresh && entry.tools && this.now() - entry.tools.at < TOOLS_TTL_MS) return entry.tools.list;
		const list = await session.listTools();
		entry.tools = { list, at: this.now() };
		return list;
	}

	/** 설정 삭제·연결 해제 때 */
	drop(id: string): void {
		const hit = this.entries.get(id);
		if (!hit) return;
		this.entries.delete(id);
		void hit.session.close();
	}

	/** 사용자의 현재 서버 목록에 없는 항목 정리 */
	retain(ids: Iterable<string>): void {
		const keep = new Set(ids);
		for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.drop(id);
	}
}
