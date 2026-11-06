import type { LedgerBudgetRow } from "@alphafolio/protocol";
import { catColor, compact, won } from "./format.ts";

/** 이 달 예산 — 분류별 사용률 */
export function BudgetCard({ budgetRows, budgetUsed, budgetLimit }: { budgetRows: LedgerBudgetRow[]; budgetUsed: number; budgetLimit: number }) {
	return (
	<section className="card fade-up">
		<div className="card-h">
			<h2>예산</h2>
			<span className="spacer" />
			{budgetRows.length > 0 && (
				<span className="eyebrow num font-medium">
					{compact(budgetUsed)} / {compact(budgetLimit)}
				</span>
			)}
		</div>
		{budgetRows.length === 0 ? (
			<p className="card-b text-[13px] text-muted">
				이 달 예산이 없습니다. 챗에서 <span className="mono text-ink">식비 예산 30만원</span>처럼 말하면 정해집니다.
			</p>
		) : (
			<div className="border-t border-line">
				{budgetRows.map((b) => {
					const over = b.remaining < 0;
					return (
						<div key={b.category} className="budget">
							<div className="top">
								<span className="sw" style={{ background: catColor(b.category) }} />
								<b>{b.category}</b>
								{over && <span className="badge warn">{won(b.remaining)} 초과</span>}
								<span className="r">
									{won(b.spent)} / {compact(b.limit_amt)}
								</span>
							</div>
							<div
								className={`meter ${over ? "over" : ""}`}
								role="meter"
								aria-valuenow={b.usedPct}
								aria-valuemin={0}
								aria-valuemax={100}
								aria-label={`${b.category} 예산 사용률`}
							>
								<i style={{ width: `${Math.min(b.usedPct, 100)}%` }} />
							</div>
						</div>
					);
				})}
			</div>
		)}
	</section>
	);
}
