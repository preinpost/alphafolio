import { useRef, useState, type KeyboardEvent } from "react";

interface Props {
	onSend: (text: string) => void;
	onAbort: () => void;
	streaming: boolean;
	disabled: boolean;
}

export function Composer({ onSend, onAbort, streaming, disabled }: Props) {
	const [text, setText] = useState("");
	const ref = useRef<HTMLTextAreaElement>(null);

	function submit(): void {
		if (!text.trim()) return;
		onSend(text);
		setText("");
		if (ref.current) ref.current.style.height = "auto";
	}

	function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
		// 모바일에서는 Enter가 줄바꿈이어야 한다 (전송은 버튼)
		if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) {
			e.preventDefault();
			submit();
		}
	}

	return (
		<div className="border-t border-line bg-canvas px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
			<div className="mx-auto flex max-w-3xl items-end gap-2">
				<textarea
					ref={ref}
					rows={1}
					value={text}
					disabled={disabled}
					placeholder={disabled ? "연결 중…" : "지출을 말하거나 물어보세요"}
					onChange={(e) => {
						setText(e.target.value);
						e.target.style.height = "auto";
						e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
					}}
					onKeyDown={onKeyDown}
					className="max-h-40 flex-1 resize-none rounded-2xl border border-line bg-card px-4 py-3 text-ink outline-none focus:border-accent disabled:opacity-60"
				/>
				{streaming ? (
					<button
						onClick={onAbort}
						className="rounded-2xl border border-line px-4 py-3 text-sm text-muted transition active:scale-95"
					>
						중지
					</button>
				) : (
					<button
						onClick={submit}
						disabled={disabled || !text.trim()}
						className="rounded-2xl bg-accent px-4 py-3 text-sm font-medium text-accent-ink transition active:scale-95 disabled:opacity-40"
					>
						보내기
					</button>
				)}
			</div>
		</div>
	);
}
