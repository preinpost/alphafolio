/**
 * CORS — iOS 앱(Capacitor) 전용.
 *
 * 웹 UI 는 서버와 같은 오리진이라 CORS 가 필요 없다. Capacitor iOS 는 번들을
 * `capacitor://localhost` 에서 띄우므로 서버로 가는 모든 REST 호출이 크로스 오리진이 된다.
 *
 * **허용 목록에 있는 오리진만** 되돌려준다 (`*` 를 쓰지 않는다). 인증이 쿠키가 아니라 Bearer
 * 토큰이라 `*` 여도 남의 사이트가 토큰을 훔칠 수는 없지만, 열어둘 이유도 없다.
 * 쿠키를 쓰지 않으므로 `Access-Control-Allow-Credentials` 도 보내지 않는다.
 *
 * WebSocket 은 CORS 대상이 아니다 — 인증은 연결 후 첫 메시지(auth 토큰)로 한다 (ws.ts).
 */

/** Capacitor iOS 기본 스킴. 앱 설정(`server.iosScheme`)을 바꾸면 AF_CORS_ORIGINS 도 바꿔야 한다. */
export const DEFAULT_CORS_ORIGINS = ["capacitor://localhost"];

const ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE";
const ALLOW_HEADERS = "authorization, content-type";
/** 프리플라이트 캐시(초) — 매 요청마다 OPTIONS 왕복을 하지 않게 */
const MAX_AGE_SEC = "600";

/** `AF_CORS_ORIGINS` 파싱 — 쉼표 구분, 끝 슬래시 제거. 빈 값이면 기본값. */
export function parseCorsOrigins(raw: string | undefined): string[] {
	const list = (raw ?? "")
		.split(",")
		.map((s) => s.trim().replace(/\/+$/, ""))
		.filter(Boolean);
	return list.length > 0 ? list : DEFAULT_CORS_ORIGINS;
}

export interface CorsDecision {
	/** 응답에 붙일 헤더 (허용되지 않은 오리진이면 비어 있다) */
	headers: Record<string, string>;
	/** 프리플라이트(OPTIONS)라서 여기서 응답을 끝내야 하는가 */
	preflight: boolean;
}

/**
 * 요청 하나에 대한 CORS 판단. 순수 함수 — 서버는 결과대로 헤더만 붙인다.
 *
 * 허용되지 않은 오리진의 프리플라이트도 204 로 끝낸다. 허용 헤더가 없으니 브라우저가
 * 본 요청을 보내지 않는다 — 여기서 403 을 줄 필요가 없다.
 */
export function corsFor(origin: string | undefined, method: string | undefined, allowed: string[]): CorsDecision {
	const preflight = method === "OPTIONS";
	// Vary 는 항상 — 캐시가 한 오리진의 응답을 다른 오리진에 재사용하지 않게
	const headers: Record<string, string> = { vary: "Origin" };
	if (origin && allowed.includes(origin)) {
		headers["access-control-allow-origin"] = origin;
		if (preflight) {
			headers["access-control-allow-methods"] = ALLOW_METHODS;
			headers["access-control-allow-headers"] = ALLOW_HEADERS;
			headers["access-control-max-age"] = MAX_AGE_SEC;
		}
	}
	return { headers, preflight };
}
