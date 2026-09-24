/**
 * 메시지 직렬화 — 자동 재시도로 이어진 실패는 기록에서 숨긴다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { serializeMessages } from "../src/serialize.ts";

const user = (text: string) => ({ role: "user", content: text });
const fail = (msg = "Request timed out.") => ({ role: "assistant", content: [], stopReason: "error", errorMessage: msg });
const ok = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });

describe("재시도된 실패", () => {
	it("재시도가 성공했으면 앞의 빈 실패는 숨긴다", () => {
		const out = serializeMessages([user("안녕"), fail(), fail(), ok("안녕하세요")]);
		assert.deepEqual(out.map((m) => m.role), ["user", "assistant"]);
		assert.equal(out[1]!.errorMessage, undefined);
	});

	it("마지막까지 실패면 오류를 보여준다 (재시도도 실패)", () => {
		const out = serializeMessages([user("안녕"), fail(), fail("401 Unauthorized")]);
		assert.equal(out.length, 2);
		assert.equal(out[1]!.errorMessage, "401 Unauthorized");
	});

	it("다음 질문 전의 실패는 재시도가 아니다 — 그대로 보여준다", () => {
		const out = serializeMessages([user("1"), fail(), user("2"), ok("답")]);
		assert.deepEqual(out.map((m) => m.errorMessage ?? m.role), ["user", "Request timed out.", "user", "assistant"]);
	});

	it("본문이 있는 실패(도중에 끊긴 답)는 숨기지 않는다", () => {
		const cut = { role: "assistant", content: [{ type: "text", text: "쓰다가" }], stopReason: "error", errorMessage: "끊김" };
		const out = serializeMessages([user("1"), cut, ok("다시")]);
		assert.equal(out.length, 3);
	});
});
