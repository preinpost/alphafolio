/**
 * MCP 결과 → 모델에게 줄 텍스트.
 * 이미지·오디오 원본은 싣지 않는다 (토큰 폭발 — 금융 조회에 필요한 건 텍스트·JSON).
 */
import type { McpCallResult, McpTool } from "./client.ts";
import type { McpPreset, SummaryLine } from "./policy.ts";

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

/** 결과 본문이 JSON 이면 파싱 (structuredContent 우선) */
export function resultData(r: McpCallResult): unknown {
	if (r.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent;
	const text = (r.content ?? []).find((c) => c.type === "text") as { text?: string } | undefined;
	if (typeof text?.text !== "string") return undefined;
	try {
		return JSON.parse(text.text);
	} catch {
		return undefined;
	}
}

/** 요약에서 뺄 필드 — 표시·내부용 */
const NOISE = /logo|presentation|pro_symbol|sound|complexity|kinds|policy|cross_interval|frequency|^_/i;
/** 앞에 둘 필드 — 순서대로 (id → 이름 → 상태 → 종목), 나머지는 원래 순서 */
const FIRST = [/(^|_)(id|ids)$/, /^(name|title)$/, /^(status|success|message)$/, /^symbol/];
const rankOf = (key: string): number => {
	const i = FIRST.findIndex((re) => re.test(key));
	return i < 0 ? FIRST.length : i;
};

function scalar(v: unknown): string | null {
	if (typeof v === "string") return v.length > 200 ? `${v.slice(0, 199)}…` : v;
	if (typeof v === "number") return v.toLocaleString("en-US", { maximumFractionDigits: 8 });
	if (typeof v === "boolean") return v ? "예" : "아니오";
	if (Array.isArray(v) && v.length <= 10 && v.every((x) => typeof x === "string" || typeof x === "number")) return v.join(", ");
	return null;
}

/**
 * 쓰기 실행 결과 → 확인 카드에 보일 요약 줄 (최대 8개). 원본 JSON 을 그대로 늘어놓지 않는다.
 * 프리셋이 아는 모양이면 그것, 아니면 윗단 스칼라 필드 (`data` 한 겹은 벗긴다). JSON 이 아니면 빈 목록 (원문이 곧 요약).
 */
export function summarizeResult(r: McpCallResult, tool: string, preset?: McpPreset): SummaryLine[] {
	const data = resultData(r);
	if (data === undefined) return [];
	const special = preset?.summarize?.(tool, data);
	if (special) return special;
	let obj = data as Record<string, unknown>;
	if (obj && typeof obj === "object" && !Array.isArray(obj) && obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
		obj = { ...(obj.data as Record<string, unknown>), ...(obj.success !== undefined ? { success: obj.success } : {}) };
	}
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
	const lines = Object.entries(obj)
		.filter(([k]) => !NOISE.test(k))
		.map(([k, v]) => ({ label: preset?.argLabels?.[k] ?? k, value: scalar(v), rank: rankOf(k) }))
		.filter((x): x is { label: string; value: string; rank: number } => x.value !== null && x.value !== "")
		.sort((a, b) => a.rank - b.rank);
	return lines.slice(0, 8).map(({ label, value }) => ({ label, value }));
}

/** 원본 응답 — 사람이 펼쳐 볼 때만. JSON 이면 들여쓰기 */
export function rawResult(r: McpCallResult, max = 6_000): string {
	const data = resultData(r);
	const text = data !== undefined ? JSON.stringify(data, null, 2) : renderCallResult(r, max).text;
	return text.length > max ? `${text.slice(0, max)}\n…(잘림)` : text;
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
