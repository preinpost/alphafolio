import type { LedgerTransaction } from "@alphafolio/protocol";
import { XIcon } from "../icons.tsx";
import { todayKST } from "./format.ts";
import { useTxDialog } from "./useTxDialog.ts";

/** 기록 추가·고치기 — 데스크톱은 가운데, 모바일은 바텀시트 */
export function TxDialog({
	open,
	ledgerId,
	me,
	cats,
	onClose,
	onSaved,
}: {
	open: "new" | LedgerTransaction | null;
	ledgerId: string | undefined;
	me: string | null;
	cats: string[];
	onClose: () => void;
	onSaved: (date: string) => void;
}) {
	const { ref, amountRef, merchantRef, editing, type, setType, amount, setAmount, merchant, setMerchant, category, setCategory, date, setDate, memo, setMemo, errors, save, remove, submit, error } =
		useTxDialog({ open, ledgerId, me, onClose, onSaved });

	return (
		<dialog
			ref={ref}
			className="sheet"
			aria-labelledby="tx-dlg-title"
			onClose={onClose}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<form onSubmit={submit} noValidate>
				<div className="sheet-h">
					<h2 id="tx-dlg-title">{editing ? "기록 고치기" : "기록 추가"}</h2>
					<button type="button" className="icon-btn" onClick={onClose} aria-label="닫기">
						<XIcon />
					</button>
				</div>
				<div className="sheet-b">
					<div className="seg block" role="group" aria-label="구분">
						<button type="button" aria-pressed={type === "expense"} onClick={() => setType("expense")}>
							지출
						</button>
						<button type="button" aria-pressed={type === "income"} onClick={() => setType("income")}>
							수입
						</button>
					</div>
					<label className="field">
						<span>금액</span>
						<input
							ref={amountRef}
							className="input amount-input"
							inputMode="numeric"
							placeholder="0원"
							autoComplete="off"
							value={amount}
							aria-invalid={!!errors.amount}
							onChange={(e) => {
								const n = e.target.value.replace(/[^\d]/g, "");
								setAmount(n ? Number(n).toLocaleString("ko-KR") : "");
							}}
						/>
						{errors.amount && <span className="field-err">{errors.amount}</span>}
					</label>
					<label className="field">
						<span>가맹점·내용</span>
						<input
							ref={merchantRef}
							className="input"
							placeholder="예: 김밥천국"
							autoComplete="off"
							value={merchant}
							aria-invalid={!!errors.merchant}
							onChange={(e) => setMerchant(e.target.value)}
						/>
						{errors.merchant && <span className="field-err">{errors.merchant}</span>}
					</label>
					<div className="grid2">
						<label className="field">
							<span>분류</span>
							<input className="input" list="tx-cats" placeholder="예: 식비" autoComplete="off" value={category} onChange={(e) => setCategory(e.target.value)} />
							<datalist id="tx-cats">
								{cats.map((c) => (
									<option key={c} value={c} />
								))}
							</datalist>
						</label>
						<label className="field">
							<span>날짜</span>
							<input className="input" type="date" max={todayKST()} value={date} onChange={(e) => setDate(e.target.value || todayKST())} />
						</label>
					</div>
					<label className="field">
						<span>메모 (선택)</span>
						<input className="input" autoComplete="off" value={memo} onChange={(e) => setMemo(e.target.value)} />
					</label>
					{editing?.member && editing.member !== me && <p className="field-hint">{editing.member} 님이 남긴 기록입니다.</p>}
					{error && <p className="field-err">{error.message}</p>}
				</div>
				<div className="sheet-f">
					{editing && (
						<button
							type="button"
							className="btn btn-danger mr-auto"
							disabled={remove.isPending}
							onClick={() => {
								if (confirm("이 기록을 지울까요?")) remove.mutate(editing);
							}}
						>
							삭제
						</button>
					)}
					<button type="button" className="btn btn-secondary" onClick={onClose}>
						취소
					</button>
					<button type="submit" className="btn btn-primary" disabled={save.isPending}>
						{save.isPending ? "저장 중…" : "저장"}
					</button>
				</div>
			</form>
		</dialog>
	);
}
