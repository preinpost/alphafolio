/**
 * 사용자별 MCP 서버 · OAuth 흐름 테스트 (PLAN §38).
 *
 * 실제 SQL(인메모리 SQLite)과 가짜 인가 서버로 연결 → 콜백 → 저장 → 갱신 → 해제를 끝까지 돈다.
 * 핵심: 토큰이 평문으로 DB 에 남지 않는다 / state 는 1회용·사용자 고정 / 동시 갱신은 한 번만 / 갱신 거절이면 "다시 연결".
 */
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { migrate } from "@alphafolio/ledger";
import { McpNeedsAuthError } from "@alphafolio/mcp";
import { createMcpTools } from "@alphafolio/mcp/tools";
import { installFakeD1, type FakeD1 } from "../../../packages/ledger/test/fake-d1.ts";
import { createFakeServer, MCP_URL, type FakeServer } from "../../../packages/mcp/test/fake-server.ts";
import { parsePublicUrl } from "../src/config.ts";
import { McpAuthManager } from "../src/mcp-auth.ts";
import { handleMcp, handleMcpCallback, mcpConfirmSecret, mcpHandles, prepareMcpWrite, type McpApiDeps, type McpExecuteResult, type McpWritePayload } from "../src/mcp-api.ts";
import { OrderTokenGuard } from "../src/order-tokens.ts";
import { McpConfigError, McpStore, normalizeHeaders } from "../src/mcp-store.ts";

const SECRET = "test-secret";
const PUBLIC = "https://af.example.com";
const policy = { allowPrivate: false };

let d1: FakeD1;
let srv: FakeServer;
let store: McpStore;
let auth: McpAuthManager;
let clock: number;
let deps: McpApiDeps;
/** 가짜 MCP 서버가 받아 주는 토큰 = 가장 최근 발급분 */
const latest = () => srv.issued.access.at(-1) ?? "none";

beforeEach(async () => {
	d1 = installFakeD1();
	await migrate(d1.cfg);
	srv = createFakeServer({ acceptToken: latest, rotateRefresh: true, tools: [{ name: "get_quote" }, { name: "delete_alert" }] });
	clock = Date.parse("2026-09-24T00:00:00Z");
	store = new McpStore(() => d1.cfg, SECRET, policy);
	await store.load();
	auth = new McpAuthManager({ store, publicUrl: PUBLIC, fetch: srv.fetch, policy, now: () => clock });
	deps = { store, auth, fetch: srv.fetch, publicUrl: PUBLIC, confirm: { secret: mcpConfirmSecret(SECRET), guard: new OrderTokenGuard<McpWritePayload>() } };
});
afterEach(() => d1.restore());

async function addOAuth(user = "ms"): Promise<string> {
	const rec = await store.add(user, { name: "Example", url: MCP_URL, auth: "oauth" });
	return rec.id;
}

/** 연결 버튼 → 인가 화면(가짜) → 콜백 */
async function connect(user: string, id: string): Promise<URLSearchParams> {
	const { url } = await auth.start(user, id, "web");
	const state = new URL(url).searchParams.get("state") as string;
	const code = srv.authorize(url);
	return new URLSearchParams({ code, state });
}

const tokenRequests = (grant: string) => srv.log.filter((l) => l.url.endsWith("/oauth/token") && l.body?.includes(`grant_type=${grant}`)).length;

describe("MCP 서버 설정", () => {
	it("https 원격만, 이름·주소 중복 거절, 사용자별로 분리", async () => {
		await assert.rejects(store.add("ms", { name: "x", url: "http://mcp.example.com/mcp", auth: "none" }), McpConfigError);
		await assert.rejects(store.add("ms", { name: "x", url: "https://192.168.0.2/mcp", auth: "none" }), McpConfigError);
		await addOAuth("ms");
		await assert.rejects(store.add("ms", { name: "Other", url: MCP_URL, auth: "none" }), /이미 추가한 주소/);
		await assert.rejects(store.add("ms", { name: "example", url: "https://b.example.com/mcp", auth: "none" }), /같은 이름/);
		assert.equal(store.list("ms").length, 1);
		assert.equal(store.list("kim").length, 0);
	});

	it("고정 헤더: 프로토콜 헤더는 못 넣고, 값은 암호화돼 화면에는 이름만", async () => {
		assert.throws(() => normalizeHeaders({ "mcp-session-id": "x" }), /직접 넣을 수 없는/);
		assert.throws(() => normalizeHeaders({ host: "internal" }), /직접 넣을 수 없는/);
		assert.throws(() => normalizeHeaders({ "x-a": "v\r\nx-b: 1" }), /올바르지 않습니다/);
		await store.add("ms", { name: "Keyed", url: "https://k.example.com/mcp", auth: "headers", headers: normalizeHeaders({ Authorization: "Bearer sk-live-SECRET" }) });
		const [status] = store.status("ms");
		assert.deepEqual(status?.headerNames, ["authorization"]);
		assert.equal(JSON.stringify(status).includes("sk-live"), false);
		const raw = JSON.stringify(d1.db.prepare("SELECT * FROM user_mcp_servers").all());
		assert.equal(raw.includes("sk-live"), false);
		// 재적재하면 복호화된다
		const again = new McpStore(() => d1.cfg, SECRET, policy);
		await again.load();
		assert.equal(again.list("ms")[0]?.headers?.authorization, "Bearer sk-live-SECRET");
	});
});

