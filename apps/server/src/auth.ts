/**
 * 인증 — HMAC 서명 Bearer 토큰 (PLAN.md §8.2).
 *
 * 쿠키를 쓰지 않는 이유: Capacitor(iOS) WebView는 origin이 capacitor://localhost 라
 * 크로스 오리진이 되고 WKWebView의 서드파티 쿠키 정책상 신뢰할 수 없다.
 * 웹과 모바일이 같은 경로를 쓰도록 양쪽 다 토큰으로 통일한다.
 *
 * 서버 상태를 두지 않는다 (서명 검증만) — 컨테이너 재시작에도 토큰이 살아남는다.
 * 단 AF_AUTH_SECRET 이 매 기동 생성되면 무효화되므로 배포에서는 env로 고정할 것.
 *
 * 토큰에 계정의 **토큰 버전(v)** 을 싣는다 (PLAN §25). 비밀번호 변경·모든 기기 로그아웃·비활성화 때
 * 계정 버전을 올리면 그 전에 발급된 토큰이 전부 무효가 된다 (accounts.ts 의 accepts).
 * v 가 없는 옛 토큰은 버전 0 으로 본다.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_DAYS = 30;

interface TokenPayload {
	u: string;
	exp: number;
	v?: number;
}

export interface VerifiedToken {
	user: string;
	version: number;
}

function sign(data: string, secret: string): string {
	return createHmac("sha256", secret).update(data).digest("base64url");
}

export function createToken(user: string, secret: string, version = 0, ttlDays = DEFAULT_TTL_DAYS): string {
	const payload: TokenPayload = { u: user, exp: Date.now() + ttlDays * 86_400_000, ...(version ? { v: version } : {}) };
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${body}.${sign(body, secret)}`;
}

/** 서명·만료만 본다. 계정이 아직 유효한지(버전·비활성화)는 AccountStore.accepts 로 따로 확인한다. */
export function verifyToken(token: string | undefined, secret: string): VerifiedToken | null {
	if (!token) return null;
	const dot = token.lastIndexOf(".");
	if (dot <= 0) return null;

	const body = token.slice(0, dot);
	const mac = token.slice(dot + 1);

	const expected = sign(body, secret);
	if (!safeEqual(mac, expected)) return null;

	try {
		const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
		if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
		if (typeof payload.u !== "string") return null;
		return { user: payload.u, version: typeof payload.v === "number" ? payload.v : 0 };
	} catch {
		return null;
	}
}

/** 길이가 달라도 예외 없이 false를 돌려주는 상수시간 비교. */
export function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) {
		// 길이 자체가 다르면 비교 대상이 아니지만, 타이밍을 맞추기 위해 더미 비교를 수행한다.
		timingSafeEqual(bufA, bufA);
		return false;
	}
	return timingSafeEqual(bufA, bufB);
}

/** Authorization: Bearer <token> 헤더에서 토큰을 뽑는다. */
export function bearerFrom(header: string | undefined): string | undefined {
	if (!header) return undefined;
	const [scheme, value] = header.split(" ");
	return scheme?.toLowerCase() === "bearer" ? value : undefined;
}
