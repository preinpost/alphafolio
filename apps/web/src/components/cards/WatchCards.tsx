/**
 * 감시 켜기 확인 카드 (PLAN §40).
 *
 * ⚠️ [켜기] 가 감시를 시작하는 **유일한 경로**다. 에이전트는 카드를 띄울 수만 있다.
 * 켜기 전에 사람이 볼 것: 무엇을(조건 한 줄), 얼마나 자주 울렸을지(지난 기간 미리보기), 어디로 오는지(채널), 언제 끝나는지(만료).
 */
import type { WatchConfirmCard } from "@alphafolio/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import { ConfirmBar, useConfirm, Warnings } from "./OrderCards.tsx";

/** epoch ms → \"09/26 19:00\" (KST — 서버 알림과 같은 표기) */
export function kst(t: number): string {
	const k = new Date(t + 9 * 3_600_000).toISOString();
	return `${k.slice(5, 7)}/${k.slice(8, 10)} ${k.slice(11, 16)}`;
}

const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 8 });

export function WatchConfirmCardView({ card }: { card: WatchConfirmCard }) {
	const qc = useQueryClient();
	const c = useConfirm(card.token, card.expiresAt, true, async (token) => {
		const r = await api.armWatch(token);
		void qc.invalidateQueries({ queryKey: ["watch"] });
		return `감시를 켰습니다 (${r.watch.id}) — 봉이 닫힐 때마다 확인합니다`;
	});
	const { limits, preview } = card;

	return (
		<div className="mt-2 rounded-xl border-2 border-accent/60 bg-inset p-4">
			<div className="flex items-baseline justify-between gap-3">
				<div className="min-w-0 text-sm font-semibold text-ink">감시 켜기 — {card.name}</div>
				<span className="shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-muted">Binance</span>
			</div>
			<div className="mt-1 text-sm text-ink">{card.text}</div>

			<dl className="mt-3 grid grid-cols-[minmax(0,6.5rem)_1fr] gap-x-3 gap-y-1.5 border-t border-line pt-3 text-xs">
				<dt className="text-faint">마지막 마감</dt>
				<dd className="text-ink tabular-nums">{card.lastClose !== null && card.lastBarAt !== null ? `${n(card.lastClose)} (${kst(card.lastBarAt)} 시작 봉)` : "없음"}</dd>
				<dt className="text-faint">지난 {preview.days}일</dt>
				<dd className="text-ink">
					{preview.count === 0 ? "한 번도 울리지 않았을 조건입니다" : `${preview.count}번 울렸을 것 — 최근 ${preview.recent.map((r) => `${kst(r.at)} (${n(r.close)})`).join(", ")}`}
				</dd>
				<dt className="text-faint">받는 곳</dt>
				<dd className="text-ink">{["앱 화면", ...card.channels.map((x) => (x === "telegram" ? "텔레그램" : x))].join(" · ")}</dd>
				<dt className="text-faint">횟수 · 만료</dt>
				<dd className="text-ink">
					{limits.maxFires ? `최대 ${limits.maxFires}번` : "만료까지 계속"}
					{limits.cooldownSec ? ` · 다시 울리기까지 ${Math.round(limits.cooldownSec / 60)}분` : ""} · {limits.expiresAt.slice(0, 10)} 만료
				</dd>
			</dl>
			{c.phase === "idle" && <p className="mt-3 text-[11px] text-faint">봉이 닫힌 뒤의 값으로만 판정합니다 (중간에 꼬리로 찍고 돌아온 가격에는 울리지 않습니다). 알림만 보내고 주문은 내지 않습니다.</p>}
			<Warnings items={card.warnings} />
			<ConfirmBar c={c} verb="켜기" />
		</div>
	);
}
