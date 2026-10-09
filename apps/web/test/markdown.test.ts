/**
 * 채팅 답변 마크다운 — 한글 조사가 붙은 굵은 글씨 · 물결표.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { remarkPlugins } from "../src/lib/markdown.ts";

const html = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins }, md));

describe("채팅 마크다운", () => {
	it("닫는 ** 앞이 문장 부호이고 뒤에 조사가 붙어도 굵게 된다", () => {
		assert.match(html("반도체가 **총자산의 약 74%**입니다."), /<strong>총자산의 약 74%<\/strong>입니다/);
		assert.match(html("판정은 **매수(스윙)**이고 손절은 아래입니다."), /<strong>매수\(스윙\)<\/strong>이고/);
		assert.match(html("**원익IPS**가 가장 큽니다."), /<strong>원익IPS<\/strong>가/);
	});

	it("물결표는 여전히 취소선이 아니다", () => {
		const out = html("가격이 ~~2만원~~ 이었는데 서울~부산~ 고고~");
		assert.ok(!out.includes("<del>"), out);
		assert.ok(out.includes("~~2만원~~"));
	});

	it("표는 그대로 렌더된다 (remark-gfm)", () => {
		assert.match(html("| 종목 | 비중 |\n|---|---|\n| 원익IPS | 24.0% |"), /<table>/);
	});
});
