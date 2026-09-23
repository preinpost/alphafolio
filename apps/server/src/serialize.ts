/**
 * pi 메시지·이벤트 → UI 프로토콜 변환.
 *
 * pi-finances/containers/web/server/serialize.ts 를 AlphaFolio 카드 계약에 맞춰 이식했다.
 * 유지한 핵심 로직:
 *   - toolResult 메시지를 해당 toolCall 블록에 페어링해서 합친다 (역할 분리된 두 메시지를 하나로)
 *   - 사고 토큰(thinking 블록, <think> 태그, 태그 없는 혼잣말)을 UI에 노출하지 않는다
 * 바꾼 부분:
 *   - 카드 파싱을 KIS 전용 차트에서 details.kind 기반 일반 파서로 교체
 */
import type { UICard, UIContentBlock, UIMessage, UIToolResult } from "@alphafolio/protocol";
import { sanitizeAssistantText } from "./thinkingText.ts";

type AnyMessage = {
	role: string;
	content?: unknown;
	errorMessage?: string;
	toolCallId?: string;
	isError?: boolean;
	details?: unknown;
	[key: string]: unknown;
};

const CARD_KINDS = new Set([
	"ledger-tx",
	"ledger-summary",
	"ledger-table",
	"ledger-budget",
	"technical-card",
	"portfolio-signals-card",
	"timing-card",
	"research-card",
	"financials-card",
	"quote-card",
	"holdings-card",
	"movers-card",
	"news-card",
	"order-preview-card",
	"order-list-card",
	"order-change-card",
	"conditional-order-card",
	"overview-card",
]);

/**
 * 툴 결과의 details를 카드로 해석한다.
 * 알 수 없는 kind는 버린다 — UI가 렌더할 수 없는 페이로드를 굳이 보내지 않는다.
 */
export function parseCard(details: unknown): UICard | undefined {
	if (!details || typeof details !== "object") return undefined;
	const kind = (details as { kind?: unknown }).kind;
	if (typeof kind !== "string" || !CARD_KINDS.has(kind)) return undefined;
	return details as UICard;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
			.map((b) => (b as { text: string }).text)
			.join("\n");
	}
	return "";
}

/** pi의 AgentMessage[] 를 UI 메시지로 변환한다. */
export function serializeMessages(messages: unknown[]): UIMessage[] {
	const msgs = messages as AnyMessage[];

	// toolCallId → 결과 매핑 (toolResult는 별도 메시지로 오므로 먼저 모은다)
	const results = new Map<string, UIToolResult>();
	for (const m of msgs) {
		if (m.role === "toolResult" && typeof m.toolCallId === "string") {
			const card = parseCard(m.details);
			results.set(m.toolCallId, {
				text: textFromContent(m.content),
				isError: m.isError === true,
				...(card ? { card } : {}),
			});
		}
	}

	const out: UIMessage[] = [];
	for (const m of msgs) {
		if (m.role === "toolResult") continue; // toolCall 블록에 합쳐진다

		if (m.role === "user") {
			const blocks: UIContentBlock[] = [];
			if (typeof m.content === "string") {
				blocks.push({ type: "text", text: m.content });
			} else if (Array.isArray(m.content)) {
				for (const b of m.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>) {
					if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text });
					else if (b.type === "image") {
						blocks.push({
							type: "image",
							dataUrl: b.data && b.mimeType ? `data:${b.mimeType};base64,${b.data}` : undefined,
						});
					}
				}
			}
			if (blocks.length > 0) out.push({ role: "user", content: blocks });
			continue;
		}

		if (m.role === "assistant") {
			const blocks: UIContentBlock[] = [];
			if (Array.isArray(m.content)) {
				for (const b of m.content as Array<Record<string, unknown>>) {
					if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
						const text = sanitizeAssistantText(b.text);
						if (text) blocks.push({ type: "text", text });
					} else if (b.type === "thinking") {
						continue; // 사고 토큰은 노출하지 않는다
					} else if (b.type === "toolCall") {
						const id = String(b.id ?? "");
						blocks.push({
							type: "toolCall",
							id,
							name: String(b.name ?? "unknown"),
							args: b.arguments,
							result: results.get(id),
						});
					}
				}
			}
			if (blocks.length > 0 || m.errorMessage) {
				out.push({
					role: "assistant",
					content: blocks,
					errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : undefined,
				});
			}
			continue;
		}

		const text = textFromContent(m.content);
		if (text) out.push({ role: "custom", content: [{ type: "text", text }] });
	}

	return out;
}
