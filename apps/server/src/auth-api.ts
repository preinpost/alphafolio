/**
 * 공개 인증 경로 — 로그인(/api/auth/login)과 초대 코드 가입(/api/auth/signup) (PLAN §25).
 * 둘 다 Bearer 없이 오므로 본문을 작게(4KB) 받고 시도 횟수를 센다.
 */
import { Type } from "typebox";
import type { AccountStore } from "./accounts.ts";
import { AccountError } from "./accounts.ts";
import { AUTH_BODY_LIMIT, json, readBody } from "./http.ts";
import { clientIp, type LoginRateLimiter } from "./ratelimit.ts";
import { RESPONDED, type Route } from "./routes.ts";

const LoginBody = Type.Object({ user: Type.String(), password: Type.String() });
const SignupBody = Type.Object({ code: Type.String(), user: Type.String(), password: Type.String() });

export interface AuthApiDeps {
	accounts: AccountStore;
	issueToken: (name: string) => string;
	loginLimiter: LoginRateLimiter;
	/** 초대 코드 추측 방지 — 로그인과 따로 센다 (가입 실패가 로그인을 막지 않게) */
	signupLimiter: LoginRateLimiter;
	trustProxy: boolean;
}

export function authRoutes(d: AuthApiDeps): Route[] {
	return [
		{
			method: "POST",
			path: "/api/auth/login",
			handle: async ({ req, res }) => {
				const body = await readBody(req, LoginBody, { limit: AUTH_BODY_LIMIT });
				const user = body.user;

				// IP와 계정 두 축으로 센다 — 한 곳에서 여러 계정을 훑는 경우와
				// 여러 곳에서 한 계정을 노리는 경우를 모두 막는다.
				const ip = clientIp(req.headers, req.socket.remoteAddress, d.trustProxy);
				const keys = [`ip:${ip}`, `user:${user}`];

				const verdict = d.loginLimiter.check(keys);
				if (!verdict.allowed) {
					res.setHeader("retry-after", String(verdict.retryAfterSec));
					json(res, 429, {
						error: `로그인 시도가 너무 많습니다. ${verdict.retryAfterSec}초 뒤에 다시 시도하세요.`,
						retryAfterSec: verdict.retryAfterSec,
					});
					return RESPONDED;
				}

				const authedName = d.accounts.authenticate(user, body.password);
				if (!authedName) {
					d.loginLimiter.recordFailure(keys);
					json(res, 401, { error: "아이디 또는 비밀번호가 올바르지 않습니다" });
					return RESPONDED;
				}

				d.loginLimiter.recordSuccess(keys);
				return { token: d.issueToken(authedName), user: authedName };
			},
		},
		// 초대 코드로 가입 → 바로 로그인 (PLAN §25)
		{
			method: "POST",
			path: "/api/auth/signup",
			handle: async ({ req, res }) => {
				if (!d.accounts.ready) {
					json(res, 503, { error: "지금은 가입할 수 없습니다 (서버 DB 미설정)" });
					return RESPONDED;
				}
				const ip = clientIp(req.headers, req.socket.remoteAddress, d.trustProxy);
				const keys = [`ip:${ip}`];
				const verdict = d.signupLimiter.check(keys);
				if (!verdict.allowed) {
					res.setHeader("retry-after", String(verdict.retryAfterSec));
					json(res, 429, { error: `시도가 너무 많습니다. ${verdict.retryAfterSec}초 뒤에 다시 시도하세요.` });
					return RESPONDED;
				}
				const body = await readBody(req, SignupBody, { limit: AUTH_BODY_LIMIT });
				try {
					const name = await d.accounts.signup({ code: body.code, name: body.user, password: body.password });
					d.signupLimiter.recordSuccess(keys);
					return { token: d.issueToken(name), user: name };
				} catch (err) {
					// 코드가 틀린 경우만 센다 — ID 중복·비밀번호 길이 같은 입력 실수로 잠기지 않게
					if (err instanceof AccountError && err.status === 403) d.signupLimiter.recordFailure(keys);
					throw err;
				}
			},
		},
	];
}
