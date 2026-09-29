/**
 * 정적 파일 캐시 정책 — sw.js 가 CDN 에 캐시되면 배포해도 옛 번들이 계속 뜬다 (2026-09-29 실측).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { staticCacheControl } from "../src/static-cache.ts";

describe("staticCacheControl", () => {
	it("서비스워커·진입 HTML 은 매번 원본에 확인한다", () => {
		for (const f of ["sw.js", "registerSW.js", "index.html", "manifest.webmanifest"]) {
			assert.equal(staticCacheControl(f), "no-cache", f);
		}
	});

	it("해시가 붙은 assets 는 오래 캐시한다", () => {
		assert.equal(staticCacheControl("assets/index-C8d1P1JF.js"), "public, max-age=31536000, immutable");
	});

	it("윈도우 구분자·앞 슬래시도 같은 규칙", () => {
		assert.equal(staticCacheControl("\\sw.js"), "no-cache");
		assert.equal(staticCacheControl("assets\\index-C8d1P1JF.css"), "public, max-age=31536000, immutable");
	});

	it("그 외는 헤더를 붙이지 않는다 — 하위 폴더의 같은 이름도 진입점이 아니다", () => {
		assert.equal(staticCacheControl("pwa-192x192.png"), undefined);
		assert.equal(staticCacheControl("workbox-9c191d2f.js"), undefined);
		assert.equal(staticCacheControl("nested/sw.js"), undefined);
	});
});
