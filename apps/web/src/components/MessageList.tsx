import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UIContentBlock, UIMessage } from "@alphafolio/protocol";
import { pickThinkingLine, pickToolFlavorLine, type ToolFlavorState } from "../lib/toolFlavor.ts";
import { toast } from "../lib/toast.ts";
import { CardView } from "./cards/index.tsx";
import { AlertIcon, ArrowDownIcon, CheckIcon, CopyIcon } from "./icons.tsx";
import { Logo } from "./Logo.tsx";
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
	{ text: "삼성전자 얼마야", sub: "시세 조회" },
	{ text: "내 보유 종목 점검해줘", sub: "포트폴리오" },
	{ text: "이번 달 지출 얼마나 썼어?", sub: "가계부" },
	{ text: "오늘 증시 주도주 어디야?", sub: "시장 요약" },
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

	// 바닥에 붙어 있을 때만 따라간다 — 스트리밍 텍스트, 늦게 그려지는 카드는 내용 높이 변화로,
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
	const shownToolIds = new Set(messages.flatMap((m) => m.content.flatMap((b) => (b.type === "toolCall" ? [b.id] : []))));
	const live = streaming ? (
		<LiveBlocks pending={pending} runningTools={runningTools.filter((t) => !shownToolIds.has(t.id))} seed={String(messages.length)} />
	) : null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div ref={scrollRef} onScroll={onScroll} className="page thin-scroll">
				<div ref={contentRef} className="min-h-full">
					{empty ? (
						<Welcome onSuggest={onSuggest} canSuggest={canSuggest} />
					) : (
						<div className="thread">
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
				<div className="composer-fade" />
				{!atBottom && !empty && (
					<button
						onClick={() => {
							stickRef.current = true;
							scrollToBottom("smooth");
						}}
						className="btn btn-secondary btn-sm to-bottom pop-in"
					>
						<ArrowDownIcon size={14} />
						맨 아래로
					</button>
				)}
				{footer}
			</div>
		</div>
	);
}

function Welcome({ onSuggest, canSuggest }: { onSuggest: (text: string) => void; canSuggest: boolean }) {
	return (
		<div className="hello">
			<Logo className="fade-up" />
			<h2 className="fade-up" style={{ animationDelay: "60ms" }}>
				무엇을 도와드릴까요?
			</h2>
			<p className="fade-up" style={{ animationDelay: "90ms" }}>
				시세·차트 분석부터 가계부 기록까지, 말로 물어보세요.
			</p>
			<div className="suggest">
				{SUGGESTIONS.map((s, i) => (
					<button
						key={s.text}
						disabled={!canSuggest}
						onClick={() => onSuggest(s.text)}
						className="fade-up"
						style={{ animationDelay: `${120 + i * 50}ms` }}
					>
						{s.text}
						<small>{s.sub}</small>
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
		<div className="msg-user fade-up">
			{/* 터치 기기는 호버가 없으니 숨긴다 — 길게 눌러 네이티브 텍스트 선택으로 복사한다 */}
			{finePointer && text && <ActionBar text={text} onHover />}
			<div className="stack">
				{images.length > 0 && (
					<div className={`msg-images ${images.length === 1 ? "single" : ""}`}>
						{images.map((src, i) => (
							<img key={i} src={src} alt="첨부 이미지" />
						))}
					</div>
				)}
				{text && <div className="bubble">{text}</div>}
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
		<div className="msg-ai fade-up">
			<Logo />
			<div className="body">
				{messages.map((m, mi) =>
					m.content.map((block, i) => <Block key={`${mi}-${i}`} block={block} busy={busy} />).concat(
						m.errorMessage ? (
							<div key={`${mi}-err`} className="notice bad">
								<AlertIcon size={16} />
								<span>{m.errorMessage}</span>
							</div>
						) : (
							[]
						),
					),
				)}
				{live}
				{!busy && text && <ActionBar text={text} onHover={!isLast && finePointer} />}
			</div>
		</div>
	);
}

function Block({ block, busy }: { block: UIContentBlock; busy: boolean }) {
	if (block.type === "text") return block.text ? <Markdown text={block.text} /> : null;

	if (block.type === "toolCall") {
		// 결과가 없으면 아직 실행 중 — 단, 턴이 끝났는데도 없으면(중지 등) 끝나지 못한 것으로 본다
		const state: ToolFlavorState = block.result ? (block.result.isError ? "error" : "done") : busy ? "running" : "error";
		return (
			<>
				<ToolChip name={block.name} state={state} seed={block.id} />
				{block.result?.card && <CardView card={block.result.card} outcome={block.result.outcome} />}
			</>
		);
	}

	if (block.type === "image" && block.dataUrl) {
		return <img src={block.dataUrl} alt="" className="max-h-80 self-start rounded-xl border border-line" />;
	}
	return null;
}

function ToolChip({ name, state, seed }: { name: string; state: ToolFlavorState; seed: string }) {
	return (
		<div className={`tool-chip ${state === "running" ? "running" : state === "error" ? "err" : ""}`}>
			{state === "running" ? <PixelLoader /> : state === "error" ? <AlertIcon size={14} /> : <CheckIcon size={14} />}
			<span className={`label ${state === "running" ? "shimmer-text" : ""}`}>{pickToolFlavorLine(name, state, seed, "ko")}</span>
		</div>
	);
}

/** 아직 message_end 로 확정되지 않은 스트리밍 텍스트 + 실행 중인 툴 + 생각 중 표시 */
function LiveBlocks({ pending, runningTools, seed }: { pending: string; runningTools: RunningTool[]; seed: string }) {
	return (
		<>
			{pending && <Markdown text={pending} />}
			{runningTools.length > 0 && (
				<div className="tools">
					{runningTools.map((t) => (
						<ToolChip key={t.id} name={t.name} state="running" seed={t.id} />
					))}
				</div>
			)}
			{!pending && runningTools.length === 0 && (
				<div className="thinking">
					<PixelLoader className="text-accent" />
					<span className="shimmer-text">{pickThinkingLine("running", seed, "ko")}</span>
				</div>
			)}
		</>
	);
}

function ActionBar({ text, onHover = false }: { text: string; onHover?: boolean }) {
	const [copied, setCopied] = useState(false);

	async function copy(): Promise<void> {
		if (await copyText(text)) {
			setCopied(true);
			toast("복사했습니다");
			setTimeout(() => setCopied(false), 1500);
		}
	}

	return (
		<div className={`msg-actions ${onHover ? "on-hover" : ""}`}>
			<button onClick={() => void copy()} className="icon-btn" aria-label={copied ? "복사됨" : "복사"} title={copied ? "복사됨" : "복사"}>
				{copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
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