describe("OAuth 연결", () => {
	it("start → 콜백 → 토큰 저장(암호화). DCR 은 서버 전역 1회, 재기동 후에도 재사용", async () => {
		const id = await addOAuth("ms");
		assert.equal(store.status("ms")[0]?.connected, false);
		const r = await auth.callback(await connect("ms", id));
		assert.equal(r.ok, true, r.message);
		assert.equal(store.status("ms")[0]?.connected, true);

		const raw = JSON.stringify(d1.db.prepare("SELECT * FROM user_mcp_servers").all());
		assert.equal(raw.includes(latest()), false, "access token 평문 저장");
		assert.equal(srv.registered.length, 1);
		assert.equal(srv.registered[0]?.redirect_uris?.toString(), `${PUBLIC}/api/mcp/oauth/callback`);

		// 다른 사용자도 같은 인가 서버 → 등록 재사용. 재기동(새 스토어)해도 D1 에서 읽는다
		const store2 = new McpStore(() => d1.cfg, SECRET, policy);
		await store2.load();
		const auth2 = new McpAuthManager({ store: store2, publicUrl: PUBLIC, fetch: srv.fetch, policy, now: () => clock });
		const rec = await store2.add("kim", { name: "Example", url: MCP_URL, auth: "oauth" });
		await auth2.start("kim", rec.id, "app");
		assert.equal(srv.registered.length, 1);
		assert.equal(store2.list("ms")[0]?.oauth?.tokens.accessToken, latest());
	});

	it("state 는 1회용이고 10분 뒤 만료. 거절(access_denied)은 안내만", async () => {
		const id = await addOAuth();
		const { url: first } = await auth.start("ms", id, "web");
		const state = new URL(first).searchParams.get("state") as string;
		assert.equal((await auth.callback(new URLSearchParams({ state, code: srv.authorize(first) }))).ok, true);
		// 같은 state 재사용 — 인가 서버가 새 코드를 줬더라도 거절 (state 자체가 1회용)
		const reuse = await auth.callback(new URLSearchParams({ state, code: srv.authorize(first) }));
		assert.equal(reuse.ok, false);
		assert.match(reuse.message, /만료됐거나/);

		const q2 = await connect("ms", id);
		clock += 11 * 60_000;
		assert.match((await auth.callback(q2)).message, /만료/);

		const { url } = await auth.start("ms", id, "web");
		const denied = await auth.callback(new URLSearchParams({ state: new URL(url).searchParams.get("state") as string, error: "access_denied" }));
		assert.equal(denied.ok, false);
		assert.match(denied.message, /취소/);
		assert.equal(await auth.callback(new URLSearchParams({ state: "guess", code: "x" })).then((r) => r.ok), false);
	});

	it("AF_PUBLIC_URL 이 없으면 시작하지 않는다 (Host 헤더로 추측하지 않음)", async () => {
		const id = await addOAuth();
		const noUrl = new McpAuthManager({ store, publicUrl: undefined, fetch: srv.fetch, policy });
		await assert.rejects(noUrl.start("ms", id, "web"), /AF_PUBLIC_URL/);
		assert.equal(parsePublicUrl(" https://af.example.com/ "), "https://af.example.com");
		assert.equal(parsePublicUrl(""), undefined);
		assert.throws(() => parsePublicUrl("af.example.com"), /URL 형식/);
	});
});

