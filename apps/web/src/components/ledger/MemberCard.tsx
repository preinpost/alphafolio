import type { LedgerSummaryRow } from "@alphafolio/protocol";
import { won } from "./format.ts";

/** 사람별 지출 — 가계부 전체 기준 */
export function MemberCard({ rows, me }: { rows: LedgerSummaryRow[]; me: string | undefined }) {
	return (
		<section className="card fade-up">
			<div className="card-h">
				<h2>사람별</h2>
				<span className="spacer" />
				<span className="eyebrow font-medium">가계부 전체 기준</span>
			</div>
			<div className="rows border-t border-line">
				{rows.map((r) => {
					const all = rows.reduce((s, x) => s + x.expense, 0) || 1;
					return (
						<div key={r.key} className="row member">
							<span className="avatar">{r.key.slice(0, 2).toUpperCase()}</span>
							<span className="grow">
								<span className="name">
									{r.key}
									{r.key === me && <span className="font-medium text-muted"> · 나</span>}
								</span>
								<div className="meter">
									<i style={{ width: `${(r.expense / all) * 100}%` }} />
								</div>
							</span>
							<span className="amt">
								<b>{won(r.expense)}</b>
								<small className="muted">
									{r.count}건 · {Math.round((r.expense / all) * 100)}%
								</small>
							</span>
						</div>
					);
				})}
			</div>
		</section>
	);
}
