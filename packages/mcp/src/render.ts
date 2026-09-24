/**
 * MCP 결과 → 모델에게 줄 텍스트.
 * 이미지·오디오 원본은 싣지 않는다 (토큰 폭발 — 금융 조회에 필요한 건 텍스트·JSON).
 */
import type { McpCallResult, McpTool } from "./client.ts";

export const MAX_RESULT_CHARS = 16_000;

export function renderCallResult(r: McpCallResult, max = MAX_RESULT_CHARS): { text: string; truncated: boolean } {
	const parts: string[] = [];
	for (const c of r.content ?? []) {
		switch (c.type) {
			case "text":
				if (typeof c.text === "string") parts.push(c.text);
				break;
			case "image":
			case "audio":
				parts.push(`[${c.type === "image" ? "이미지" : "오디오"}${typeof c.mimeType === "string" ? ` ${c.mimeType}` : ""} — 생략]`);
				break;
			case "resource": {
				const res = (c as { resource?: { uri?: string; text?: string } }).resource;
				parts.push(typeof res?.text === "string" ? res.text : `[리소스 ${res?.uri ?? ""}]`);
				break;
			}
			case "resource_link": {
				const l = c as { uri?: string; name?: string };
				parts.push(`[링크 ${l.name ?? ""} ${l.uri ?? ""}]`.replace(/\s+/g, " "));
				break;
			}
			default:
				parts.push(`[${String(c.type)} — 생략]`);
		}
	}
	// 텍스트가 없고 구조화 결과만 있는 서버도 있다
	if (parts.length === 0 && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
	const text = parts.join("\n\n").trim() || "(빈 결과)";
	if (text.length <= max) return { text, truncated: false };
	return {
		text: `${text.slice(0, max)}\n\n…(잘림 — 전체 ${text.length.toLocaleString("en-US")}자 중 ${max.toLocaleString("en-US")}자. 인자(limit·기간·columns)를 좁혀 다시 요청)`,
		truncated: true,
	};
}

/** 목록용 한 줄 설명 — 첫 문장, 120자 */
export function oneLine(tool: McpTool): string {
	const d = (tool.description ?? tool.title ?? "").replace(/\s+/g, " ").trim();
	const first = /^(.+?[.!?。])(\s|$)/.exec(d)?.[1] ?? d;
	return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

interface SchemaNode {
	type?: string | string[];
	description?: string;
	enum?: unknown[];
	items?: SchemaNode;
	properties?: Record<string, SchemaNode>;
	required?: string[];
	default?: unknown;
	anyOf?: SchemaNode[];
	oneOf?: SchemaNode[];
}

function typeOf(s: SchemaNode): string {
	if (s.type === "array") return `${s.items ? typeOf(s.items) : "any"}[]`;
	if (Array.isArray(s.type)) return s.type.join("|");
	if (s.type) return s.type;
	const alt = s.anyOf ?? s.oneOf;
	if (alt) return alt.map(typeOf).join("|");
	return "any";
}

/** 상세 — 파라미터 표. 중첩 객체는 JSON 스키마 일부를 그대로 */
export function describeTool(serverName: string, tool: McpTool): string {
	const schema = (tool.inputSchema ?? {}) as SchemaNode;
	const required = new Set(schema.required ?? []);
	const lines = [`[${serverName}] ${tool.name}`, (tool.description ?? "").trim()];
	const props = Object.entries(schema.properties ?? {});
	if (props.length === 0) {
		lines.push("", "파라미터 없음");
	} else {
		lines.push("", "파라미터:");
		for (const [name, p] of props) {
			const bits = [typeOf(p), required.has(name) ? "필수" : "선택"];
			let line = `- ${name} (${bits.join(", ")})`;
			if (p.description) line += `: ${p.description.replace(/\s+/g, " ").trim()}`;
			if (p.enum) line += ` [선택지: ${p.enum.map(String).join(" | ")}]`;
			if (p.default !== undefined) line += ` [기본 ${JSON.stringify(p.default)}]`;
			const nested = p.type === "object" ? p : p.items?.type === "object" ? p.items : null;
			if (nested?.properties) line += `\n  구조: ${JSON.stringify(nested.properties).slice(0, 600)}`;
			lines.push(line);
		}
	}
	return lines.join("\n");
}
