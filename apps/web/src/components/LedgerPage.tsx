/**
 * 가계부 화면 — 에이전트를 거치지 않는 직접 경로 (PLAN.md §3.2).
 *
 * 챗은 "어제 김밥천국 8천원" 같은 입력에 강하고, 이 화면은 훑어보기·수정·예산 설정에 강하다.
 * 둘은 같은 D1을 본다.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api.ts";

const won = (n: number): string => `${Math.abs(n).toLocaleString("ko-KR")}원`;
const todayKST = (): string => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

function monthRange(month: string): { from: string; to: string } {
	const [y, m] = month.split("-").map(Number);
	const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
	return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export function LedgerPage() {
	const [month, setMonth] = useState(() => todayKST().slice(0, 7));
	// 가계부는 가구 공유 — 기본은 전체, 필요하면 본인 것만 본다
	const [scope, setScope] = useState<"household" | "mine">("household");
	const { from, to } = monthRange(month);
	const qc = useQueryClient();

	const me = useQuery({ queryKey: ["me"], queryFn: api.me });
	const summary = useQuery({
		queryKey: ["summary", from, to, scope],
		queryFn: () => api.summary(from, to, "category", scope),
	});
	const byMember = useQuery({
		queryKey: ["summary-member", from, to],
		queryFn: () => api.summary(from, to, "member"),
	});
	const transactions = useQuery({
		queryKey: ["transactions", from, to, scope],
		queryFn: () => api.transactions({ from, to, limit: 200, scope }),
	});
	const budgets = useQuery({
		queryKey: ["budgets", month],
		queryFn: () => api.budgets(month),
	});

	const invalidate = (): void => {
		void qc.invalidateQueries({ queryKey: ["summary"] });
		void qc.invalidateQueries({ queryKey: ["summary-member"] });
		void qc.invalidateQueries({ queryKey: ["transactions"] });
		void qc.invalidateQueries({ queryKey: ["budgets"] });
	};

	const addTx = useMutation({ mutationFn: api.addTransaction, onSuccess: invalidate });
	const delTx = useMutation({ mutationFn: api.deleteTransaction, onSuccess: invalidate });

	const totalExpense = (summary.data ?? []).reduce((s, r) => s + r.expense, 0);
	const totalIncome = (summary.data ?? []).reduce((s, r) => s + r.income, 0);

	return (
		<div className="flex-1 overflow-y-auto">
			<div className="mx-auto max-w-3xl space-y-6 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
				<div className="flex items-center justify-between">
					<input
						type="month"
						value={month}
						onChange={(e) => setMonth(e.target.value)}
						className="rounded-lg border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none focus:border-accent"
					/>
					<div className="text-right">
						<div className="text-xl font-semibold text-ink">{won(totalExpense)}</div>
						<div className="text-xs text-muted">
							수입 {won(totalIncome)} · 순 {totalIncome - totalExpense >= 0 ? "+" : "-"}
							{won(totalIncome - totalExpense)}
						</div>
					</div>
				</div>

				<div className="flex gap-1 rounded-lg bg-inset p-0.5 text-xs">
					{(["household", "mine"] as const).map((s) => (
						<button
							key={s}
							onClick={() => setScope(s)}
							className={`flex-1 rounded-md px-3 py-1.5 transition ${
								scope === s ? "bg-card text-ink shadow-sm" : "text-muted"
							}`}
						>
							{s === "household" ? "가구 전체" : `내 기록${me.data ? ` (${me.data.user})` : ""}`}
						</button>
					))}
				</div>

				{scope === "household" && (byMember.data ?? []).length > 1 && (
					<section>
						<h2 className="mb-2 text-sm font-medium text-muted">사람별</h2>
						<div className="flex gap-2">
							{byMember.data?.map((r) => (
								<div key={r.key} className="flex-1 rounded-xl border border-line bg-inset p-3">
									<div className="text-xs text-muted">{r.key}</div>
									<div className="mt-0.5 text-sm font-semibold text-ink">{won(r.expense)}</div>
									<div className="text-xs text-faint">{r.count}건</div>
								</div>
							))}
						</div>
					</section>
				)}

				<QuickAdd onAdd={(tx) => addTx.mutate(tx)} busy={addTx.isPending} />

				{(budgets.data ?? []).length > 0 && (
					<section>
						<h2 className="mb-2 text-sm font-medium text-muted">예산</h2>
						<div className="space-y-3 rounded-xl border border-line bg-inset p-4">
							{budgets.data?.map((b) => {
								const over = b.remaining < 0;
								return (
									<div key={b.category}>
										<div className="flex justify-between text-xs">
											<span className="text-ink">{b.category}</span>
											<span className={over ? "text-danger" : "text-muted"}>
												{won(b.spent)} / {won(b.limit_amt)} ({b.usedPct}%)
											</span>
										</div>
										<div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
											<div
												className={`h-full rounded-full ${over ? "bg-danger" : "bg-accent"}`}
												style={{ width: `${Math.min(b.usedPct, 100)}%` }}
											/>
										</div>
									</div>
								);
							})}
						</div>
					</section>
				)}

				<section>
					<h2 className="mb-2 text-sm font-medium text-muted">카테고리별</h2>
					<div className="rounded-xl border border-line bg-inset p-4">
						{summary.isLoading && <p className="text-sm text-muted">불러오는 중…</p>}
						{summary.data?.length === 0 && <p className="text-sm text-muted">기록이 없습니다.</p>}
						<div className="space-y-2">
							{summary.data?.map((r) => (
								<div key={r.key} className="flex justify-between text-sm">
									<span className="text-ink">{r.key}</span>
									<span className="text-muted">
										{won(r.expense)} · {r.count}건
									</span>
								</div>
							))}
						</div>
					</div>
				</section>

				<section>
					<h2 className="mb-2 text-sm font-medium text-muted">내역 {transactions.data?.length ?? 0}건</h2>
					<div className="overflow-hidden rounded-xl border border-line">
						{transactions.data?.map((t) => (
							<div
								key={t.id}
								className="group flex items-center justify-between border-b border-line px-4 py-2.5 last:border-0"
							>
								<div className="min-w-0">
									<div className="truncate text-sm text-ink">{t.merchant ?? t.category ?? "-"}</div>
									<div className="text-xs text-muted">
										{t.date}
										{t.category ? ` · ${t.category}` : ""}
										{t.member ? ` · ${t.member}` : ""}
										{t.source === "agent" ? " · 챗" : ""}
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-3">
									<span className={`text-sm ${t.amount < 0 ? "text-ink" : "text-success"}`}>
										{t.amount < 0 ? "-" : "+"}
										{won(t.amount)}
									</span>
									<button
										onClick={() => delTx.mutate(t.id)}
										className="text-xs text-faint opacity-0 transition group-hover:opacity-100"
										aria-label="삭제"
									>
										삭제
									</button>
								</div>
							</div>
						))}
						{transactions.data?.length === 0 && (
							<p className="px-4 py-6 text-center text-sm text-muted">내역이 없습니다.</p>
						)}
					</div>
				</section>
			</div>
		</div>
	);
}

function QuickAdd({
	onAdd,
	busy,
}: {
	onAdd: (tx: { date: string; amount: number; type: "expense" | "income"; category?: string; merchant?: string }) => void;
	busy: boolean;
}) {
	const [amount, setAmount] = useState("");
	const [merchant, setMerchant] = useState("");
	const [category, setCategory] = useState("");

	function submit(): void {
		const n = Number(amount.replace(/[^\d]/g, ""));
		if (!Number.isInteger(n) || n <= 0) return;
		onAdd({
			date: todayKST(),
			amount: n,
			type: "expense",
			category: category || undefined,
			merchant: merchant || undefined,
		});
		setAmount("");
		setMerchant("");
		setCategory("");
	}

	return (
		<div className="flex gap-2">
			<input
				inputMode="numeric"
				placeholder="금액"
				value={amount}
				onChange={(e) => setAmount(e.target.value)}
				className="w-28 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
			/>
			<input
				placeholder="가맹점"
				value={merchant}
				onChange={(e) => setMerchant(e.target.value)}
				className="min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
			/>
			<input
				placeholder="분류"
				value={category}
				onChange={(e) => setCategory(e.target.value)}
				className="w-24 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
			/>
			<button
				onClick={submit}
				disabled={busy || !amount}
				className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-40"
			>
				추가
			</button>
		</div>
	);
}
