/**
 * 직접 입력 자산 추가·수정 폼 — API 가 없는 곳(은행 예금·연금·부동산·다른 거래소)의 금액.
 * 보유 자산 목록의 그 행 자리에서 펼친다. 저장하면 총자산·배분·계좌("직접 입력")에 바로 들어간다.
 */
import type { ManualAssetDto, ManualKind } from "@alphafolio/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api.ts";
import { toast } from "../lib/toast.ts";

export const MANUAL_KIND_LABEL: Record<ManualKind, string> = {
	deposit: "예금·현금",
	pension: "연금",
	real_estate: "부동산",
	investment: "기타 투자",
	other: "기타",
};

export function ManualAssetEditor({ asset, onDone }: { asset?: ManualAssetDto; onDone: () => void }) {
	const [name, setName] = useState(asset?.name ?? "");
	const [kind, setKind] = useState<ManualKind>(asset?.kind ?? "deposit");
	const [currency, setCurrency] = useState<"KRW" | "USD">(asset?.currency ?? "KRW");
	const [amount, setAmount] = useState(asset ? asset.amount.toLocaleString("en-US") : "");
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
		onSuccess: () => {
			toast(asset ? `${name.trim()} 금액을 고쳤습니다` : `${name.trim()}을(를) 추가했습니다`);
			refresh();
		},
	});
	const remove = useMutation({
		mutationFn: () => api.deleteManualAsset(asset!.id),
		onSuccess: () => {
			toast(`${asset?.name ?? ""}을(를) 지웠습니다`);
			refresh();
		},
	});

	const n = Number(amount.replace(/,/g, ""));
	const valid = name.trim().length > 0 && amount.trim() !== "" && Number.isFinite(n) && n >= 0;
	const error = (save.error ?? remove.error) as Error | null;

	return (
		<form
			className="inline-edit"
			onSubmit={(e) => {
				e.preventDefault();
				if (valid && !save.isPending) save.mutate();
			}}
		>
			<div className="line">
				<input className="input input-sm" placeholder="이름 (예: 주택청약, 퇴직연금)" aria-label="이름" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
				<select className="input input-sm" aria-label="종류" value={kind} onChange={(e) => setKind(e.target.value as ManualKind)}>
					{(Object.keys(MANUAL_KIND_LABEL) as ManualKind[]).map((k) => (
						<option key={k} value={k}>
							{MANUAL_KIND_LABEL[k]}
						</option>
					))}
				</select>
			</div>
			<div className="line">
				<input
					className="input input-sm num"
					inputMode="decimal"
					placeholder="금액"
					aria-label="금액"
					value={amount}
					onChange={(e) => {
						// 정수부에만 천 단위 쉼표 — 달러 소수점은 그대로
						const [i = "", d] = e.target.value.replace(/[^\d.]/g, "").split(".");
						const int = i ? Number(i).toLocaleString("en-US") : "";
						setAmount(d !== undefined ? `${int || "0"}.${d.slice(0, 2)}` : int);
					}}
				/>
				<select className="input input-sm" aria-label="통화" value={currency} onChange={(e) => setCurrency(e.target.value as "KRW" | "USD")}>
					<option value="KRW">원</option>
					<option value="USD">달러</option>
				</select>
			</div>
			<input className="input input-sm" placeholder="메모 (선택)" aria-label="메모" value={memo} onChange={(e) => setMemo(e.target.value)} />
			{error && <p className="field-err">{error.message}</p>}
			<div className="flex items-center gap-2">
				{asset && (
					<button
						type="button"
						className="btn btn-danger btn-sm"
						disabled={remove.isPending}
						onClick={() => {
							if (confirm(`'${asset.name}' 을(를) 지울까요?`)) remove.mutate();
						}}
					>
						삭제
					</button>
				)}
				<span className="flex-1" />
				<button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
					취소
				</button>
				<button type="submit" className="btn btn-primary btn-sm" disabled={!valid || save.isPending}>
					{save.isPending ? "저장 중…" : "저장"}
				</button>
			</div>
		</form>
	);
}
