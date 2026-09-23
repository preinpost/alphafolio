/**
 * 채팅 이미지 첨부 검증.
 *
 * 앱은 보내기 전에 긴 변 1600px JPEG 로 줄이므로 보통 한 장에 수백 KB 다. 아래 한도는
 * 그걸 넉넉히 넘는 값이고, 목적은 **실수·악의로 큰 페이로드가 모델 호출·세션 파일로 가는 것을 막는 것**이다.
 *
 * mimeType 은 클라이언트 말을 믿지 않고 파일 앞부분(매직 바이트)으로 확인한다 —
 * 이미지라고 붙인 임의 바이트가 모델 프로바이더로 넘어가지 않게.
 */

export interface ImageAttachment {
	mimeType: string;
	/** base64 (data: 접두사 없음) */
	data: string;
}

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** WS 한 메시지 한도 — 이미지 최대치(base64 로 1.37배) + 텍스트 여유 */
export const MAX_WS_PAYLOAD = Math.ceil(MAX_IMAGES * MAX_IMAGE_BYTES * 1.37) + 256 * 1024;

const SIGNATURES: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
	{ mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
	{ mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
	{ mime: "image/gif", test: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
	{
		mime: "image/webp",
		test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
	},
];

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type ImageCheck = { ok: true; images: ImageAttachment[] } | { ok: false; error: string };

/** 첨부 목록 검증. 없거나 빈 배열이면 이미지 없음(ok). */
export function checkImages(raw: unknown): ImageCheck {
	if (raw === undefined || raw === null) return { ok: true, images: [] };
	if (!Array.isArray(raw)) return { ok: false, error: "이미지 형식이 올바르지 않습니다" };
	if (raw.length > MAX_IMAGES) return { ok: false, error: `이미지는 한 번에 ${MAX_IMAGES}장까지 보낼 수 있습니다` };

	const images: ImageAttachment[] = [];
	for (const [i, item] of raw.entries()) {
		const n = i + 1;
		const data = (item as { data?: unknown })?.data;
		if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
			return { ok: false, error: `${n}번째 이미지를 읽을 수 없습니다` };
		}
		// base64 길이로 먼저 거른다 — 큰 문자열을 디코딩하기 전에
		if ((data.length / 4) * 3 > MAX_IMAGE_BYTES + 2) {
			return { ok: false, error: `${n}번째 이미지가 너무 큽니다 (최대 ${MAX_IMAGE_BYTES / 1024 / 1024}MB)` };
		}
		const head = Buffer.from(data.slice(0, 24), "base64");
		const sig = SIGNATURES.find((s) => s.test(head));
		if (!sig) return { ok: false, error: `${n}번째 파일은 지원하는 이미지(JPEG·PNG·WebP·GIF)가 아닙니다` };
		// 실제 형식으로 기록한다 (클라이언트가 붙인 mimeType 은 쓰지 않는다)
		images.push({ mimeType: sig.mime, data });
	}
	return { ok: true, images };
}
