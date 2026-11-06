import type { PortfolioSourceDto } from "@alphafolio/protocol";
import { compactWon } from "../../lib/portfolio.ts";
import { pctOf, usdCash, usdt, won } from "./format.ts";

/** 계좌 — 누르면 보유 자산이 그 계좌로 좁혀진다 */
export function AccountsCard({ sources, total, only, setOnly }: { sources: PortfolioSourceDto[]; total: number; only: string | null; setOnly: (f: (cur: string | null) => string | null) => void }) {
	return (
		<section className="card fade-up o-3">
			<div className="card-h">
				<h2>계좌</h2>
				<span className="spacer" />
				<span className="eyebrow font-medium">누르면 해당 계좌만</span>
			</div>
			<div className="rows border-t border-line">
				{sources.map((s) => (
					<SourceRow key={s.id} s={s} total={total} active={only === s.id} onClick={() => setOnly((cur) => (cur === s.id ? null : s.id))} />
				))}
			</div>
		</section>
	);
}

const STATUS: Record<PortfolioSourceDto["status"], { text: string; tone: string } | null> = {
	ok: null,
	partial: { text: "일부 누락", tone: "warn" },
	failed: { text: "조회 실패", tone: "bad" },
	skipped: { text: "제외", tone: "" },
};

function SourceRow({ s, total, active, onClick }: { s: PortfolioSourceDto; total: number; active: boolean; onClick: () => void }) {
	const status = STATUS[s.status];
	// 화폐별 원래 통화 — 계좌 합계(원화 환산)만으로는 달러·코인이 얼마인지 모른다
	const parts = [s.byCurrency.krw !== 0 && won(s.byCurrency.krw), s.byCurrency.usd !== 0 && usdCash(s.byCurrency.usd), s.byCurrency.usdt !== 0 && usdt(s.byCurrency.usdt)].filter(
		Boolean,
	);
	const usable = s.status === "ok" || s.status === "partial";
	const detail = usable ? [...parts, ...s.warnings].join(" · ") || "잔고 없음" : (s.error ?? "");
	return (
		<button className="row row-btn" aria-pressed={active} disabled={!usable} onClick={onClick}>
			<span className="grow">
				<span className="name flex items-center gap-2">
					{s.label}
					{status && <span className={`badge ${status.tone}`}>{status.text}</span>}
				</span>
				<span className={`meta ${usable ? "" : "danger-text"}`} title={detail}>
					{detail}
				</span>
			</span>
			{usable && (
				<span className="amt">
					<b>{compactWon(s.valueKrw)}</b>
					<small className="muted">{pctOf(s.valueKrw, total)}</small>
				</span>
			)}
		</button>
	);
}
