import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { MAX_ATTACH, prepareImage, type PreparedImage } from "../lib/images.ts";
import { ArrowUpIcon, ImageIcon, StopIcon, XIcon } from "./icons.tsx";

interface Props {
	onSend: (text: string, images: PreparedImage[]) => void;
	onAbort: () => void;
	streaming: boolean;
	disabled: boolean;
}

const MAX_HEIGHT = 200;

export function Composer({ onSend, onAbort, streaming, disabled }: Props) {
	const [text, setText] = useState("");
	const [images, setImages] = useState<PreparedImage[]>([]);
	const [busy, setBusy] = useState(false);
	const [attachError, setAttachError] = useState<string | null>(null);
	const ref = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const hasText = text.trim().length > 0;
	const canSend = (hasText || images.length > 0) && !busy;

	function submit(): void {
		if (!canSend) return;
		onSend(text, images);
		setText("");
		setImages([]);
		setAttachError(null);
		if (ref.current) ref.current.style.height = "auto";
	}

	/** 파일 선택·붙여넣기·끌어놓기 공용 — 줄여서 미리보기에 붙인다 */
	async function attach(files: File[]): Promise<void> {
		const picked = files.filter((f) => f.type.startsWith("image/"));
		if (picked.length === 0) return;
		const room = MAX_ATTACH - images.length;
		if (room <= 0) {
			setAttachError(`이미지는 한 번에 ${MAX_ATTACH}장까지 보낼 수 있어요`);
			return;
		}
		setBusy(true);
		setAttachError(picked.length > room ? `${MAX_ATTACH}장까지만 붙였어요` : null);
		try {
			const ready = await Promise.all(picked.slice(0, room).map(prepareImage));
			setImages((cur) => [...cur, ...ready].slice(0, MAX_ATTACH));
		} catch (err) {
			setAttachError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	function onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void {
		const files = [...e.clipboardData.files];
		if (files.some((f) => f.type.startsWith("image/"))) {
			e.preventDefault();
			void attach(files);
		}
	}

	function onDrop(e: DragEvent<HTMLDivElement>): void {
		if (e.dataTransfer.files.length === 0) return;
		e.preventDefault();
		void attach([...e.dataTransfer.files]);
	}

	function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
		// 모바일에서는 Enter가 줄바꿈이어야 한다 (전송은 버튼). 한글 조합 중 Enter도 무시.
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !("ontouchstart" in window)) {
			e.preventDefault();
			submit();
		}
	}

	// 응답 중이라도 입력이 있으면 전송 (서버가 후속 메시지로 큐잉). 비어 있으면 중지 버튼.
	const showStop = streaming && !hasText && images.length === 0;

	return (
		<div className="mx-auto w-full max-w-3xl">
			<div
				onClick={() => ref.current?.focus()}
				onDragOver={(e) => e.preventDefault()}
				onDrop={onDrop}
				className="flex cursor-text flex-col rounded-3xl border border-line bg-card shadow-[0_2px_12px_rgba(15,23,42,0.06)] transition focus-within:border-accent/60 focus-within:shadow-[0_2px_16px_rgba(37,99,235,0.12)]"
			>
				{images.length > 0 && (
					<div className="flex gap-2 overflow-x-auto px-4 pt-3">
						{images.map((img, i) => (
							<div key={img.dataUrl.slice(-32) + i} className="relative shrink-0">
								<img src={img.dataUrl} alt="" className="size-16 rounded-xl border border-line object-cover" />
								<button
									onMouseDown={(e) => e.preventDefault()}
									onClick={(e) => {
										e.stopPropagation();
										setImages((cur) => cur.filter((_, j) => j !== i));
									}}
									className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-ink text-canvas"
									aria-label="첨부 빼기"
								>
									<XIcon size={11} />
								</button>
							</div>
						))}
					</div>
				)}
				<textarea
					ref={ref}
					onPaste={onPaste}
					rows={1}
					value={text}
					disabled={disabled}
					placeholder={disabled ? "연결 중…" : "무엇이든 물어보세요"}
					onChange={(e) => {
						setText(e.target.value);
						e.target.style.height = "auto";
						e.target.style.height = `${Math.min(e.target.scrollHeight, MAX_HEIGHT)}px`;
					}}
					onKeyDown={onKeyDown}
					enterKeyHint="enter"
					autoComplete="off"
					autoCorrect="on"
					spellCheck={false}
					className="composer-textarea max-h-[200px] w-full resize-none bg-transparent px-5 pt-4 pb-1 text-[15px] text-ink outline-none placeholder:text-faint disabled:opacity-60"
				/>
				<div className="flex items-center justify-between gap-2 px-3 pb-3 pt-1">
					{/* iOS 에서는 카메라·사진 보관함 선택지가 함께 뜬다 (Info.plist 권한 문구 필요) */}
					<input
						ref={fileRef}
						type="file"
						accept="image/*"
						multiple
						hidden
						onChange={(e) => {
							void attach([...(e.target.files ?? [])]);
							e.target.value = ""; // 같은 파일을 다시 고를 수 있게
						}}
					/>
					<button
						onMouseDown={(e) => e.preventDefault()}
						onClick={(e) => {
							e.stopPropagation();
							fileRef.current?.click();
						}}
						disabled={disabled || busy || images.length >= MAX_ATTACH}
						className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-hover active:scale-95 disabled:opacity-40"
						aria-label="이미지 첨부"
					>
						<ImageIcon size={18} />
					</button>
					{attachError ? (
						<span className="truncate px-1 text-xs text-danger">{attachError}</span>
					) : busy ? (
						<span className="truncate px-1 text-xs text-faint">이미지 준비 중…</span>
					) : streaming ? (
						<span className="truncate px-2 text-xs text-faint">응답 중 — 입력하면 이어서 보낼 수 있어요</span>
					) : (
						<span className="hidden px-2 text-xs text-faint md:inline">Shift + Enter 줄바꿈</span>
					)}
					{showStop ? (
						<button
							onMouseDown={(e) => e.preventDefault()}
							onClick={(e) => {
								e.stopPropagation();
								onAbort();
							}}
							className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-canvas transition active:scale-95"
							aria-label="응답 중지"
						>
							<StopIcon size={14} />
						</button>
					) : (
						<button
							// 버튼이 포커스를 가져가지 않게 — 모바일에서 전송 후에도 키보드가 닫히지 않는다
							onMouseDown={(e) => e.preventDefault()}
							onClick={(e) => {
								e.stopPropagation();
								submit();
							}}
							disabled={disabled || !canSend}
							className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition active:scale-95 disabled:bg-inset disabled:text-faint"
							aria-label="보내기"
						>
							<ArrowUpIcon size={18} />
						</button>
					)}
				</div>
			</div>
			<p className="hide-on-keyboard mt-2 text-center text-[11px] text-faint">
				AI 분석은 참고용이며, 투자 판단과 그 책임은 본인에게 있습니다.
			</p>
		</div>
	);
}
