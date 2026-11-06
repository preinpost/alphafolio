/**
 * HTTP 공용 — 오류 타입, JSON 본문 읽기·검증, 응답, 보안 헤더.
 *
 * 라우트 모듈(*-api.ts)은 여기 것만 쓴다. 본문은 typebox 스키마로 검증해 400 으로 돌려보낸다 —
 * `String(body.x ?? "")` 로 아무 값이나 문자열로 바꿔 넘기면 잘못된 요청이 도메인 오류나 500 으로 섞인다.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** 본문 크기 기본 상한 — 이미지 첨부는 WebSocket 으로 오므로 REST 는 이 정도면 넉넉하다 */
export const DEFAULT_BODY_LIMIT = 1_000_000;
/** 로그인·가입 — 아이디·비밀번호·코드뿐이다. 큰 본문으로 해시 계산·파싱을 시키지 못하게 */
export const AUTH_BODY_LIMIT = 4 * 1024;

export interface ReadOptions {
	/** 바이트 상한 (기본 1MB) */
	limit?: number;
}

/** JSON 객체 본문. 빈 본문은 {} — 객체가 아닌 JSON(배열·null·숫자)은 400 */
export async function readJson(req: IncomingMessage, opts: ReadOptions = {}): Promise<Record<string, unknown>> {
	const limit = opts.limit ?? DEFAULT_BODY_LIMIT;
	// 선언된 길이가 넘으면 읽지도 않는다
	const declared = Number(req.headers?.["content-length"]);
	if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, "요청 본문이 너무 큽니다");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > limit) throw new HttpError(413, "요청 본문이 너무 큽니다");
		chunks.push(buf);
	}
	if (chunks.length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "JSON 파싱 실패");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "요청 본문은 JSON 객체여야 합니다");
	return parsed as Record<string, unknown>;
}

/** 스키마에 맞지 않으면 400 — 첫 오류의 위치와 이유를 알려 준다 */
export function validate<S extends TSchema>(schema: S, value: unknown): Static<S> {
	if (Value.Check(schema, value)) return value as Static<S>;
	const first = [...Value.Errors(schema, value)][0];
	const where = first?.instancePath ? first.instancePath.slice(1).replace(/\//g, ".") : "본문";
	throw new HttpError(400, `요청 형식이 올바르지 않습니다: ${where} — ${first?.message ?? "형식 오류"}`);
}

/** 본문 읽기 + 검증 */
export async function readBody<S extends TSchema>(req: IncomingMessage, schema: S, opts: ReadOptions = {}): Promise<Static<S>> {
	return validate(schema, await readJson(req, opts));
}

export function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(payload);
}

// ── 보안 헤더 ─────────────────────────────────────────────────────

/** 모든 응답 공통 */
export const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
	"referrer-policy": "strict-origin-when-cross-origin",
};

/** API 응답은 문서가 아니다 — 아무것도 불러오지 못하게 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * 웹 앱 CSP.
 * - 스크립트: 번들(self) + index.html 의 인라인 테마 스크립트(해시) — 'unsafe-inline' 없이
 * - 스타일: React style 속성·웹폰트 CSS(jsdelivr·Google Fonts) 때문에 'unsafe-inline' + 두 출처
 * - 이미지: 첨부 미리보기(data:·blob:), 대화 속 외부 이미지(https:)
 * - 연결: 같은 출처 REST + /ws (ws:/wss: 는 'self' 를 ws 로 넓히지 않는 브라우저 대비)
 */
export function webCsp(inlineScriptHashes: readonly string[]): string {
	return [
		"default-src 'self'",
		`script-src 'self'${inlineScriptHashes.map((h) => ` '${h}'`).join("")}`,
		"style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
		"font-src 'self' data: https://cdn.jsdelivr.net https://fonts.gstatic.com",
		"img-src 'self' data: blob: https:",
		"connect-src 'self' ws: wss:",
		"worker-src 'self'",
		"manifest-src 'self'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
}

/** HTML 의 인라인 <script>(src 없음) 본문 해시 — CSP 'sha256-…' */
export function inlineScriptHashes(html: string): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
		if (/\bsrc\s*=/i.test(m[1] ?? "")) continue;
		const body = m[2] ?? "";
		if (!body.trim()) continue;
		out.push(`sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`);
	}
	return out;
}

/** 웹 빌드의 CSP — index.html 이 바뀌면(재빌드) 해시를 다시 계산한다 */
export function webCspProvider(webDir: string): () => string {
	let cached: { mtimeMs: number; csp: string } | null = null;
	return () => {
		const file = join(webDir, "index.html");
		try {
			const { mtimeMs } = statSync(file);
			if (cached?.mtimeMs !== mtimeMs) cached = { mtimeMs, csp: webCsp(inlineScriptHashes(readFileSync(file, "utf8"))) };
			return cached.csp;
		} catch {
			return webCsp([]); // 미빌드 — 안내 문구만 나간다
		}
	};
}

export function applySecurityHeaders(res: ServerResponse, csp: string): void {
	for (const [k, v] of Object.entries(BASE_SECURITY_HEADERS)) res.setHeader(k, v);
	res.setHeader("content-security-policy", csp);
}
