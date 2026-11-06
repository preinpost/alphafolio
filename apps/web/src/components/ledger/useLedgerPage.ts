import type { LedgerTransaction } from "@alphafolio/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { DEFAULT_CATS, monthRange, todayKST } from "./format.ts";

/** 가계부 화면 상태 — 가계부 고르기, 월·범위, 요약·내역·예산 조회와 내역 필터 */
export function useLedgerPage() {
	const thisMonth = todayKST().slice(0, 7);
	const [month, setMonth] = useState(thisMonth);
	// 공유 가계부 — 기본은 전체, 필요하면 본인 것만 본다
	const [scope, setScope] = useState<"household" | "mine">("household");
	const [picked, setPicked] = useState<string | undefined>(undefined);
	const [managing, setManaging] = useState(false);
	const [cat, setCat] = useState("전체");
	const [q, setQ] = useState("");
	/** 다이얼로그 — null 닫힘, "new" 추가, 거래 = 고치기 */
	const [dialog, setDialog] = useState<"new" | LedgerTransaction | null>(null);
	const { from, to } = monthRange(month);
	const qc = useQueryClient();

	const me = useQuery({ queryKey: ["me"], queryFn: api.me });
	const books = useQuery({ queryKey: ["ledgers"], queryFn: api.ledgers });
	const mine = books.data?.ledgers ?? [];
	// 고른 게 없거나(처음) 더는 멤버가 아니면(나감·삭제) 기본 가계부
	const current = mine.find((l) => l.id === picked) ?? mine.find((l) => l.isDefault) ?? mine[0];
	const ledgerId = current?.id;
	// 가계부가 아직 없으면 조회하지 않는다 — 첫 기록(여기 또는 챗)에서 서버가 개인 가계부를 만든다
	const ready = books.isSuccess && ledgerId !== undefined;

	const summary = useQuery({
		queryKey: ["summary", ledgerId, from, to, scope],
		queryFn: () => api.summary(ledgerId, from, to, "category", scope),
		enabled: ready,
	});
	const byMember = useQuery({
		queryKey: ["summary-member", ledgerId, from, to],
		queryFn: () => api.summary(ledgerId, from, to, "member"),
		enabled: ready,
	});
	const transactions = useQuery({
		queryKey: ["transactions", ledgerId, from, to, scope],
		queryFn: () => api.transactions(ledgerId, { from, to, limit: 200, scope }),
		enabled: ready,
	});
	const budgets = useQuery({
		queryKey: ["budgets", ledgerId, month],
		queryFn: () => api.budgets(ledgerId, month),
		enabled: ready,
	});

	const invalidate = (): void => {
		// 가계부가 없던 사용자는 첫 기록 때 개인 가계부가 생기므로 목록도 다시 읽는다
		if (!ledgerId) void qc.invalidateQueries({ queryKey: ["ledgers"] });
		for (const key of ["summary", "summary-member", "transactions", "budgets"]) void qc.invalidateQueries({ queryKey: [key] });
	};

	const cats = [...(summary.data ?? [])].filter((r) => r.expense > 0).sort((a, b) => b.expense - a.expense);
	const spent = cats.reduce((s, r) => s + r.expense, 0);
	const income = (summary.data ?? []).reduce((s, r) => s + r.income, 0);
	const budgetRows = budgets.data ?? [];
	const budgetLeft = budgetRows.reduce((s, b) => s + b.remaining, 0);
	const budgetLimit = budgetRows.reduce((s, b) => s + b.limit_amt, 0);
	const budgetUsed = budgetRows.reduce((s, b) => s + b.spent, 0);

	const list = transactions.data ?? [];
	const chipCats = ["전체", ...new Set(list.map((t) => t.category ?? "분류 없음"))];
	useEffect(() => {
		if (!chipCats.includes(cat)) setCat("전체");
	}, [chipCats.join("|")]);
	const needle = q.trim();
	const shown = list.filter(
		(t) =>
			(cat === "전체" || (t.category ?? "분류 없음") === cat) &&
			(!needle || (t.merchant ?? "").includes(needle) || (t.memo ?? "").includes(needle) || (t.category ?? "").includes(needle)),
	);

	const [y, m] = month.split("-").map(Number);
	const isThisMonth = month === thisMonth;
	const sumLabel = `${m}월 지출${isThisMonth ? ` · ${Number(todayKST().slice(8))}일까지` : ""}${scope === "mine" ? " · 내 기록" : ""}`;
	const knownCats = [...new Set([...DEFAULT_CATS, ...cats.map((c) => c.key)])];

	return {
		thisMonth,
		month,
		setMonth,
		scope,
		setScope,
		setPicked,
		managing,
		setManaging,
		cat,
		setCat,
		q,
		setQ,
		dialog,
		setDialog,
		me,
		books,
		mine,
		current,
		ledgerId,
		summary,
		byMember,
		invalidate,
		cats,
		spent,
		income,
		budgetRows,
		budgetLeft,
		budgetLimit,
		budgetUsed,
		list,
		chipCats,
		shown,
		y,
		m,
		sumLabel,
		knownCats,
	};
}
