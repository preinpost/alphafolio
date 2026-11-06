/** HTTP 공용 — 본문 크기·형식 검증, 보안 헤더·CSP, 라우트 표. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { API_CSP, applySecurityHeaders, AUTH_BODY_LIMIT, HttpError, inlineScriptHashes, readBody, readJson, webCsp } from "../src/http.ts";
import { dispatch, RESPONDED, type Route } from "../src/routes.ts";

function req(body: string | undefined, method = "POST", headers: Record<string, string> = {}): IncomingMessage {
	const r = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as IncomingMessage;
	r.method = method;
	r.headers = headers;
	return r;
}

async function status(p: Promise<unknown>): Promise<number> {
	try {
		await p;
	} catch (err) {
		assert.ok(err instanceof HttpError, String(err));
		return err.status;
	}
	return 200;
}

/** 헤더·상태·본문만 모으는 가짜 응답 */
function fakeRes() {
	const headers: Record<string, string> = {};
	const out = { status: 0, body: "", headers };
	const res = {
		headersSent: false,
		setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = v),
		writeHead: (s: number, h?: Record<string, string>) => {
			out.status = s;
			for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = v;
		},
		end: (b?: string) => void (out.body = b ?? ""),
	};
	return { res: res as unknown as ServerResponse, out };
}

describe("readJson", () => {
	it("빈 본문은 {}", async () => {
		assert.deepEqual(await readJson(req(undefined)), {});
	});
	it("객체가 아닌 JSON 은 400", async () => {
		for (const b of ["null", "[]", "1", '"x"']) assert.equal(await status(readJson(req(b))), 400, b);
		assert.equal(await status(readJson(req("{bad"))), 400);
	});
	it("상한을 넘으면 413 — 기본 1MB, 인증 경로 4KB", async () => {
		const big = JSON.stringify({ user: "x".repeat(AUTH_BODY_LIMIT) });
		assert.equal(await status(readJson(req(big), { limit: AUTH_BODY_LIMIT })), 413);
		assert.equal(await status(readJson(req(big))), 200);
		assert.equal(await status(readJson(req(JSON.stringify({ a: "x".repeat(1_000_001) })))), 413);
	});
	it("content-length 가 상한을 넘으면 읽기 전에 413", async () => {
		assert.equal(await status(readJson(req("{}", "POST", { "content-length": "999999" }), { limit: AUTH_BODY_LIMIT })), 413);
	});
});

describe("readBody", () => {
	const S = Type.Object({ user: Type.String(), password: Type.String() });
	it("스키마에 맞으면 그대로", async () => {
		assert.deepEqual(await readBody(req('{"user":"a","password":"b"}'), S), { user: "a", password: "b" });
	});
	it("빠졌거나 타입이 다르면 400 과 위치", async () => {
		await assert.rejects(readBody(req('{"user":1,"password":"b"}'), S), (err: unknown) => {
			assert.ok(err instanceof HttpError);
			assert.equal(err.status, 400);
			assert.match(err.message, /user/);
			return true;
		});
		assert.equal(await status(readBody(req('{"user":"a"}'), S)), 400);
		assert.equal(await status(readBody(req(undefined), S)), 400);
	});
});

describe("보안 헤더", () => {
	it("nosniff · DENY · referrer · CSP 를 붙인다", () => {
		const { res, out } = fakeRes();
		applySecurityHeaders(res, API_CSP);
		assert.equal(out.headers["x-content-type-options"], "nosniff");
		assert.equal(out.headers["x-frame-options"], "DENY");
		assert.equal(out.headers["referrer-policy"], "strict-origin-when-cross-origin");
		assert.match(out.headers["content-security-policy"] ?? "", /frame-ancestors 'none'/);
	});
	it("웹 CSP 는 인라인 스크립트를 해시로만 허용하고 ws·웹폰트를 연다", () => {
		const html = `<head><script>(function(){ theme() })();</script><script type="module" src="/a.js"></script></head>`;
		const hashes = inlineScriptHashes(html);
		const expected = `sha256-${createHash("sha256").update("(function(){ theme() })();").digest("base64")}`;
		assert.deepEqual(hashes, [expected]);
		const csp = webCsp(hashes);
		assert.match(csp, new RegExp(`script-src 'self' '${expected.replace(/[+/]/g, "\\$&")}'`));
		assert.doesNotMatch(csp.split(";").find((x) => x.includes("script-src")) ?? "", /unsafe-inline/);
		assert.match(csp, /connect-src 'self' ws: wss:/);
		assert.match(csp, /fonts\.gstatic\.com/);
		assert.match(csp, /frame-ancestors 'none'/);
	});
});

describe("라우트 표", () => {
	const routes: Route[] = [
		{ method: "GET", path: "/api/a", handle: () => ({ a: 1 }) },
		{ path: (p) => p.startsWith("/api/p/"), handle: () => undefined },
		{ path: "/api/raw", handle: ({ res }) => (res.writeHead(204), res.end(), RESPONDED) },
	];
	const ctx = (method: string, path: string) => {
		const f = fakeRes();
		return { f, c: { req: { method } as IncomingMessage, res: f.res, url: new URL(path, "http://x"), path } };
	};
	it("맞는 라우트의 값을 200 JSON 으로", async () => {
		const { f, c } = ctx("GET", "/api/a");
		assert.equal(await dispatch(routes, c), true);
		assert.equal(f.out.status, 200);
		assert.deepEqual(JSON.parse(f.out.body), { a: 1 });
	});
	it("메서드가 다르거나 없는 경로면 false (다음 단계로)", async () => {
		assert.equal(await dispatch(routes, ctx("POST", "/api/a").c), false);
		assert.equal(await dispatch(routes, ctx("GET", "/api/zz").c), false);
	});
	it("접두사만 맞고 하위가 없으면 404", async () => {
		assert.equal(await status(dispatch(routes, ctx("GET", "/api/p/x").c)), 404);
	});
	it("직접 응답한 라우트는 건드리지 않는다", async () => {
		const { f, c } = ctx("GET", "/api/raw");
		assert.equal(await dispatch(routes, c), true);
		assert.equal(f.out.status, 204);
	});
});
