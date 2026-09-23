/**
 * 설정 — 없앤 환경변수가 남아 있으면 기동을 거부한다.
 * 조용히 무시하면 관리자가 임시 비밀번호로 떠서 "왜 로그인이 안 되지" 가 된다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkRemovedVars } from "../src/config.ts";

describe("없앤 환경변수", () => {
	it("AF_USERS·AF_AUTH_USER·AF_AUTH_PASSWORD 가 있으면 무엇으로 바꿀지 알려주고 멈춘다", () => {
		for (const k of ["AF_USERS", "AF_AUTH_USER", "AF_AUTH_PASSWORD"]) {
			assert.throws(() => checkRemovedVars({ [k]: "x" }), (e: Error) => e.message.includes(k) && e.message.includes("AF_ADMIN_"), k);
		}
	});

	it("빈 값이어도 남아 있으면 멈춘다 (compose 에 줄만 남은 경우)", () => {
		assert.throws(() => checkRemovedVars({ AF_AUTH_PASSWORD: "" }));
	});

	it("새 변수만 있으면 통과", () => {
		assert.doesNotThrow(() => checkRemovedVars({ AF_ADMIN_USER: "alpha", AF_ADMIN_PASSWORD: "x", AF_AUTH_SECRET: "s" }));
	});
});
