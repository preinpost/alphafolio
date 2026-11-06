import type { LedgerTransaction } from "@alphafolio/protocol";
import { catColor, WEEKDAY, won } from "./format.ts";

export function TxList({ list, total, onOpen }: { list: LedgerTransaction[]; total: number; onOpen: (t: LedgerTransaction) => void }) {
	if (list.length === 0) {
		return <div className="empty">{total ? "조건에 맞는 내역이 없습니다." : "기록이 없습니다. 위쪽 ‘기록 추가’나 챗으로 첫 기록을 남겨 보세요."}</div>;
	}
	const out: React.ReactNode[] = [];
	let last = "";
	for (const t of list) {
		if (t.date !== last) {
			last = t.date;
			const day = list.filter((x) => x.date === t.date && x.amount < 0).reduce((s, x) => s - x.amount, 0);
			const wd = WEEKDAY[new Date(`${t.date}T00:00:00`).getDay()];
			out.push(
				<div key={`d${t.date}`} className="day-h">
					<span>
						{Number(t.date.slice(5, 7))}월 {Number(t.date.slice(8))}일 ({wd})
					</span>
					<span>{day ? `지출 ${won(day)}` : ""}</span>
				</div>,
			);
		}
		const inc = t.amount > 0;
		out.push(
			<button key={t.id} className="row row-btn tx" role="listitem" onClick={() => onOpen(t)}>
				<span className="sw" style={{ background: inc ? "var(--ok)" : catColor(t.category) }} />
				<span className="grow">
					<span className="name">{t.merchant ?? t.category ?? "-"}</span>
					<span className="meta">
						{[inc ? "수입" : (t.category ?? "분류 없음"), t.member, t.memo].filter(Boolean).join(" · ")}
						{t.source === "agent" && <span className="src">챗</span>}
					</span>
				</span>
				<span className="amt">
					<b className={inc ? "ok-text" : ""}>
						{inc ? "+" : ""}
						{won(t.amount)}
					</b>
				</span>
			</button>,
		);
	}
	return <div role="list">{out}</div>;
}
