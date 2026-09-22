/**
 * 리서치 묶음 테스트 — 섹션 상태 구분이 핵심이다.
 * "못 가져온 것"을 "없는 것"으로 말하는 순간 사용자는 틀린 결론을 낸다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { position52w, sectionNote, settle, skipped } from "../src/research.ts";

describe("settle", () => {
	it("성공은 ok 로 감싼다", async () => {
		const s = await settle(async () => 42);
		assert.deepEqual(s, { status: "ok", data: 42 });
	});

	it("실패를 던지지 않고 failed 로 바꾼다 (한 섹션이 전체를 죽이지 않게)", async () => {
		const s = await settle(async () => {
			throw new Error("HTTP 500");
		});
		assert.deepEqual(s, { status: "failed", error: "HTTP 500" });
	});

	it("긴 오류 메시지는 잘라서 토큰을 아낀다", async () => {
		const s = await settle(async () => {
			throw new Error("x".repeat(500));
		});
		assert.equal(s.status, "failed");
		assert.ok(s.status === "failed" && s.error.length <= 121);
	});

	it("자격증명 미설정은 '실패'가 아니라 '해당 없음'이다", async () => {
		class MissingKey extends Error {}
		const classify = (err: unknown) => (err instanceof MissingKey ? "키 미설정" : null);

		const noKey = await settle(async () => {
			throw new MissingKey("no key");
		}, classify);
		assert.deepEqual(noKey, { status: "skipped", reason: "키 미설정" });

		// 분류기가 모르는 오류는 여전히 실패
		const real = await settle(async () => {
			throw new Error("HTTP 500");
		}, classify);
		assert.equal(real.status, "failed");
	});

	it("Error 가 아닌 값을 던져도 처리한다", async () => {
		const s = await settle(async () => {
			throw "문자열 오류";
		});
		assert.deepEqual(s, { status: "failed", error: "문자열 오류" });
	});
});

describe("섹션 안내 문구", () => {
	it("성공이면 안내가 없다", () => {
		assert.equal(sectionNote("재무", { status: "ok", data: {} }), null);
	});

	it("해당 없음과 실패를 다르게 말한다", () => {
		const skip = sectionNote("재무", skipped("해외 종목"));
		const fail = sectionNote("재무", { status: "failed", error: "timeout" });
		assert.match(skip ?? "", /해당 없음/);
		assert.doesNotMatch(skip ?? "", /실패/);
		assert.match(fail ?? "", /조회 실패/);
		assert.match(fail ?? "", /가져오지 못한 것/, "실패를 '없음'으로 읽히지 않게 명시해야 한다");
	});
});

describe("52주 위치", () => {
	it("최저 0, 최고 100, 중간 50", () => {
		assert.equal(position52w(100, 100, 200), 0);
		assert.equal(position52w(200, 100, 200), 100);
		assert.equal(position52w(150, 100, 200), 50);
	});

	it("신고가면 100 을 넘긴다 (자르지 않는다)", () => {
		assert.equal(position52w(210, 100, 200), 110);
	});

	it("범위를 모르면 null", () => {
		assert.equal(position52w(150, null, 200), null);
		assert.equal(position52w(150, 200, 200), null);
	});
});
