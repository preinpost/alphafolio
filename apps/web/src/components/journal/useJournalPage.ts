import type { JournalEntryDto } from "@alphafolio/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { filterEntries, kstToday, periodFrom, summarize, type Chip, type PeriodId } from "../../lib/journal.ts";
import { toast } from "../../lib/toast.ts";

/** 매매일지 화면 상태 — 기간·필터, 목록 조회, 계좌 체결 가져오기 (열 때 한 번 저절로) */
export function useJournalPage() {
	const today = kstToday();
	const [period, setPeriod] = useState<PeriodId>("30d");
	const [chip, setChip] = useState<Chip>("all");
	const [tag, setTag] = useState<string | null>(null);
	const [q, setQ] = useState("");
	/** 다이얼로그 — null 닫힘, "new" 직접 기록, 기록 = 보기·고치기 */
	const [dialog, setDialog] = useState<"new" | JournalEntryDto | null>(null);
	const qc = useQueryClient();

	const from = periodFrom(period, today);
	const list = useQuery({ queryKey: ["journal", from ?? "all"], queryFn: () => api.journal({ ...(from ? { from } : {}) }), retry: false });

	const sync = useMutation({
		mutationFn: (force: boolean) => api.syncJournal(force),
		onSuccess: (r, force) => {
			if (r.skipped) return;
			if (r.added > 0 || r.updated > 0) void qc.invalidateQueries({ queryKey: ["journal"] });
			const failed = r.sources.filter((s) => s.error);
			// 화면을 열 때 저절로 가져온 것은 바뀐 게 있을 때만 알린다 (늘 실패하는 계좌가 열 때마다 뜨지 않게)
			if (!force && r.added === 0 && r.updated === 0) return;
			if (r.sources.length === 0) {
				if (force) toast("연결된 계좌가 없습니다", { sub: "설정 → 연결에서 토스·한국투자·Binance 키를 넣으면 체결을 가져옵니다" });
				return;
			}
			const sub = [...failed.map((s) => `${s.label} 실패: ${s.error}`), ...r.warnings].join(" · ");
			toast(r.added || r.updated ? `새 기록 ${r.added}건 · 체결 반영 ${r.updated}건` : "새로 가져올 체결이 없습니다", sub ? { sub } : {});
		},
		onError: (e: Error, force) => {
			if (force) toast(`가져오지 못했습니다: ${e.message}`);
		},
	});

	// 화면을 열 때 한 번 — 서버가 10분에 한 번만 증권사를 부른다
	const synced = useRef(false);
	useEffect(() => {
		if (synced.current) return;
		synced.current = true;
		sync.mutate(false);
	}, []);

	const all = list.data?.items ?? [];
	const shown = filterEntries(all, { chip, tag, q });
	const s = summarize(all);

	return { period, setPeriod, chip, setChip, tag, setTag, q, setQ, dialog, setDialog, qc, list, sync, all, shown, s };
}