describe("토큰 갱신", () => {
	it("만료 임박이면 호출 전에 갱신 — 동시 요청 5개에도 refresh 는 한 번 (회전 서버에서 토큰을 잃지 않게)", async () => {
		const id = await addOAuth();
		await auth.callback(await connect("ms", id));
		clock += 3600_000; // 만료
		const headers = await Promise.all(Array.from({ length: 5 }, () => auth.accessHeaders("ms", id)));
		assert.equal(tokenRequests("refresh_token"), 1);
		assert.equal(new Set(headers.map((h) => h.authorization)).size, 1);
		assert.equal(headers[0]?.authorization, `Bearer ${latest()}`);
		// 회전된 refresh token 이 저장됐다 — 한 번 더 갱신해도 된다
		clock += 3600_000;
		await auth.accessHeaders("ms", id);
		assert.equal(tokenRequests("refresh_token"), 2);
	});

	it("갱신 거절(invalid_grant)이면 토큰을 지우고 '다시 연결' — 네트워크 오류는 지우지 않는다", async () => {
		const id = await addOAuth();
		await auth.callback(await connect("ms", id));
		clock += 3600_000;
		srv.failNextToken = { status: 500, error: "server_error" };
		await assert.rejects(auth.accessHeaders("ms", id), /server_error/);
		assert.equal(store.status("ms")[0]?.connected, true);

		srv.failNextToken = { status: 400, error: "invalid_grant" };
		await assert.rejects(auth.accessHeaders("ms", id), McpNeedsAuthError);
		const s = store.status("ms")[0];
		assert.equal(s?.connected, false);
		assert.match(s?.problem ?? "", /만료/);
	});

	it("mcp_call 끝까지: 서버가 401 을 주면 한 번 갱신 후 재시도, 쓰기 툴은 쓰기 목록으로", async () => {
		const id = await addOAuth();
		await auth.callback(await connect("ms", id));
		const [tool] = createMcpTools({ servers: () => mcpHandles(deps, "ms"), fetch: srv.fetch });
		const run = async (p: Record<string, unknown>) =>
			((await tool!.execute("id", p as never, undefined, undefined, undefined as never)) as { content: Array<{ text: string }> }).content[0]!.text;

		const list = await run({});
		assert.match(list, /get_quote/);
		assert.match(list, /쓰기 \(사용자가 요청했을 때만\):\n- delete_alert/);

		// 서버 쪽에서 토큰이 폐기된 상황 — 가짜 서버가 새 토큰만 받게 만든다
		srv.issued.access.push("server-side-rotated");
		const before = tokenRequests("refresh_token");
		// 갱신되면 latest() 가 새로 발급된 토큰이 된다
		assert.match(await run({ tool: "get_quote", arguments: {} }), /called get_quote/);
		assert.equal(tokenRequests("refresh_token"), before + 1);
	});
});

describe("쓰기 확인 카드 → 실행 (PLAN §39)", () => {
	/** handleMcp 에 넣을 가짜 요청 */
	const post = (body: unknown) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST" }) as unknown as IncomingMessage;
	const execute = (user: string, token: string) => handleMcp(post({ token }), "/api/mcp/execute", user, deps) as Promise<McpExecuteResult>;
	const calls = () => srv.log.filter((l) => l.rpc === "tools/call");

	/** mcp_call 로 쓰기를 준비해 카드를 받는다 (실제 서버와 같은 발급기) */
	async function prepare(user = "ms", args: Record<string, unknown> = { alert_ids: [7] }) {
		const [tool] = createMcpTools({ servers: () => mcpHandles(deps, user), fetch: srv.fetch, prepareWrite: prepareMcpWrite(deps, user) });
		const r = (await tool!.execute("id", { tool: "delete_alert", arguments: args } as never, undefined, undefined, undefined as never)) as {
			details: { kind: string; token: string };
		};
		assert.equal(r.details.kind, "mcp-confirm-card");
		return r.details.token;
	}

	beforeEach(async () => {
		await auth.callback(await connect("ms", await addOAuth("ms")));
	});

	it("준비는 실행하지 않는다 — [확인] 을 눌러야 준비한 인자 그대로 한 번 나간다. 같은 카드를 다시 누르면 거절", async () => {
		const token = await prepare();
		assert.equal(calls().length, 0);
		const r = await execute("ms", token);
		// JSON 이 아닌 응답은 요약 없이 본문이 곧 내용
		assert.deepEqual(r, { ok: true, message: "Example 에서 실행했습니다", summary: [], detail: "called delete_alert", raw: "called delete_alert" });
		assert.equal(calls().length, 1);
		assert.deepEqual(JSON.parse(calls()[0]!.body ?? "{}").params, { name: "delete_alert", arguments: { alert_ids: [7] } });
		await assert.rejects(execute("ms", token), /이미 처리한 요청/);
		assert.equal(calls().length, 1);
	});

	it("다른 사용자·변조한 토큰·주문 키로 서명한 토큰은 거절 (MCP 토큰과 주문 토큰은 서로 못 쓴다)", async () => {
		const token = await prepare();
		await assert.rejects(execute("kim", token), /다른 사용자/);
		// 인자를 바꿔치기 — 서명이 깨진다
		const [body, mac] = token.split(".");
		const payload = JSON.parse(Buffer.from(body as string, "base64url").toString()) as McpWritePayload;
		payload.mcp.args = { alert_ids: [1, 2, 3] };
		await assert.rejects(execute("ms", `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${mac}`), /올바르지 않습니다/);
		// 주문 실행기(마스터 키)로 검증하면 서명 불일치 — 반대 방향도 같다
		assert.deepEqual(new OrderTokenGuard().verify(token, SECRET, "ms"), { ok: false, reason: "bad-signature" });
		assert.equal(calls().length, 0);
	});

	it("준비 뒤 서버를 지웠거나 다른 주소로 바꿨으면 보내지 않는다", async () => {
		const token = await prepare();
		const rec = store.get("ms", store.list("ms")[0]!.id)!;
		rec.url = "https://other.example.com/mcp";
		await assert.rejects(execute("ms", token), /주소가 바뀌었습니다/);
		const token2 = await (async () => {
			rec.url = MCP_URL;
			return prepare();
		})();
		await store.remove("ms", rec.id);
		await assert.rejects(execute("ms", token2), /삭제됐습니다/);
		assert.equal(calls().length, 0);
	});

	it("MCP 서버가 거절(isError)하면 ok:false + 서버 메시지", async () => {
		const failing = createFakeServer({ acceptToken: latest, tools: [{ name: "delete_alert" }], callResult: () => ({ isError: true, content: [{ type: "text", text: "alert 7 not found" }] }) });
		deps = { ...deps, fetch: (url, init) => (url.startsWith(MCP_URL) ? failing.fetch(url, init) : srv.fetch(url, init)) };
		const token = await prepare();
		assert.deepEqual(await execute("ms", token), { ok: false, message: "Example 가 거절했습니다", summary: [], detail: "alert 7 not found", raw: "alert 7 not found" });
	});

	it("JSON 응답은 요약 줄 + 원본(들여쓰기)으로 — 본문에 JSON 을 늘어놓지 않는다", async () => {
		const payload = { success: true, data: { id: "wl-9", name: "반도체", symbols: ["NASDAQ:NVDA", "NASDAQ:AMD"], logoid: "x" } };
		const jsonSrv = createFakeServer({ acceptToken: latest, tools: [{ name: "delete_alert" }], callResult: () => ({ content: [{ type: "text", text: JSON.stringify(payload) }] }) });
		deps = { ...deps, fetch: (url, init) => (url.startsWith(MCP_URL) ? jsonSrv.fetch(url, init) : srv.fetch(url, init)) };
		const r = await execute("ms", await prepare());
		assert.deepEqual(r.summary, [
			{ label: "id", value: "wl-9" },
			{ label: "name", value: "반도체" },
			{ label: "success", value: "예" },
			{ label: "symbols", value: "NASDAQ:NVDA, NASDAQ:AMD" },
		]);
		assert.equal(r.detail, "");
		assert.equal(r.raw, JSON.stringify(payload, null, 2));
	});
});

