import type { PortfolioDto } from "@alphafolio/protocol";
import { approxWon, pctOf, usdCash, usdt, won } from "./format.ts";

/** 화폐별 — 원화 · 달러 · 코인(USDT). 아래에 예수금 (계좌 필터 중에는 숨긴다 — 계좌별로 나뉘지 않는다) */
export function CurrencyCard({ p, showCash }: { p: PortfolioDto; showCash: boolean }) {
	const tiles = [
		{ key: "krw", label: "원화", main: won(p.byCurrency.krw), sub: "", share: p.byCurrencyKrw.krw, show: p.byCurrency.krw !== 0 },
		{ key: "usd", label: "달러", main: usdCash(p.byCurrency.usd), sub: approxWon(p.byCurrencyKrw.usd), share: p.byCurrencyKrw.usd, show: p.byCurrency.usd !== 0 },
		{ key: "usdt", label: "코인 (USDT 환산)", main: usdt(p.byCurrency.usdt), sub: approxWon(p.byCurrencyKrw.usdt), share: p.byCurrencyKrw.usdt, show: p.byCurrency.usdt !== 0 },
	].filter((t) => t.show);
	const cash = showCash && (p.cashKrw > 0 || p.cashUsd > 0);
	if (tiles.length === 0 && !cash) return null;
	return (
		<section className="card fade-up o-5">
			<div className="card-h">
				<h2>화폐별</h2>
			</div>
			<div className="rows border-t border-line">
				{tiles.map((t) => (
					<div key={t.key} className="row">
						<span className="grow">
							<span className="name">{t.label}</span>
							<span className="meta">총자산의 {pctOf(t.share, p.netWorthKrw)}</span>
						</span>
						<span className="amt">
							<b>{t.main}</b>
							{t.sub && <small className="muted">{t.sub}</small>}
						</span>
					</div>
				))}
				{cash && (
					<div className="row">
						<span className="grow">
							<span className="name">예수금</span>
							<span className="meta">주문에 바로 쓸 수 있는 현금</span>
						</span>
						<span className="amt">
							{p.cashKrw > 0 && <b>{won(p.cashKrw)}</b>}
							{p.cashUsd > 0 && (p.cashKrw > 0 ? <small className="muted">{usdCash(p.cashUsd)}</small> : <b>{usdCash(p.cashUsd)}</b>)}
						</span>
					</div>
				)}
			</div>
		</section>
	);
}
