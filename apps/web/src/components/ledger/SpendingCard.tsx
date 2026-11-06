import type { LedgerSummaryRow } from "@alphafolio/protocol";
import { catColor, won } from "./format.ts";

/** 이달 지출 — 화면의 큰 숫자 하나. 수입·예산 남음과 분류별 비중 */
export function SpendingCard({
	sumLabel,
	spent,
	income,
	hasBudget,
	budgetLeft,
	cats,
	loading,
	loaded,
	onPickCat,
}: {
	sumLabel: string;
	spent: number;
	income: number;
	hasBudget: boolean;
	budgetLeft: number;
	cats: LedgerSummaryRow[];
	loading: boolean;
	loaded: boolean;
	onPickCat: (cat: string) => void;
}) {
	return (
	<section className="card fade-up" aria-labelledby="spent-label">
		<div className="sum-top">
			<div className="grow">
				<div className="eyebrow" id="spent-label">
					{sumLabel}
				</div>
				<div className="big-num">
					{Math.round(spent).toLocaleString("ko-KR")}
					<span className="unit">원</span>
				</div>
			</div>
			<div className="sum-side">
				<div>
					수입<b>{won(income)}</b>
				</div>
				{hasBudget && (
					<div>
						예산 남음<b className={budgetLeft < 0 ? "danger-text" : ""}>{budgetLeft >= 0 ? won(budgetLeft) : `${won(budgetLeft)} 초과`}</b>
					</div>
				)}
			</div>
		</div>
		{cats.length > 0 && (
			<div className="sum-bar">
				<div className="bar" role="img" aria-label="카테고리별 지출 비중">
					{cats.map((c) => (
						<i key={c.key} style={{ width: `${(c.expense / spent) * 100}%`, background: catColor(c.key) }} title={`${c.key} ${((c.expense / spent) * 100).toFixed(1)}%`} />
					))}
				</div>
			</div>
		)}
		<div className="cat-rows">
			{loading && <div className="empty">불러오는 중…</div>}
			{loaded && cats.length === 0 && <div className="empty">이 달에는 지출 기록이 없습니다.</div>}
			{cats.map((c) => (
				<button key={c.key} className="cat-row row-btn" onClick={() => onPickCat(c.key)} title="이 분류만 보기">
					<span className="sw" style={{ background: catColor(c.key) }} />
					<span>
						{c.key} <span className="cnt">{c.count}건</span>
					</span>
					<span className="cnt">{((c.expense / spent) * 100).toFixed(1)}%</span>
					<span className="amt">{won(c.expense)}</span>
				</button>
			))}
		</div>
	</section>
	);
}
