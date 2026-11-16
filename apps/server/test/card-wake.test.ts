/**
 * 확인 카드 결과 → 에이전트 알림 규칙 (index.ts 리스너가 쓰는 announceCardOutcome).
 *
 * done·failed 는 쉬고 있으면 새 턴(wake), dismissed 는 기록만, 응답 중이면 끼워 넣기, 대화가 없으면 경고만.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { announceCardOutcome, wakeForOutcome, type OutcomeTarget } from "../src/card-wake.ts";

function target(isStreaming: boolean) {
	const notes: Array<{ customType: string; text: string; details: unknown; opts: unknown }> = [];
	const conv: OutcomeTarget = {
		isStreaming,
		async note(customType, text, details, opts) {
			notes.push({ customType, text, details, opts });
		},
	};
	return { conv, notes };
}

function logger() {
	const lines: string[] = [];
	const warns: string[] = [];
	return { lines, warns, log: { info: (m: string) => lines.push(m), warn: (m: string) => warns.push(m) } };
}

const origin = { sessionId: "sess-12345678-abcd", noteText: "[확인 카드 결과] 이체\n→ 실행됐습니다" };

describe("wakeForOutcome", () => {
	it("done·failed 는 깨운다, dismissed 는 깨우지 않는다", () => {
		assert.equal(wakeForOutcome("done"), true);
		assert.equal(wakeForOutcome("failed"), true);
		assert.equal(wakeForOutcome("dismissed"), false);
	});
});

describe("announceCardOutcome", () => {
	it("쉬는 중 done → wake true 로 note 를 부른다 (details 에 state·nonce)", async () => {
		const { conv, notes } = target(false);
		const { log, warns } = logger();
		const branch = await announceCardOutcome(conv, origin, { state: "done", nonce: "n-full" }, "who", log);
		assert.equal(branch, "wake");
		assert.deepEqual(notes, [{ customType: "card-outcome", text: origin.noteText, details: { state: "done", nonce: "n-full" }, opts: { wake: true } }]);
		assert.deepEqual(warns, []);
	});

	it("쉬는 중 failed → wake true", async () => {
		const { conv, notes } = target(false);
		const branch = await announceCardOutcome(conv, origin, { state: "failed", nonce: "n" }, "who", logger().log);
		assert.equal(branch, "wake");
		assert.equal((notes[0].opts as { wake: boolean }).wake, true);
	});

	it("dismissed → wake false (기록만)", async () => {
		const { conv, notes } = target(false);
		const branch = await announceCardOutcome(conv, origin, { state: "dismissed", nonce: "n" }, "who", logger().log);
		assert.equal(branch, "record");
		assert.equal((notes[0].opts as { wake: boolean }).wake, false);
	});

	it("응답 중이면 state 와 무관하게 note 를 부르고 wake 는 그대로 넘긴다 (runtime 이 steer 로 처리)", async () => {
		const { conv, notes } = target(true);
		const branch = await announceCardOutcome(conv, origin, { state: "done", nonce: "n" }, "who", logger().log);
		assert.equal(branch, "steer");
		assert.equal(notes.length, 1);
		assert.equal((notes[0].opts as { wake: boolean }).wake, true);
	});

	it("대화가 없으면(undefined) note 를 부르지 않고 경고만 남긴다", async () => {
		const { lines, warns, log } = logger();
		const branch = await announceCardOutcome(undefined, origin, { state: "done", nonce: "n" }, "who", log);
		assert.equal(branch, "missing");
		assert.equal(warns.length, 1);
		assert.match(warns[0], /대화를 찾지 못함/);
		assert.deepEqual(lines, []);
	});

	it("nonce 가 없으면 details.nonce 는 undefined — runtime 이 중복으로 보지 않고 기록한다", async () => {
		const { conv, notes } = target(false);
		await announceCardOutcome(conv, origin, { state: "done" }, "who", logger().log);
		assert.deepEqual(notes[0].details, { state: "done", nonce: undefined });
	});
});
