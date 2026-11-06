import { PERIODS, type Chip, type PeriodId, type summarize } from "../../lib/journal.ts";

const pct = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 100) : 0);

/** 오른쪽 열 — 기간 안 매매 수 · 기록 습관 · 태그 · 감정 */
export function JournalSummary({
	period,
	s,
	tag,
	setTag,
	setChip,
}: {
	period: PeriodId;
	s: ReturnType<typeof summarize>;
	tag: string | null;
	setTag: (f: (cur: string | null) => string | null) => void;
	setChip: (c: Chip) => void;
}) {
	return (
		<>
		<section className="card fade-up" aria-labelledby="jr-sum">
			<div className="sum-top">
				<div className="grow">
					<div className="eyebrow" id="jr-sum">
						{PERIODS.find((p) => p.id === period)?.label} 매매
					</div>
					<div className="big-num">
						{s.total}
						<span className="unit">건</span>
					</div>
				</div>
				<div className="sum-side">
					<div>
						매수<b>{s.buys}</b>
					</div>
					<div>
						매도<b>{s.sells}</b>
					</div>
					{s.pending > 0 && (
						<div>
							확인 전<b>{s.pending}</b>
						</div>
					)}
				</div>
			</div>
			{s.total > 0 && (
				<div className="border-t border-line">
					<Habit label="근거를 적은 매매" part={s.withThesis} total={s.total} onClick={() => setChip("missing")} hint="근거 없는 것만 보기" />
					<Habit label="손절가를 정한 매수" part={s.buysWithStop} total={s.buys} />
					<Habit label="회고를 쓴 매매" part={s.withReview} total={s.total} />
				</div>
			)}
		</section>

		{s.tags.length > 0 && (
			<section className="card fade-up">
				<div className="card-h">
					<h2>태그</h2>
					<span className="spacer" />
					<span className="eyebrow font-medium">누르면 그 태그만</span>
				</div>
				<div className="card-b jr-tags">
					{s.tags.map((t) => (
						<button key={t.tag} className="chip" aria-pressed={tag === t.tag} onClick={() => setTag((cur) => (cur === t.tag ? null : t.tag))}>
							#{t.tag} <span className="muted">{t.count}</span>
						</button>
					))}
				</div>
			</section>
		)}

		{s.emotions.length > 0 && (
			<section className="card fade-up">
				<div className="card-h">
					<h2>감정</h2>
				</div>
				<div className="cat-rows">
					{s.emotions.map((e) => (
						<div key={e.emotion} className="cat-row">
							<span />
							<span>{e.emotion}</span>
							<span className="cnt">{pct(e.count, s.total)}%</span>
							<span className="amt">{e.count}건</span>
						</div>
					))}
				</div>
			</section>
		)}
		</>
	);
}

/** 기록 습관 한 줄 — 비율 막대 */
function Habit({ label, part, total, onClick, hint }: { label: string; part: number; total: number; onClick?: () => void; hint?: string }) {
	if (total === 0) return null;
	const body = (
		<>
			<div className="top">
				<b>{label}</b>
				<span className="r">
					{part}/{total} · {pct(part, total)}%
				</span>
			</div>
			<div className="meter" role="meter" aria-valuenow={pct(part, total)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
				<i style={{ width: `${pct(part, total)}%` }} />
			</div>
		</>
	);
	return onClick ? (
		<button className="budget row-btn" onClick={onClick} title={hint}>
			{body}
		</button>
	) : (
		<div className="budget">{body}</div>
	);
}
