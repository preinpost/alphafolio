import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UIContentBlock, UIMessage } from "@alphafolio/protocol";
import { pickThinkingLine, pickToolFlavorLine, type ToolFlavorState } from "../lib/toolFlavor.ts";
import { CardView } from "./cards/index.tsx";
import { AlertIcon, ArrowDownIcon, CheckIcon, CopyIcon } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { PixelLoader } from "./PixelLoader.tsx";
import type { RunningTool } from "../lib/chat.ts";
import { finePointer } from "../lib/viewport.ts";

interface Props {
	messages: UIMessage[];
	pending: string;
	streaming: boolean;
	runningTools: RunningTool[];
	onSuggest: (text: string) => void;
	canSuggest: boolean;
	/** 컴포저 영역 — 스크롤 영역 아래에 붙고, "맨 아래로" 버튼이 그 위에 뜬다 */
	footer: ReactNode;
}

const SUGGESTIONS = [
	{ title: "내 보유 종목", sub: "점검해줘" },
	{ title: "삼성전자", sub: "기술적 분석 해줘" },
	{ title: "오늘 증시", sub: "주도주 어디야?" },
	{ title: "이번 달 지출", sub: "얼마나 썼어?" },
];

/** 바닥에서 이 거리(px) 안이면 "바닥에 붙어 있다"로 본다 */
const STICK_THRESHOLD = 80;

type Turn =
	| { role: "user"; key: string; message: UIMessage }
	| { role: "assistant"; key: string; messages: UIMessage[] };

/** 연속된 assistant/custom 메시지(텍스트→툴→텍스트…)를 한 턴으로 묶는다 */
function groupTurns(messages: UIMessage[]): Turn[] {
	const turns: Turn[] = [];
	messages.forEach((m, i) => {
		if (m.role === "user") {
			turns.push({ role: "user", key: `u${i}`, message: m });
			return;
		}
		const last = turns.at(-1);
		if (last?.role === "assistant") last.messages.push(m);
		else turns.push({ role: "assistant", key: `a${i}`, messages: [m] });
	});
	return turns;
}

function textOf(blocks: UIContentBlock[]): string {
	return blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
}

export function MessageList({ messages, pending, streaming, runningTools, onSuggest, canSuggest, footer }: Props) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	const [atBottom, setAtBottom] = useState(true);
	const prevLenRef = useRef(messages.length);

	function scrollToBottom(behavior: ScrollBehavior): void {
		const el = scrollRef.current;
		if (el) el.scrollTo({ top: el.scrollHeight, behavior });
	}

	/** 바닥 근처인가 — 내용이 화면보다 짧으면 스크롤할 게 없으니 항상 바닥이다 */
	function measure(): boolean {
		const el = scrollRef.current;
		if (!el) return true;
		return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
	}

	function onScroll(): void {
		const near = measure();
		stickRef.current = near;
		setAtBottom(near);
	}

	// 내가 보낸 메시지는 위로 스크롤해 있던 중이어도 바닥으로 데려간다
	useEffect(() => {
		const grew = messages.length > prevLenRef.current;
		prevLenRef.current = messages.length;
		if (grew && messages.at(-1)?.role === "user") {
			stickRef.current = true;
			scrollToBottom("smooth");
		}
	}, [messages]);

	// 바닥에 붙어 있을 때만 따라간다 — 스트리밍 텍스트, 늦게 그려지는 카드(차트 등)는 내용 높이 변화로,
	// 모바일 키보드가 열리며 보이는 영역이 줄어드는 건 스크롤 영역 높이 변화로 잡힌다.
	// 사용자가 위로 올려 읽는 중이면 끌어내리지 않는다.
	useEffect(() => {
		const content = contentRef.current;
		const viewport = scrollRef.current;
		if (!content || !viewport) return;
		const ro = new ResizeObserver(() => {
			if (stickRef.current) scrollToBottom("auto");
			// 스크롤 없이 높이만 바뀌는 경우(대화 전환·내용이 짧아짐·창 크기 변경)에는 scroll 이벤트가
			// 오지 않는다 — 여기서 다시 재지 않으면 "맨 아래로" 버튼이 내용 없이 남는다.
			// 사용자가 올려 읽는 중(stick=false)이면 stick 은 건드리지 않고 버튼 표시만 맞춘다.
			const near = measure();
			if (near) stickRef.current = true;
			setAtBottom(near);
		});
		ro.observe(content);
		ro.observe(viewport);
		return () => ro.disconnect();
	}, []);

	const empty = messages.length === 0 && !streaming;
	const turns = groupTurns(messages);
	const lastTurn = turns.at(-1);
	const liveInLastTurn = streaming && lastTurn?.role === "assistant";

	// message_end 로 이미 메시지에 들어간 툴 호출은 그 자리에서 진행 상태를 그린다 (칩 중복 방지)
	const shownToolIds = new Set(
		messages.flatMap((m) => m.content.flatMap((b) => (b.type === "toolCall" ? [b.id] : []))),
	);
	const live = streaming ? (
		<LiveBlocks
			pending={pending}
			runningTools={runningTools.filter((t) => !shownToolIds.has(t.id))}
			seed={String(messages.length)}
		/>
	) : null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div ref={scrollRef} onScroll={onScroll} className="thin-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
				<div ref={contentRef} className="min-h-full">
					{empty ? (
						<Welcome onSuggest={onSuggest} canSuggest={canSuggest} />
					) : (
						<div className="mx-auto max-w-3xl space-y-6 px-4 pt-4 pb-8">
							{turns.map((t, i) =>
								t.role === "user" ? (
									<UserTurn key={t.key} message={t.message} />
								) : (
									<AssistantTurn
										key={t.key}
										messages={t.messages}
										live={liveInLastTurn && i === turns.length - 1 ? live : null}
										isLast={i === turns.length - 1}
										busy={streaming && i === turns.length - 1}
									/>
								),
							)}
							{streaming && !liveInLastTurn && <AssistantTurn messages={[]} live={live} isLast busy />}
						</div>
					)}
				</div>
			</div>

			<div className="composer-bar relative shrink-0">
				<div className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-linear-to-t from-canvas to-transparent" />
				{!atBottom && !empty && (
					<button
						onClick={() => {
							stickRef.current = true;
							scrollToBottom("smooth");
						}}
						className="pop-in absolute -top-12 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-card text-muted shadow-md transition hover:text-ink"
						aria-label="맨 아래로"
					>
						<ArrowDownIcon size={16} />
					</button>
				)}
				{footer}
			</div>
		</div>
	);
}

