import type { PortfolioDto } from "@alphafolio/protocol";
import type { Change, HistoryPoint } from "../../lib/portfolio.ts";
import { NetWorthChart, RANGES, type RangeId } from "../NetWorthChart.tsx";
import { move, sign, signedPct, won } from "./format.ts";

/** 총자산 — 화면의 큰 숫자 하나. 전일·이번 달 변화와 추이 차트 */
export function NetWorthCard({
	p,
	daily,
	monthly,
	historyReady,
	range,
	setRange,
	points,
}: {
	p: PortfolioDto;
	daily: Change | null;
	monthly: Change | null;
	/** 추이를 읽었나 — D1 이 없으면 실패하는데, 그러면 차트만 숨긴다 */
	historyReady: boolean;
	range: RangeId;
	setRange: (r: RangeId) => void;
	points: HistoryPoint[];
}) {
	return (
		<section className="card fade-up o-1" aria-labelledby="nw-label">
			<div className="hero-top">
				<div className="grow">
					<div className="eyebrow" id="nw-label">
						총자산 (원화 환산)
					</div>
					<div className="big-num">
						{Math.round(p.netWorthKrw).toLocaleString("ko-KR")}
						<span className="unit">원</span>
					</div>
					<div className="hero-delta">
						{daily && <Delta label="전일 대비" c={daily} />}
						{monthly && <Delta label="이번 달" c={monthly} />}
						<span>
							<span className="muted">주식 평가손익</span>{" "}
							<b className={move(p.profitKrw)}>
								{sign(p.profitKrw)}
								{won(Math.abs(p.profitKrw))}
							</b>
						</span>
					</div>
				</div>
				{historyReady && (
					<div className="seg" role="group" aria-label="차트 기간">
						{RANGES.map((r) => (
							<button key={r.id} aria-pressed={range === r.id} onClick={() => setRange(r.id)}>
								{r.label}
							</button>
						))}
					</div>
				)}
			</div>
			{historyReady ? <NetWorthChart points={points} long={range === "1y"} /> : <div className="h-4" />}
		</section>
	);
}

function Delta({ label, c }: { label: string; c: Change }) {
	return (
		<span title={`${c.baseDate} 스냅샷 ${won(c.base)} 기준 (입출금 포함)`}>
			<span className="muted">{label}</span>{" "}
			<b className={move(c.diff)}>
				{sign(c.diff)}
				{won(Math.abs(c.diff))} ({signedPct(c.pct)})
			</b>
		</span>
	);
}
