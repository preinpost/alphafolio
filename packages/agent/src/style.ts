/**
 * 답변 문장 지침 — fluent-korean (MIT, vendor/fluent-korean).
 *
 * 모델이 조사·어미를 빼고 명사로 끊거나 엠대시로 문장을 잇는 말투를 줄인다.
 * 원문을 그대로 쓴다 (요약하면 예시가 빠져 지침이 약해진다 — vendor/fluent-korean/README.md).
 */
import { readFileSync } from "node:fs";

const SOURCE = new URL("../vendor/fluent-korean/fluent-korean-not-coding.md", import.meta.url);

/** front matter(--- … ---)를 떼고 본문만 */
export function stripFrontMatter(md: string): string {
	return md.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

/** 모듈 로드 시 한 번 읽는다 — 파일이 없으면 기동 단계에서 바로 드러나게 예외 */
export const KOREAN_STYLE_GUIDE = stripFrontMatter(readFileSync(SOURCE, "utf8"));