function Welcome({ onSuggest, canSuggest }: { onSuggest: (text: string) => void; canSuggest: boolean }) {
	return (
		<div className="mx-auto flex min-h-full max-w-3xl flex-col px-4 pb-4">
			<div className="flex flex-1 flex-col items-center justify-center gap-4 py-10 text-center">
				<div className="fade-up flex size-14 items-center justify-center rounded-2xl bg-accent text-3xl font-semibold text-accent-ink shadow-lg shadow-accent/20">
					α
				</div>
				<div className="fade-up" style={{ animationDelay: "60ms" }}>
					<h2 className="text-2xl font-semibold tracking-tight text-ink">무엇을 도와드릴까요?</h2>
					<p className="mt-1.5 text-sm text-muted">시세·차트 분석부터 가계부 기록까지, 말로 물어보세요.</p>
				</div>
			</div>
			<div className="grid grid-cols-2 gap-2">
				{SUGGESTIONS.map((s, i) => (
					<button
						key={s.title}
						disabled={!canSuggest}
						onClick={() => onSuggest(`${s.title} ${s.sub}`)}
						style={{ animationDelay: `${120 + i * 50}ms` }}
						className="fade-up flex min-w-0 flex-col items-start rounded-2xl border border-line bg-card px-4 py-3 text-left transition hover:bg-hover active:scale-[0.98] active:bg-hover disabled:opacity-50"
					>
						<span className="w-full truncate text-sm font-medium text-ink">{s.title}</span>
						<span className="w-full truncate text-sm text-muted">{s.sub}</span>
					</button>
				))}
			</div>
		</div>
	);
}

function UserTurn({ message }: { message: UIMessage }) {
	const text = textOf(message.content);
	const images = message.content.flatMap((b) => (b.type === "image" && b.dataUrl ? [b.dataUrl] : []));
	return (
		<div className="group fade-up flex items-start justify-end gap-1.5">
			{/* 터치 기기는 호버가 없으니 숨긴다 — 길게 눌러 네이티브 텍스트 선택으로 복사한다 */}
			{finePointer && (
				<ActionBar className="mt-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100" text={text} />
			)}
			<div className="flex max-w-[85%] flex-col items-end gap-1.5">
				{images.length > 0 && (
					<div className="flex flex-wrap justify-end gap-1.5">
						{images.map((src, i) => (
							<img
								key={i}
								src={src}
								alt="첨부 이미지"
								className={`rounded-2xl border border-line object-cover ${images.length === 1 ? "max-h-72 max-w-full" : "size-28"}`}
							/>
						))}
					</div>
				)}
				{text && (
					<div className="rounded-3xl bg-bubble px-5 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words text-ink">
						{text}
					</div>
				)}
			</div>
		</div>
	);
}

