import type { JournalEntryDto } from "@alphafolio/protocol";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type JournalManualInput } from "../../lib/api.ts";
import { kstToday, parseNumber, parseTags } from "../../lib/journal.ts";
import { toast } from "../../lib/toast.ts";

export interface Form {
	side: "BUY" | "SELL";
	symbol: string;
	name: string;
	date: string;
	quantity: string;
	price: string;
	currency: string;
	fee: string;
	broker: JournalEntryDto["broker"];
	thesis: string;
	targetPrice: string;
	stopPrice: string;
	tags: string;
	emotion: string | null;
	review: string;
}

const numText = (v: number | null): string => (v === null ? "" : String(v));

function formOf(e: JournalEntryDto | null, today: string): Form {
	return {
		side: e?.side ?? "BUY",
		symbol: e?.symbol ?? "",
		name: e?.name ?? "",
		date: e?.date ?? today,
		quantity: e ? numText(e.quantity) : "",
		price: e ? numText(e.price) : "",
		currency: e?.currency ?? "",
		fee: e ? numText(e.fee) : "",
		broker: e?.broker ?? "other",
		thesis: e?.thesis ?? "",
		targetPrice: e ? numText(e.targetPrice) : "",
		stopPrice: e ? numText(e.stopPrice) : "",
		tags: e?.tags.join(", ") ?? "",
		emotion: e?.emotion ?? null,
		review: e?.review ?? "",
	};
}

/** 기록 다이얼로그 상태 — 열 때 폼 채우기 · 저장 · 삭제 */
export function useEntryDialog({ open, onClose, onSaved }: { open: "new" | JournalEntryDto | null; onClose: () => void; onSaved: () => void }) {
	const ref = useRef<HTMLDialogElement>(null);
	const editing = open && open !== "new" ? open : null;
	/** 매매 칸을 고칠 수 있나 — 새 기록·직접 기록만 */
	const tradeEditable = !editing || editing.source === "manual";
	const [f, setF] = useState<Form>(() => formOf(null, kstToday()));
	const [error, setError] = useState<string | null>(null);
	const set = <K extends keyof Form>(k: K, v: Form[K]): void => setF((cur) => ({ ...cur, [k]: v }));

	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (!open) {
			if (d.open) d.close();
			return;
		}
		setF(formOf(editing, kstToday()));
		setError(null);
		if (!d.open) d.showModal();
	}, [open]);

	const save = useMutation({
		mutationFn: (body: Partial<JournalManualInput>) => (editing ? api.updateJournal(editing.id, body) : api.addJournal(body as JournalManualInput)),
		onSuccess: (e) => {
			toast(editing ? "일지를 고쳤습니다" : `${e.name ?? e.symbol} ${e.side === "BUY" ? "매수" : "매도"}를 기록했습니다`);
			onSaved();
			onClose();
		},
		onError: (e: Error) => setError(e.message),
	});
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteJournal(id),
		onSuccess: () => {
			toast("일지에서 지웠습니다");
			onSaved();
			onClose();
		},
		onError: (e: Error) => setError(e.message),
	});

	function submit(ev: FormEvent): void {
		ev.preventDefault();
		const notes = {
			thesis: f.thesis.trim() || null,
			targetPrice: parseNumber(f.targetPrice),
			stopPrice: parseNumber(f.stopPrice),
			tags: parseTags(f.tags),
			emotion: f.emotion,
			review: f.review.trim() || null,
		};
		if (!tradeEditable) return save.mutate(notes);
		const quantity = parseNumber(f.quantity);
		if (!f.symbol.trim()) return setError("종목코드나 티커를 입력하세요.");
		if (quantity === null || quantity <= 0) return setError("수량을 입력하세요.");
		save.mutate({
			...notes,
			// 날짜를 그대로 두면 보내지 않는다 — 다시 보내면 시각이 그날 정오로 바뀐다
			...(editing && editing.date === f.date ? {} : { date: f.date }),
			symbol: f.symbol.trim(),
			name: f.name.trim() || null,
			side: f.side,
			quantity,
			price: parseNumber(f.price),
			currency: f.currency.trim() || null,
			fee: parseNumber(f.fee),
			broker: f.broker,
		});
	}

	const busy = save.isPending || remove.isPending;

	return { ref, editing, tradeEditable, f, set, error, save, remove, submit, busy };
}
