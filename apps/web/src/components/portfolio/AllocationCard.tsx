import type { PortfolioDto } from "@alphafolio/protocol";
import { compactWon } from "../../lib/portfolio.ts";
import { pctOf, won } from "./format.ts";

/** 배분 막대 — 순서가 곧 범례 순서. 색은 데이터 팔레트 토큰 */
const SLICES: Array<{ key: keyof PortfolioDto["allocation"]; label: string; color: string }> = [
	{ key: "domesticStock", label: "국내주식", color: "var(--d1)" },
	{ key: "overseasStock", label: "해외주식", color: "var(--d2)" },
	{ key: "crypto", label: "코인", color: "var(--d3)" },
	{ key: "cash", label: "현금성", color: "var(--d4)" },
	{ key: "other", label: "기타", color: "var(--d5)" },
];

export function AllocationCard({ allocation, total }: { allocation: PortfolioDto["allocation"]; total: number }) {
	const slices = SLICES.filter((s) => allocation[s.key] > 0);
	if (total <= 0 || slices.length === 0) return null;
	return (
		<section className="card fade-up o-2">
			<div className="card-h">
				<h2>자산 배분</h2>
			</div>
			<div className="card-b">
				<div className="bar" role="img" aria-label={slices.map((s) => `${s.label} ${pctOf(allocation[s.key], total)}`).join(", ")}>
					{slices.map((s) => (
						<i key={s.key} style={{ width: `${(allocation[s.key] / total) * 100}%`, background: s.color }} title={`${s.label} ${pctOf(allocation[s.key], total)}`} />
					))}
				</div>
				<div className="mt-3">
					{slices.map((s) => (
						<div key={s.key} className="alloc-row">
							<span className="sw" style={{ background: s.color }} />
							<span>{s.label}</span>
							<span className="pct">{pctOf(allocation[s.key], total)}</span>
							<span className="amt" title={won(allocation[s.key])}>
								{compactWon(allocation[s.key])}
							</span>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}
