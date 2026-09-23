/**
 * CORS 테스트 — 허용 목록 밖의 오리진에 허용 헤더가 새면 안 된다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { corsFor, DEFAULT_CORS_ORIGINS, parseCorsOrigins } from "../src/cors.ts";

const APP = "capacitor://localhost";

describe("AF_CORS_ORIGINS 파싱", () => {
	it("비어 있으면 Capacitor iOS 기본 오리진", () => {
		assert.deepEqual(parseCorsOrigins(undefined), DEFAULT_CORS_ORIGINS);
		assert.deepEqual(parseCorsOrigins(" , "), DEFAULT_CORS_ORIGINS);
	});

	it("쉼표 구분 + 공백·끝 슬래시 정리 (오리진 비교는 정확 일치라 슬래시 하나로도 어긋난다)", () => {
		assert.deepEqual(parseCorsOrigins(" capacitor://localhost/ , http://localhost:5173"), [
			"capacitor://localhost",
			"http://localhost:5173",
		]);
	});
});

describe("corsFor", () => {
	it("허용 오리진의 본 요청 — 오리진을 그대로 되돌리고 프리플라이트 헤더는 없다", () => {
		const d = corsFor(APP, "GET", [APP]);
		assert.equal(d.preflight, false);
		assert.equal(d.headers["access-control-allow-origin"], APP);
		assert.equal(d.headers["access-control-allow-methods"], undefined);
	});

	it("허용 오리진의 프리플라이트 — authorization 헤더를 허용해야 Bearer 요청이 나간다", () => {
		const d = corsFor(APP, "OPTIONS", [APP]);
		assert.equal(d.preflight, true);
		assert.match(d.headers["access-control-allow-headers"] ?? "", /authorization/);
		assert.match(d.headers["access-control-allow-methods"] ?? "", /DELETE/);
	});

	it("허용 목록 밖 오리진에는 허용 헤더를 주지 않는다", () => {
		for (const method of ["GET", "OPTIONS"]) {
			const d = corsFor("https://evil.example", method, [APP]);
			assert.equal(d.headers["access-control-allow-origin"], undefined, method);
			assert.equal(d.headers["access-control-allow-headers"], undefined, method);
		}
	});

	it("와일드카드를 쓰지 않고, 쿠키를 안 쓰므로 credentials 도 보내지 않는다", () => {
		const d = corsFor(APP, "OPTIONS", [APP]);
		assert.notEqual(d.headers["access-control-allow-origin"], "*");
		assert.equal(d.headers["access-control-allow-credentials"], undefined);
	});

	it("부분 일치로 통과시키지 않는다 (capacitor://localhost.evil 등)", () => {
		assert.equal(corsFor("capacitor://localhost.evil", "GET", [APP]).headers["access-control-allow-origin"], undefined);
		assert.equal(corsFor("capacitor://localhos", "GET", [APP]).headers["access-control-allow-origin"], undefined);
	});

	it("같은 오리진 요청(Origin 없음)은 아무것도 붙이지 않는다 — Vary 만", () => {
		assert.deepEqual(corsFor(undefined, "GET", [APP]).headers, { vary: "Origin" });
	});
});
