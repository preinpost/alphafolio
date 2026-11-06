import type { JournalEntryDto } from "@alphafolio/protocol";
import type { ReactNode } from "react";
import { amountOf, BROKER_LABEL, money, pnlText, sideLabel, SOURCE_LABEL, tradeText } from "../../lib/journal.ts";

const WEEKDAY = "일월화수목금토";

export function StatusBadge({ e }: { e: JournalEntryDto }) {
	if (e.status === "pending") return <span className="badge warn">체결 확인 전</span>;
	if (e.status === "canceled") return <span className="badge">체결 없이 끝남</span>;
	return null;
}

export function EntryList({ list, total, onOpen }: { list: JournalEntryDto[]; total: number; onOpen: (e: JournalEntryDto) => void }) {
	if (list.length === 0) {
		return (
			<div className="empty">
				{total
					? "조건에 맞는 매매가 없습니다."
					: "이 기간 매매가 없습니다. 챗에서 주문하거나, 위쪽 ‘가져오기’로 계좌 체결을 불러오거나, ‘기록’으로 직접 남겨 보세요."}
			</div>
		);
	}
	const out: ReactNode[] = [];
	let last = "";
	for (const e of list) {
		if (e.date !== last) {
			last = e.date;
			const n = list.filter((x) => x.date === e.date).length;
			const wd = WEEKDAY[new Date(`${e.date}T00:00:00`).getDay()];
			out.push(
				<div key={`d${e.date}`} className="day-h">
					<span>
						{Number(e.date.slice(5, 7))}월 {Number(e.date.slice(8))}일 ({wd})
					</span>
					<span>{n}건</span>
				</div>,
			);
		}
		const amount = amountOf(e);
		const pnl = pnlText(e);
		out.push(
			<button key={e.id} className={`row row-btn tx jr-row ${e.status === "canceled" ? "jr-dim" : ""}`} role="listitem" onClick={() => onOpen(e)}>
				<span className={`side-tag ${e.side === "BUY" ? "buy" : "sell"}`}>{sideLabel(e)}</span>
				<span className="grow">
					<span className="name">
						{e.name ?? e.symbol}
						{e.name && <span className="mono muted jr-sym">{e.symbol}</span>}
					</span>
					<span className="meta">
						<span className="nw">{tradeText(e)} ·</span>{" "}
						<span className="nw">
							{BROKER_LABEL[e.broker]}
							{/* 계좌 체결이 대부분이라 목록에서는 나머지 출처만 표시한다 */}
							{e.source !== "import" && <span className="src">{SOURCE_LABEL[e.source]}</span>} <StatusBadge e={e} />
						</span>
					</span>
					<span className={`jr-thesis ${e.thesis ? "" : "muted"}`}>
						{e.thesis ?? "근거를 적어 두세요"}
						{e.tags.length > 0 && <span className="jr-tagline"> {e.tags.map((t) => `#${t}`).join(" ")}</span>}
					</span>
				</span>
				<span className="amt">
					{amount !== null && <b>{money(amount, e.currency)}</b>}
					{pnl && <small className={pnl.startsWith("+") ? "up" : "down"}>실현 {pnl}</small>}
					{e.emotion && <small className="muted">{e.emotion}</small>}
				</span>
			</button>,
		);
	}
	return <div role="list">{out}</div>;
}
