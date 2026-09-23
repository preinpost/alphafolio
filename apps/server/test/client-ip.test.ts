/**
 * 클라이언트 IP — 로그인·가입 시도 제한의 키다. 위조되면 제한을 피한다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientIp } from "../src/ratelimit.ts";

describe("clientIp", () => {
	it("프록시를 믿지 않으면 헤더를 무시하고 소켓 주소", () => {
		assert.equal(clientIp({ "x-forwarded-for": "1.1.1.1", "cf-connecting-ip": "2.2.2.2" }, "10.0.0.1", false), "10.0.0.1");
	});

	it("Cloudflare 뒤: CF-Connecting-IP 를 쓴다 (클라이언트가 XFF 를 꾸며도)", () => {
		assert.equal(clientIp({ "x-forwarded-for": "6.6.6.6, 203.0.113.9", "cf-connecting-ip": "203.0.113.9" }, "172.17.0.1", true), "203.0.113.9");
	});

	it("XFF 만 있으면 맨 앞(클라이언트가 보낸 값)이 아니라 프록시가 붙인 맨 끝", () => {
		assert.equal(clientIp({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 203.0.113.9" }, "172.17.0.1", true), "203.0.113.9");
		assert.equal(clientIp({ "x-forwarded-for": ["6.6.6.6", "203.0.113.9"] }, "172.17.0.1", true), "203.0.113.9");
	});

	it("요청마다 가짜 IP 를 바꿔 넣어도 같은 사람으로 센다", () => {
		const ips = ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((fake) =>
			clientIp({ "x-forwarded-for": `${fake}, 203.0.113.9`, "cf-connecting-ip": "203.0.113.9" }, "172.17.0.1", true),
		);
		assert.deepEqual(new Set(ips), new Set(["203.0.113.9"]));
	});

	it("헤더가 없으면 소켓 주소", () => {
		assert.equal(clientIp({}, "172.17.0.1", true), "172.17.0.1");
		assert.equal(clientIp({ "x-forwarded-for": " , " }, undefined, true), "unknown");
	});
});
