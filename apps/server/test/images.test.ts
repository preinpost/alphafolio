/**
 * 이미지 첨부 검증 테스트 — 모델 프로바이더와 세션 파일로 가는 입력이다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkImages, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_WS_PAYLOAD } from "../src/images.ts";

const b64 = (bytes: number[], pad = 0): string => Buffer.concat([Buffer.from(bytes), Buffer.alloc(pad)]).toString("base64");
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0], 60);
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 60);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(60)]).toString("base64");
const GIF = b64([...Buffer.from("GIF89a")], 60);

describe("이미지 첨부 검증", () => {
	it("첨부가 없으면 통과 (텍스트만)", () => {
		assert.deepEqual(checkImages(undefined), { ok: true, images: [] });
		assert.deepEqual(checkImages([]), { ok: true, images: [] });
	});

	it("JPEG·PNG·WebP·GIF 를 받는다", () => {
		const r = checkImages([JPEG, PNG, WEBP, GIF].map((data) => ({ mimeType: "image/jpeg", data })));
		assert.ok(r.ok);
		assert.deepEqual(
			r.images.map((i) => i.mimeType),
			["image/jpeg", "image/png", "image/webp", "image/gif"],
		);
	});

	it("mimeType 은 클라이언트 값이 아니라 파일 앞부분으로 정한다", () => {
		const r = checkImages([{ mimeType: "image/gif", data: PNG }]);
		assert.ok(r.ok);
		assert.equal(r.images[0]?.mimeType, "image/png");
	});

	it("이미지가 아닌 바이트는 거절한다 (이름만 이미지인 파일)", () => {
		const pdf = Buffer.from("%PDF-1.7 lorem ipsum dolor sit amet").toString("base64");
		const r = checkImages([{ mimeType: "image/jpeg", data: pdf }]);
		assert.equal(r.ok, false);
		assert.match(!r.ok ? r.error : "", /지원하는 이미지/);
	});

	it(`${MAX_IMAGES}장을 넘기면 거절한다`, () => {
		const r = checkImages(Array.from({ length: MAX_IMAGES + 1 }, () => ({ mimeType: "image/jpeg", data: JPEG })));
		assert.equal(r.ok, false);
	});

	it("너무 큰 이미지는 디코딩 전에 거절한다", () => {
		const big = b64([0xff, 0xd8, 0xff], MAX_IMAGE_BYTES + 100);
		const r = checkImages([{ mimeType: "image/jpeg", data: big }]);
		assert.equal(r.ok, false);
		assert.match(!r.ok ? r.error : "", /너무 큽니다/);
	});

	it("한도 이하 최대 크기는 통과한다 (경계)", () => {
		const edge = b64([0xff, 0xd8, 0xff], MAX_IMAGE_BYTES - 3 - 10);
		assert.equal(checkImages([{ mimeType: "image/jpeg", data: edge }]).ok, true);
	});

	it("base64 가 아니거나 data: 접두사가 붙은 값은 거절한다", () => {
		for (const data of ["", "not base64!!", `data:image/jpeg;base64,${JPEG}`, JPEG.slice(0, -1)]) {
			assert.equal(checkImages([{ mimeType: "image/jpeg", data }]).ok, false, data.slice(0, 30));
		}
		assert.equal(checkImages("x").ok, false);
		assert.equal(checkImages([null]).ok, false);
	});

	it("WS 한도는 최대 첨부를 담을 수 있다", () => {
		assert.ok(MAX_WS_PAYLOAD > Math.ceil((MAX_IMAGES * MAX_IMAGE_BYTES * 4) / 3));
	});
});
