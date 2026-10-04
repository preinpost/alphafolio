/**
 * 직접 입력 자산 추가·수정 폼 — API 가 없는 곳(은행 예금·연금·부동산·다른 거래소)의 금액.
 * 저장하면 투자 화면의 총자산·배분·계좌 카드("직접 입력")에 바로 들어간다.
 */
import type { ManualAssetDto, ManualKind } from "@alphafolio/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api.ts";

export const MANUAL_KIND_LABEL: Record<ManualKind, string> = {
	deposit: "예금·현금",
	pension: "연금",
	real_estate: "부동산",
	investment: "기타 투자",
	other: "기타",
};

const field = "min-w-0 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent";

export function ManualAssetEditor({ asset, onDone }: { asset?: ManualAssetDto; onDone: () => void }) {
	const [name, setName] = useState(asset?.name ?? "");
	const [kind, setKind] = useState<ManualKind>(asset?.kind ?? "deposit");
	const [currency, setCurrency] = useState<"KRW" | "USD">(asset?.currency ?? "KRW");
	const [amount, setAmount] = useState(asset ? String(asset.amount) : "");
	const [memo, setMemo] = useState(asset?.memo ?? "");

	const qc = useQueryClient();
	const refresh = (): void => {
		void qc.invalidateQueries({ queryKey: ["portfolio"] });
		onDone();
	};
	const save = useMutation({
		mutationFn: () => {
			const body = { name: name.trim(), kind, currency, amount: Number(amount.replace(/,/g, "")), memo: memo.trim() || null };
			return asset ? api.updateManualAsset(asset.id, body) : api.addManualAsset(body);
		},
		onSuccess: refresh,
	});
	const remove = useMutation({ mutationFn: () => api.deleteManualAsset(asset!.id), onSuccess: refresh });

	const n = Number(amount.replace(/,/g, ""));
	const valid = name.trim().length > 0 && amount.trim() !== "" && Number.isFinite(n) && n >= 0;
	const error = (save.error ?? remove.error) as Error | null;

	return (
		<div className="space-y-2 border-b border-line bg-inset px-4 py-3 last:border-0">
			<div className="flex gap-2">
				<input placeholder="이름 (예: 주택청약, 퇴직연금)" value={name} onChange={(e) => setName(e.target.value)} className={`${field} flex-1`} />
				<select value={kind} onChange={(e) => setKind(e.target.value as ManualKind)} className={field}>
					{(Object.keys(MANUAL_KIND_LABEL) as ManualKind[]).map((k) => (
						<option key={k} value={k}>
							{MANUAL_KIND_LABEL[k]}
						</option>
					))}
				</select>
			</div>
			<div className="flex gap-2">
				<input
					inputMode="decimal"
					placeholder="금액"
					value={amount}
					onChange={(e) => setAmount(e.target.value)}
					className={`${field} flex-1`}
				/>
				<select value={currency} onChange={(e) => setCurrency(e.target.value as "KRW" | "USD")} className={field}>
					<option value="KRW">원</option>
					<option value="USD">달러</option>
				</select>
			</div>
			<input placeholder="메모 (선택)" value={memo} onChange={(e) => setMemo(e.target.value)} className={`${field} w-full`} />
			{error && <p className="text-xs text-danger">{error.message}</p>}
			<div className="flex items-center gap-2">
				{asset && (
					<button
						onClick={() => {
							if (confirm(`'${asset.name}' 을(를) 지울까요?`)) remove.mutate();
						}}
						disabled={remove.isPending}
						className="rounded-lg px-3 py-1.5 text-xs text-danger disabled:opacity-50"
					>
						삭제
					</button>
				)}
				<div className="flex-1" />
				<button onClick={onDone} className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted">
					취소
				</button>
				<button
					onClick={() => save.mutate()}
					disabled={!valid || save.isPending}
					className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-40"
				>
					{save.isPending ? "저장 중…" : "저장"}
				</button>
			</div>
		</div>
	);
}
