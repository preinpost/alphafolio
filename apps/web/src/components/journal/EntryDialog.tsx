import type { JournalEntryDto } from "@alphafolio/protocol";
import { EMOTIONS, sideLabel } from "../../lib/journal.ts";
import { XIcon } from "../icons.tsx";
import { EntryFacts } from "./EntryFacts.tsx";
import { EntryTradeFields } from "./EntryTradeFields.tsx";
import { useEntryDialog } from "./useEntryDialog.ts";

/** 기록 보기·고치기 · 직접 기록 — 데스크톱은 가운데, 모바일은 바텀시트 */
export function EntryDialog({
	open,
	onClose,
	onSaved,
	onOpenConversation,
}: {
	open: "new" | JournalEntryDto | null;
	onClose: () => void;
	onSaved: () => void;
	onOpenConversation: (id: string) => void;
}) {
	const { ref, editing, tradeEditable, f, set, error, save, remove, submit, busy } = useEntryDialog({ open, onClose, onSaved });

	return (
		<dialog
			ref={ref}
			className="sheet"
			aria-labelledby="jr-dlg-title"
			onClose={onClose}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<form onSubmit={submit} noValidate>
				<div className="sheet-h">
					<h2 id="jr-dlg-title">{editing ? `${editing.name ?? editing.symbol} ${sideLabel(editing)}` : "매매 직접 기록"}</h2>
					<button type="button" className="icon-btn" onClick={onClose} aria-label="닫기">
						<XIcon />
					</button>
				</div>
				<div className="sheet-b">
					{editing && !tradeEditable && <EntryFacts editing={editing} onOpenConversation={onOpenConversation} />}

					{tradeEditable && <EntryTradeFields f={f} set={set} />}

					<label className="field">
						<span>근거 — 왜 샀나·팔았나</span>
						<textarea className="input" maxLength={1000} placeholder="예: 20일선 지지 + 외국인 3일 순매수, 실적 발표 전 분할 매수" value={f.thesis} onChange={(e) => set("thesis", e.target.value)} />
					</label>
					<div className="grid2">
						<label className="field">
							<span>목표가</span>
							<input className="input" inputMode="decimal" autoComplete="off" value={f.targetPrice} onChange={(e) => set("targetPrice", e.target.value)} />
						</label>
						<label className="field">
							<span>손절가</span>
							<input className="input" inputMode="decimal" autoComplete="off" value={f.stopPrice} onChange={(e) => set("stopPrice", e.target.value)} />
						</label>
					</div>
					<label className="field">
						<span>태그 (쉼표·띄어쓰기로 나눔)</span>
						<input className="input" placeholder="돌파, 실적, 눌림목" autoComplete="off" value={f.tags} onChange={(e) => set("tags", e.target.value)} />
					</label>
					<div className="field">
						<span>감정</span>
						<div className="jr-emotions" role="group" aria-label="감정">
							{EMOTIONS.map((x) => (
								<button key={x} type="button" className="chip" aria-pressed={f.emotion === x} onClick={() => set("emotion", f.emotion === x ? null : x)}>
									{x}
								</button>
							))}
						</div>
					</div>
					<label className="field">
						<span>회고 — 결과와 배운 점</span>
						<textarea className="input" maxLength={2000} placeholder="예: 손절가를 지켰다. 다음엔 거래량 확인 후 진입" value={f.review} onChange={(e) => set("review", e.target.value)} />
					</label>
					{error && <p className="field-err">{error}</p>}
				</div>
				<div className="sheet-f">
					{editing && (
						<button
							type="button"
							className="btn btn-danger mr-auto"
							disabled={busy}
							onClick={() => {
								const again = editing.source === "manual" ? "" : "\n지운 매매는 다음 가져오기에서 다시 들어오지 않습니다.";
								if (confirm(`이 기록을 지울까요?${again}`)) remove.mutate(editing.id);
							}}
						>
							삭제
						</button>
					)}
					<button type="button" className="btn btn-secondary" onClick={onClose}>
						취소
					</button>
					<button type="submit" className="btn btn-primary" disabled={busy}>
						{save.isPending ? "저장 중…" : "저장"}
					</button>
				</div>
			</form>
		</dialog>
	);
}