interface AssistantTurnProps {
	messages: UIMessage[];
	live: ReactNode;
	isLast: boolean;
	/** 이 턴이 아직 스트리밍 중 — 액션바를 숨긴다 */
	busy: boolean;
}

function AssistantTurn({ messages, live, isLast, busy }: AssistantTurnProps) {
	const text = messages
		.map((m) => textOf(m.content))
		.filter(Boolean)
		.join("\n\n");

	return (
		<div className="group fade-up flex gap-3">
			<div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-ink">
				α
			</div>
			<div className="min-w-0 flex-1 space-y-3 text-ink">
				{messages.map((m, mi) => (
					<div key={mi} className="space-y-3">
						{m.content.map((block, i) => (
							<Block key={i} block={block} busy={busy} />
						))}
						{m.errorMessage && (
							<div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
								<AlertIcon size={16} className="mt-0.5 shrink-0" />
								<span>{m.errorMessage}</span>
							</div>
						)}
					</div>
				))}
				{live}
				{!busy && text && (
					<ActionBar
						text={text}
						className={
							isLast || !finePointer ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
						}
					/>
				)}
			</div>
		</div>
	);
}

function Block({ block, busy }: { block: UIContentBlock; busy: boolean }) {
	if (block.type === "text") return block.text ? <Markdown text={block.text} /> : null;

	if (block.type === "toolCall") {
		// 결과가 없으면 아직 실행 중 — 단, 턴이 끝났는데도 없으면(중지 등) 끝나지 못한 것으로 본다
		const state: ToolFlavorState = block.result
			? block.result.isError
				? "error"
				: "done"
			: busy
				? "running"
				: "error";
		return (
			<div className="space-y-2">
				<ToolChip name={block.name} state={state} seed={block.id} />
				{block.result?.card && <CardView card={block.result.card} />}
			</div>
		);
	}

	if (block.type === "image" && block.dataUrl) {
		return <img src={block.dataUrl} alt="" className="max-h-80 rounded-xl" />;
	}
	return null;
}

function ToolChip({ name, state, seed }: { name: string; state: ToolFlavorState; seed: string }) {
	return (
		<div
			className={`inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1 text-xs ${
				state === "error" ? "border-danger/30 bg-danger/10 text-danger" : "border-line bg-inset text-muted"
			}`}
		>
			{state === "running" ? (
				<PixelLoader className="shrink-0 text-accent" />
			) : state === "error" ? (
				<AlertIcon size={13} className="shrink-0" />
			) : (
				<CheckIcon size={13} className="shrink-0 text-success" />
			)}
			<span className={`truncate ${state === "running" ? "shimmer-text" : ""}`}>
				{pickToolFlavorLine(name, state, seed, "ko")}
			</span>
		</div>
	);
}

/** 아직 message_end 로 확정되지 않은 스트리밍 텍스트 + 실행 중인 툴 + 생각 중 표시 */
function LiveBlocks({ pending, runningTools, seed }: { pending: string; runningTools: RunningTool[]; seed: string }) {
	return (
		<>
			{pending && <Markdown text={pending} />}
			{runningTools.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{runningTools.map((t) => (
						<ToolChip key={t.id} name={t.name} state="running" seed={t.id} />
					))}
				</div>
			)}
			{!pending && runningTools.length === 0 && (
				<div className="flex h-7 items-center gap-2 text-sm">
					<PixelLoader className="text-accent" />
					<span className="shimmer-text">{pickThinkingLine("running", seed, "ko")}</span>
				</div>
			)}
		</>
	);
}

function ActionBar({ text, className = "" }: { text: string; className?: string }) {
	const [copied, setCopied] = useState(false);

	async function copy(): Promise<void> {
		if (await copyText(text)) {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		}
	}

	return (
		<div className={`flex items-center gap-0.5 transition-opacity ${className}`}>
			<button
				onClick={() => void copy()}
				className="flex size-9 items-center justify-center rounded-lg text-faint transition hover:bg-hover hover:text-ink active:bg-selected md:size-7"
				aria-label={copied ? "복사됨" : "복사"}
				title={copied ? "복사됨" : "복사"}
			>
				{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
			</button>
		</div>
	);
}

/** clipboard API 는 보안 컨텍스트(https/localhost) 전용 — LAN http 접속 등에선 execCommand 로 폴백 */
async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		/* 폴백으로 */
	}
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.style.position = "fixed";
	ta.style.opacity = "0";
	document.body.appendChild(ta);
	ta.select();
	const ok = document.execCommand("copy");
	ta.remove();
	return ok;
}
