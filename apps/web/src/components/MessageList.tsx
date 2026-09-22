import { useEffect, useRef } from "react";
import type { UIMessage } from "@alphafolio/protocol";
import { pickToolFlavorLine, toolFlavor } from "../lib/toolFlavor.ts";
import { CardView } from "./cards/index.tsx";
import { Markdown } from "./Markdown.tsx";
import { PixelLoader } from "./PixelLoader.tsx";
import type { RunningTool } from "../lib/chat.ts";

interface Props {
	messages: UIMessage[];
	pending: string;
	streaming: boolean;
	runningTools: RunningTool[];
}

const SUGGESTIONS = [
	"어제 김밥천국에서 8천원 썼어",
	"이번 달 얼마나 썼어?",
	"삼성전자 지금 얼마야?",
	"내 자산 현황 보여줘",
];

export function MessageList({ messages, pending, streaming, runningTools }: Props) {
	const bottomRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
	}, [messages, pending, runningTools]);

	if (messages.length === 0 && !streaming) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
				<div className="flex size-14 items-center justify-center rounded-2xl bg-accent text-3xl font-semibold text-accent-ink">
					α
				</div>
				<div>
					<h2 className="text-lg font-semibold text-ink">무엇을 도와드릴까요?</h2>
					<p className="mt-1 text-sm text-muted">지출을 말로 기록하고, 이번 달 소비를 물어보세요.</p>
				</div>
				<div className="flex flex-wrap justify-center gap-2">
					{SUGGESTIONS.map((s) => (
						<span key={s} className="rounded-full border border-line px-3 py-1.5 text-xs text-muted">
							{s}
						</span>
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="flex-1 overflow-y-auto">
			<div className="mx-auto max-w-3xl space-y-5 px-4 py-6">
				{messages.map((m, i) => (
					<MessageRow key={i} message={m} />
				))}

				{pending && (
					<div className="text-ink">
						<Markdown text={pending} />
					</div>
				)}

				{runningTools.map((t) => (
					<div key={t.id} className="flex items-center gap-2 text-sm text-muted">
						<PixelLoader />
						<span>{pickToolFlavorLine(toolFlavor(t.name), "running", t.id, "ko")}</span>
					</div>
				))}

				{streaming && !pending && runningTools.length === 0 && (
					<div className="flex items-center gap-2 text-sm text-muted">
						<PixelLoader />
						<span>생각하는 중…</span>
					</div>
				)}

				<div ref={bottomRef} />
			</div>
		</div>
	);
}

function MessageRow({ message }: { message: UIMessage }) {
	if (message.role === "user") {
		const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
		return (
			<div className="flex justify-end">
				<div className="max-w-[85%] rounded-2xl bg-bubble px-4 py-2.5 text-ink">{text}</div>
			</div>
		);
	}

	return (
		<div className="space-y-2 text-ink">
			{message.content.map((block, i) => {
				if (block.type === "text") return <Markdown key={i} text={block.text} />;

				if (block.type === "toolCall") {
					const flavor = toolFlavor(block.name);
					const state = block.result?.isError ? "error" : "done";
					return (
						<div key={i}>
							<div className="text-xs text-faint">{pickToolFlavorLine(flavor, state, block.id, "ko")}</div>
							{block.result?.card && <CardView card={block.result.card} />}
						</div>
					);
				}

				if (block.type === "image" && block.dataUrl) {
					return <img key={i} src={block.dataUrl} alt="" className="max-h-80 rounded-xl" />;
				}
				return null;
			})}
			{message.errorMessage && <div className="text-sm text-danger">{message.errorMessage}</div>}
		</div>
	);
}