describe("연결 해제 · 콜백 응답", () => {
	it("해제하면 두 토큰을 폐기 요청하고 저장분을 지운다", async () => {
		const id = await addOAuth();
		await auth.callback(await connect("ms", id));
		const rec = store.get("ms", id);
		const { accessToken, refreshToken } = rec?.oauth?.tokens ?? { accessToken: "" };
		await auth.disconnect("ms", id);
		assert.deepEqual(new Set(srv.revoked), new Set([accessToken, refreshToken]));
		assert.equal(store.get("ms", id)?.oauth, undefined);
		assert.equal(d1.db.prepare("SELECT tokens_enc FROM user_mcp_servers").get()?.tokens_enc, null);
	});

	function fakeRes() {
		const out: { status?: number; headers?: Record<string, string>; body?: string } = {};
		const res = {
			writeHead: (s: number, h: Record<string, string>) => ((out.status = s), (out.headers = h), res),
			end: (b?: string) => void (out.body = b),
		};
		return { res: res as unknown as ServerResponse, out };
	}

	it("웹은 설정 화면으로 302, 앱은 완료 페이지 (메시지는 이스케이프)", async () => {
		const id = await addOAuth();
		const web = fakeRes();
		await handleMcpCallback(new URL(`${PUBLIC}/api/mcp/oauth/callback?${await connect("ms", id)}`), web.res, deps);
		assert.equal(web.out.status, 302);
		const loc = new URL(web.out.headers?.location ?? "");
		assert.equal(loc.pathname, "/settings/connect");
		assert.equal(loc.searchParams.get("mcp"), "ok");

		const { url } = await auth.start("ms", id, "app");
		const state = new URL(url).searchParams.get("state") as string;
		const app = fakeRes();
		await handleMcpCallback(new URL(`${PUBLIC}/cb?state=${state}&error=x&error_description=${encodeURIComponent("<script>alert(1)</script>")}`), app.res, deps);
		assert.equal(app.out.status, 400);
		assert.match(app.out.headers?.["content-type"] ?? "", /text\/html/);
		assert.match(app.out.headers?.["content-security-policy"] ?? "", /default-src 'none'/);
		assert.doesNotMatch(app.out.body ?? "", /<script>/);
		assert.match(app.out.body ?? "", /&lt;script&gt;/);
	});
});
