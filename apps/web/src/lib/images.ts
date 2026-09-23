/**
 * 첨부 이미지 준비 — 보내기 전에 줄인다.
 *
 * 폰 사진은 한 장에 3~10MB 다. 그대로 보내면 느리고, 세션 파일과 매 응답의 메시지 스냅샷이 커진다.
 * 긴 변 1600px·JPEG 로 줄이면 영수증 글자는 충분히 읽히고 보통 수백 KB 가 된다.
 * EXIF 회전은 createImageBitmap 이 반영한다 (세로 사진이 눕지 않게). 위치 정보 등 메타데이터는 버려진다.
 */
import type { ImageAttachment } from "@alphafolio/protocol";

export const MAX_ATTACH = 4;
const MAX_EDGE = 1600;
const QUALITY = 0.85;

export interface PreparedImage extends ImageAttachment {
	/** 미리보기·낙관적 표시용 */
	dataUrl: string;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
	if (!file.type.startsWith("image/")) throw new Error(`${file.name} 은(는) 이미지가 아닙니다`);
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
	} catch {
		// HEIC 등 브라우저가 못 여는 형식
		throw new Error(`${file.name} 을(를) 열 수 없습니다 — JPEG·PNG 로 보내 주세요`);
	}
	const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
	const w = Math.max(1, Math.round(bitmap.width * scale));
	const h = Math.max(1, Math.round(bitmap.height * scale));
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("이미지를 처리할 수 없습니다");
	// 투명 PNG 가 JPEG 로 바뀌며 검게 되지 않게
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, w, h);
	ctx.drawImage(bitmap, 0, 0, w, h);
	bitmap.close();
	const dataUrl = canvas.toDataURL("image/jpeg", QUALITY);
	return { mimeType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1), dataUrl };
}
