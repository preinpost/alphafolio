import type { LedgerTransaction } from "@alphafolio/protocol";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../lib/api.ts";
import { toast } from "../../lib/toast.ts";
import { todayKST } from "./format.ts";

/** 기록 다이얼로그 상태 — 열 때 값 채우기 · 저장 · 삭제(되돌리기 포함) */
export function useTxDialog({
	open,
	ledgerId,
	me,
	onClose,
	onSaved,
}: {
	open: "new" | LedgerTransaction | null;
	ledgerId: string | undefined;
	me: string | null;
	onClose: () => void;
	onSaved: (date: string) => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const amountRef = useRef<HTMLInputElement>(null);
	const merchantRef = useRef<HTMLInputElement>(null);
	const editing = open && open !== "new" ? open : null;
	const [type, setType] = useState<"expense" | "income">("expense");
	const [amount, setAmount] = useState("");
	const [merchant, setMerchant] = useState("");
	const [category, setCategory] = useState("");
	const [date, setDate] = useState(todayKST());
	const [memo, setMemo] = useState("");
	const [errors, setErrors] = useState<{ amount?: string; merchant?: string }>({});

	// 열 때마다 값 채우기
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (!open) {
			if (d.open) d.close();
			return;
		}
		setType(editing && editing.amount > 0 ? "income" : "expense");
		setAmount(editing ? Math.abs(editing.amount).toLocaleString("ko-KR") : "");
		setMerchant(editing?.merchant ?? "");
		setCategory(editing?.category ?? "");
		setDate(editing?.date ?? todayKST());
		setMemo(editing?.memo ?? "");
		setErrors({});
		if (!d.open) d.showModal();
		requestAnimationFrame(() => (editing ? merchantRef : amountRef).current?.focus());
	}, [open]);

	const save = useMutation({
		mutationFn: async () => {
			const n = Number(amount.replace(/[^\d]/g, ""));
			const body = { date, amount: n, type, category: category.trim(), merchant: merchant.trim(), memo: memo.trim() };
			if (editing) return api.updateTransaction(editing.id, body);
			return api.addTransaction(ledgerId, {
				date,
				amount: n,
				type,
				...(body.category ? { category: body.category } : {}),
				...(body.merchant ? { merchant: body.merchant } : {}),
				...(body.memo ? { memo: body.memo } : {}),
			});
		},
		onSuccess: () => {
			toast(editing ? "기록을 고쳤습니다" : `${merchant.trim() || category.trim()} ${Number(amount.replace(/[^\d]/g, "")).toLocaleString("ko-KR")}원 기록했습니다`);
			onSaved(date);
			onClose();
		},
	});
	const remove = useMutation({
		mutationFn: (t: LedgerTransaction) => api.deleteTransaction(t.id),
		onSuccess: (_r, t) => {
			onSaved(t.date);
			onClose();
			// 되돌리기는 새 기록으로 다시 넣는다 — 기록한 사람이 바뀌지 않게 내 기록만
			const mineTx = !t.member || t.member === me;
			toast(`${t.merchant ?? t.category ?? "기록"}을(를) 지웠습니다`, {
				...(mineTx
					? {
							action: {
								label: "되돌리기",
								run: () =>
									void api
										.addTransaction(ledgerId, {
											date: t.date,
											amount: Math.abs(t.amount),
											type: t.amount > 0 ? "income" : "expense",
											...(t.category ? { category: t.category } : {}),
											...(t.merchant ? { merchant: t.merchant } : {}),
											...(t.memo ? { memo: t.memo } : {}),
										})
										.then(() => onSaved(t.date)),
							},
						}
					: {}),
			});
		},
	});

	function submit(e: FormEvent): void {
		e.preventDefault();
		const n = Number(amount.replace(/[^\d]/g, ""));
		const next = {
			...(n > 0 ? {} : { amount: "금액을 입력하세요." }),
			...(merchant.trim() || category.trim() ? {} : { merchant: "어디에 썼는지 적어 주세요." }),
		};
		setErrors(next);
		if (next.amount) return amountRef.current?.focus();
		if (next.merchant) return merchantRef.current?.focus();
		save.mutate();
	}

	const error = (save.error ?? remove.error) as Error | null;

	return {
		ref,
		amountRef,
		merchantRef,
		editing,
		type,
		setType,
		amount,
		setAmount,
		merchant,
		setMerchant,
		category,
		setCategory,
		date,
		setDate,
		memo,
		setMemo,
		errors,
		save,
		remove,
		submit,
		error,
	};
}
