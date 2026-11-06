/**
 * 라우트 표 — 경로·메서드 → 처리기. 위에서부터 처음 맞는 것 하나만 처리한다.
 *
 * 처리기의 반환값:
 *   - 값              → 200 JSON
 *   - `RESPONDED`     → 처리기가 직접 응답했다 (429 + retry-after 같은 경우)
 *   - `undefined`     → 접두사는 맞았지만 하위 경로가 없다 → 404
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, json } from "./http.ts";

export const RESPONDED: unique symbol = Symbol("responded");

export interface RouteCtx {
	req: IncomingMessage;
	res: ServerResponse;
	url: URL;
	path: string;
}

/** 인증된 요청 — user 는 토큰과 계정 상태(토큰 버전)를 모두 통과한 사용자 */
export interface AuthedCtx extends RouteCtx {
	user: string;
}

export interface Route<C extends RouteCtx = RouteCtx> {
	/** 없으면 모든 메서드 */
	method?: string;
	/** 문자열 = 정확히 같은 경로, 함수 = 직접 판단 */
	path: string | ((path: string) => boolean);
	handle: (ctx: C) => Promise<unknown> | unknown;
}

/** `/api/x` 또는 `/api/x/…` */
export const under =
	(prefix: string) =>
	(path: string): boolean =>
		path === prefix || path.startsWith(`${prefix}/`);

/** `prefix…` 로 시작 */
export const startsWith =
	(prefix: string) =>
	(path: string): boolean =>
		path.startsWith(prefix);

export function findRoute<C extends RouteCtx>(routes: readonly Route<C>[], method: string | undefined, path: string): Route<C> | undefined {
	return routes.find((r) => (r.method === undefined || r.method === method) && (typeof r.path === "string" ? r.path === path : r.path(path)));
}

/** 처리했으면 true. 맞는 라우트가 없으면 false (다음 단계로) */
export async function dispatch<C extends RouteCtx>(routes: readonly Route<C>[], ctx: C): Promise<boolean> {
	const route = findRoute(routes, ctx.req.method, ctx.path);
	if (!route) return false;
	const result = await route.handle(ctx);
	if (result === RESPONDED) return true;
	if (result === undefined) throw new HttpError(404, `없는 경로: ${ctx.path}`);
	json(ctx.res, 200, result);
	return true;
}
