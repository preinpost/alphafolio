/**
 * 시스템 프롬프트 — 답변 문장 지침(fluent-korean)이 원문 그대로 들어가는지.
 * 요약하거나 빠지면 말투가 바로 돌아간다 (엠대시·명사형 종결·해요/습니다 혼용).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildSystemPrompt } from "../src/persona.ts";
import { KOREAN_STYLE_GUIDE, stripFrontMatter } from "../src/style.ts";

const raw = readFileSync(new URL("../vendor/fluent-korean/fluent-korean-not-coding.md", import.meta.url), "utf8");

describe("답변 문장 지침", () => {
	it("원문 본문이 통째로 들어간다 (가계부 사용 여부와 무관)", () => {
		for (const ledgerEnabled of [true, false]) {
			const prompt = buildSystemPrompt({ ledgerEnabled, member: "x" });
			assert.ok(prompt.includes(stripFrontMatter(raw)), `ledgerEnabled=${ledgerEnabled}`);
		}
	});

	it("조항별 예시까지 남아 있다 — 요약본이 아니다", () => {
		assert.ok(KOREAN_STYLE_GUIDE.includes("[사본의 문구는 작업의 상황을 → 사본에 기재된 문구는 작업이 진행되는 상황을]"));
		assert.ok(KOREAN_STYLE_GUIDE.includes("엠대시(—)는"));
	});

	it("front matter 는 뗀다 (name·description 이 모델에게 보이지 않게)", () => {
		assert.ok(!KOREAN_STYLE_GUIDE.startsWith("---"));
		assert.ok(!KOREAN_STYLE_GUIDE.includes("name: fluent-korean"));
		assert.equal(stripFrontMatter("---\na: 1\n---\n본문\n"), "본문");
		assert.equal(stripFrontMatter("본문만"), "본문만");
	});

	it("업무 규칙 뒤, 맨 끝에 붙는다", () => {
		const prompt = buildSystemPrompt({ ledgerEnabled: true, member: "x" });
		assert.ok(prompt.indexOf("# 답변 문장 지침") > prompt.indexOf("## 가계부"));
		assert.ok(prompt.trimEnd().endsWith(stripFrontMatter(raw)));
	});

	it("라이선스(MIT) 고지가 함께 있다", () => {
		const license = readFileSync(new URL("../vendor/fluent-korean/LICENSE", import.meta.url), "utf8");
		assert.match(license, /MIT License/);
		assert.match(license, /snflkd/);
	});
});
