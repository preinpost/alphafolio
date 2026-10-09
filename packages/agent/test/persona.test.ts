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

	it("분석 답변은 자세히 — 시장 전체 흐름 절차가 있다", () => {
		const prompt = buildSystemPrompt({ ledgerEnabled: true, member: "x" });
		assert.ok(prompt.includes("사용자는 정보를 최대한 많이 얻고 싶어 한다"));
		assert.ok(prompt.includes("### 시장 전체 흐름"));
		assert.ok(prompt.includes("getMarketIndicatorInvestorTrading (KOSPI·KOSDAQ 각각"));
	});

	it("추천은 거래 순위가 아니라 여러 데이터 소스에서 후보를 고른다", () => {
		const prompt = buildSystemPrompt({ ledgerEnabled: true, member: "x" });
		const section = prompt.slice(prompt.indexOf("### 종목 추천·스크리닝"), prompt.indexOf("### 등락 이유"));
		assert.ok(section.includes("후보를 이 순위에서만 뽑지 않는다"));
		for (const source of ["FHPUP02140000", "FHPTJ04400000", "FHPST01870000", "HHDFS76370000", "mcp-tv-run-screener", "XLK"]) {
			assert.ok(section.includes(source), source);
		}
		assert.ok(!prompt.includes("섹터 순위는 제공되지 않는다"));
	});

	it("있는 데이터를 '제공되지 않는다' 고 막지 않는다 — 목표주가·테마·해외 재무 경로를 안내한다", () => {
		const prompt = buildSystemPrompt({ ledgerEnabled: true, member: "x" });
		for (const blocker of ["목표주가·추정 실적(예상 매출·EPS)은 제공되지 않는다", "테마 분류 자체는 제공되지 않는다", "구성 종목 API 는 없다"]) {
			assert.ok(!prompt.includes(blocker), blocker);
		}
		assert.ok(prompt.includes("FHKST663300C0"));
		assert.ok(prompt.includes("테마주"));
	});

	it("저점·역추세 질문은 툴이 계산한 분할 참고로 답하고, 숫자를 지어내지 않는다", () => {
		const prompt = buildSystemPrompt({ ledgerEnabled: true, member: "x" });
		const section = prompt.slice(prompt.indexOf("### 저점·역추세 질문"), prompt.indexOf("### 등락 이유"));
		assert.ok(section.length > 0, "저점 섹션이 등락 이유 앞에 있어야 한다");
		assert.ok(section.includes("역추세 분할 참고 (판정 아님)"));
		assert.ok(section.includes("손절가를 가장 먼저"));
		assert.ok(section.includes("지어내지 않는다"));
		assert.ok(section.includes("물타기"));
	});

	it("거래량·ATR·MFI 를 함께 보고, 손익비는 목표 거리와 함께 읽는다", () => {
		const prompt = buildSystemPrompt({ ledgerEnabled: true, member: "x" });
		assert.ok(prompt.includes("거래량·ATR·MFI 를 함께"));
		assert.ok(prompt.includes("거래량 부족으로 해석하지 않는다"));
		assert.ok(prompt.includes("손익비는 목표까지의 거리와 함께"));
	});

	it("라이선스(MIT) 고지가 함께 있다", () => {
		const license = readFileSync(new URL("../vendor/fluent-korean/LICENSE", import.meta.url), "utf8");
		assert.match(license, /MIT License/);
		assert.match(license, /snflkd/);
	});
});
