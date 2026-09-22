/**
 * 툴 결과 details → 카드 렌더러.
 *
 * 툴은 content(LLM이 읽는 텍스트)에 집계만 넣고 원시 내역은 details로 보낸다.
 * 여기서 그 details를 사람이 보는 형태로 그린다 (PLAN.md §7.4).
 */
import type { UICard } from "@alphafolio/protocol";

const won = (n: number): string => `${Math.abs(n).toLocaleString("ko-KR")}원`;

export function LedgerCardView({ card }: { card: UICard }) {
	switch (card.kind) {
		case "ledger-tx": {
			const { tx } = card;
			const expense = tx.amount < 0;
			return (
				<div className="mt-2 flex items-center justify-between rounded-xl border border-line bg-inset px-4 py-3">
					<div className="min-w-0">
						<div className="truncate text-sm font-medium text-ink">
							{tx.merchant ?? tx.category ?? "거래"}
						</div>
						<div className="text-xs text-muted">
							{tx.date}
							{tx.category ? ` · ${tx.category}` : ""}
							{tx.account ? ` · ${tx.account}` : ""}
						</div>
					</div>
					<div className={`shrink-0 text-sm font-semibold ${expense ? "text-ink" : "text-success"}`}>
						{expense ? "-" : "+"}
						{won(tx.amount)}
					</div>
				</div>
			);
		}

		case "ledger-summary": {
			const total = card.rows.reduce((s, r) => s + r.expense, 0);
			const max = Math.max(...card.rows.map((r) => r.expense), 1);
			return (
				<div className="mt-2 rounded-xl border border-line bg-inset p-4">
					<div className="mb-3 flex items-baseline justify-between">
						<span className="text-xs text-muted">
							{card.from} ~ {card.to}
						</span>
						<span className="text-sm font-semibold text-ink">지출 {won(total)}</span>
					</div>
					<div className="space-y-2">
						{card.rows.slice(0, 8).map((r) => (
							<div key={r.key}>
								<div className="flex justify-between text-xs">
									<span className="text-ink">{r.key}</span>
									<span className="text-muted">
										{won(r.expense)} · {r.count}건
									</span>
								</div>
								<div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
									<div className="h-full rounded-full bg-accent" style={{ width: `${(r.expense / max) * 100}%` }} />
								</div>
							</div>
						))}
					</div>
				</div>
			);
		}

		case "ledger-table":
			return (
				<div className="mt-2 overflow-hidden rounded-xl border border-line bg-inset">
					{card.rows.slice(0, 20).map((r) => (
						<div key={r.id} className="flex items-center justify-between border-b border-line px-4 py-2 last:border-0">
							<div className="min-w-0">
								<div className="truncate text-sm text-ink">{r.merchant ?? r.category ?? "-"}</div>
								<div className="text-xs text-muted">
									{r.date}
									{r.category ? ` · ${r.category}` : ""}
								</div>
							</div>
							<div className={`shrink-0 text-sm ${r.amount < 0 ? "text-ink" : "text-success"}`}>
								{r.amount < 0 ? "-" : "+"}
								{won(r.amount)}
							</div>
						</div>
					))}
				</div>
			);

		case "ledger-budget":
			return (
				<div className="mt-2 space-y-3 rounded-xl border border-line bg-inset p-4">
					<div className="text-xs text-muted">{card.month} 예산</div>
					{card.rows.map((r) => {
						const over = r.remaining < 0;
						return (
							<div key={r.category}>
								<div className="flex justify-between text-xs">
									<span className="text-ink">{r.category}</span>
									<span className={over ? "text-danger" : "text-muted"}>
										{won(r.spent)} / {won(r.limit_amt)} ({r.usedPct}%)
									</span>
								</div>
								<div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
									<div
										className={`h-full rounded-full ${over ? "bg-danger" : "bg-accent"}`}
										style={{ width: `${Math.min(r.usedPct, 100)}%` }}
									/>
								</div>
							</div>
						);
					})}
				</div>
			);

		default:
			// chart-card 등 — Phase 3에서 브로커 툴과 함께 붙인다
			return null;
	}
}
