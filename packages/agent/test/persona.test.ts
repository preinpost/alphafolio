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

	it("읽기 쉬운 구성 — 결론 먼저, 같은 숫자는 한 번, 한 칸에 값 하나, 소제목은 명사형", () => {
		const prompt = buildSystemPrompt({ ledgerEnabled: true, member: "x" });
		assert.ok(prompt.includes("결론(무엇이 문제이고 사용자가 무엇을 정해야 하는지)을 맨 앞에"));
		assert.ok(prompt.includes("같은 사실·숫자는 한 번만 쓴다"));
		assert.ok(prompt.includes("표 한 칸에는 값 하나만"));
		assert.ok(prompt.includes("소제목·표 머리글·표 칸은 명사형"));
		assert.ok(!prompt.includes("질문과 관련된 행·열은 줄이지 않는다"), "열까지 다 넣으라는 옛 문구");
		// 문장 지침 머리말에도 있어야 원문 '문장 단위 2번' 예외와 이어진다
		const head = prompt.slice(prompt.indexOf("# 답변 문장 지침"));
		assert.ok(head.includes("소제목·표 머리글·표 칸은 명사형으로 끝낸다"));
	});

	it("내부 용어(툴·20봉)를 쓰지 않고 약어는 처음 한 번 풀어 쓴다", () => {
		const prompt = buildSystemPrompt({ ledgerEnabled: true, member: "x" });
		assert.ok(prompt.includes('"툴", "툴 판정", "툴 계산값", "툴 시나리오"'));
		assert.ok(prompt.includes('"20봉 평균" → "20일 평균"'));
		assert.ok(prompt.includes("처음 나올 때 한 번만 괄호로 짧게 풀어 쓰고"));
	});

	it("보유 점검은 위험 큰 종목 먼저, 종목마다 한 번만", () => {
		const prompt = buildSystemPrompt({ ledgerEnabled: true, member: "x" });
		const section = prompt.slice(prompt.indexOf("### 보유 종목 점검"), prompt.indexOf("### 저점·역추세 질문"));
		assert.ok(section.length > 0, "보유 점검 섹션이 저점 섹션 앞에 있어야 한다");
		for (const part of ["portfolio_holdings", "portfolio_signals", "한눈에 보기", "보유 현황 표", "먼저 볼 종목", "나머지 종목", "뉴스 배경"]) {
			assert.ok(section.includes(part), part);
		}
		assert.ok(section.includes("다른 절에서 다시 다루지 않는다"));
		assert.ok(section.includes("별도 표를 또 만들지 않는다"));
	});
});
