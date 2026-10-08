/**
 * 감시 켜기 확인 카드 (PLAN §40).
 *
 * ⚠️ [켜기] 가 감시를 시작하는 **유일한 경로**다. 에이전트는 카드를 띄울 수만 있다.
 * 켜기 전에 사람이 볼 것: 무엇을(조건 한 줄), 얼마나 자주 울렸을지(지난 기간 미리보기), 어디로 오는지(채널), 언제 끝나는지(만료).
 */
import type { WatchConfirmCard } from "@alphafolio/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import { toast } from "../../lib/toast.ts";
import { ConfirmBar, ConfirmCard, useConfirm, Warnings } from "./OrderCards.tsx";

/** epoch ms → "09/26 19:00" (KST — 서버 알림과 같은 표기) */
export function kst(t: number): string {
	const k = new Date(t + 9 * 3_600_000).toISOString();
	return `${k.slice(5, 7)}/${k.slice(8, 10)} ${k.slice(11, 16)}`;
}

const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 8 });

export function WatchConfirmCardView({ card }: { card: WatchConfirmCard }) {
	const qc = useQueryClient();
	const order = card.order ?? null;
	const c = useConfirm(card.token, card.expiresAt, true, async (token) => {
		const r = await api.armWatch(token);
		void qc.invalidateQueries({ queryKey: ["watch"] });
		toast(order ? "자동 매매를 켰습니다" : "감시를 켰습니다 — 봉이 닫힐 때마다 확인합니다");
		return order ? `자동 매매를 켰습니다 (${r.watch.id}) — 조건이 맞으면 주문합니다` : `감시를 켰습니다 (${r.watch.id}) — 봉이 닫힐 때마다 확인합니다`;
	});
	const { limits, preview } = card;

	return (
		<ConfirmCard
			c={c}
			title={order ? "자동 매매 켜기" : "감시 켜기"}
			label={order ? "자동 매매 켜기 확인" : "감시 켜기 확인"}
			badges={
				<>
					<span className={`badge ${order ? "warn" : ""}`}>{order ? "자동 매매" : "알림만"}</span>
					<span className="badge">{card.venue ?? "Binance"}</span>
				</>
			}
		>
			<div className="c-main">
				<div className="grow">
					<div className="sym">{card.name}</div>
					{card.preset && <div className="how muted">프리셋 · {card.preset}</div>}
				</div>
			</div>
			<div className="cond">{card.text}</div>

			<dl className="kv c-kv">
				<dt>마지막 마감</dt>
				<dd>{card.lastClose !== null && card.lastBarAt !== null ? `${n(card.lastClose)} (${kst(card.lastBarAt)} 시작 봉, KST)` : "없음"}</dd>
				{card.range ? (
					<>
						<dt>반복 범위</dt>
						<dd>
							매수 {n(card.range.buyPrice)} 이하 · 매도 {n(card.range.sellPrice)} 이상
						</dd>
						<dt>비용 계산</dt>
						<dd>{card.range.fees}</dd>
					</>
				) : (
					<>
						<dt>지난 {preview.days}일</dt>
						<dd>
							{preview.count === 0
								? "한 번도 울리지 않았을 조건입니다"
								: `${preview.count}번 울렸을 것 — 최근 ${preview.recent.map((r) => `${kst(r.at)} (${n(r.close)})`).join(", ")}`}
						</dd>
					</>
				)}
				{card.feed && (
					<>
						<dt>시세 기준</dt>
						<dd>{card.feed}</dd>
					</>
				)}
				{order && (
					<>
						<dt className="kv-sec">주문</dt>
						<dt>계좌</dt>
						<dd>{order.account}</dd>
						<dt>동작</dt>
						<dd>
							<b className={order.side === "BUY" ? "up" : "down"}>{order.side === "BUY" ? "매수" : "매도"}</b> {order.size}
							{order.estimate && <span className="muted"> — {order.estimate}</span>}
						</dd>
						{order.protect && (
							<>
								<dt>{order.side === "BUY" ? "체결 후 보호" : "손절·익절"}</dt>
								<dd>{order.protect}</dd>
							</>
						)}
						<dt>최악 허용가</dt>
						<dd>{order.worst}</dd>
						<dt>체결 방식</dt>
						<dd>{order.how}</dd>
						{order.side === "BUY" && (
							<>
								<dt>하루 한도</dt>
								<dd className={order.dailyLimit ? "" : "danger-text"}>{order.dailyLimit ?? "없음 — 설정 → 감시에서 정해야 켜집니다"}</dd>
							</>
						)}
					</>
				)}
				<dt>받는 곳</dt>
				<dd>{["앱 화면", ...card.channels.map((x) => (x === "telegram" ? "텔레그램" : x))].join(" · ")}</dd>
				<dt>{card.range ? "반복 기간" : "횟수 · 만료"}</dt>
				<dd>
					{card.range ? (
						"사용자가 정지하거나 로스컷이 발생할 때까지"
					) : (
						<>
							{limits.maxFires ? `최대 ${limits.maxFires}번` : "만료까지 계속"}
							{limits.cooldownSec ? ` · 다시 울리기까지 ${Math.round(limits.cooldownSec / 60)}분` : ""} · {limits.expiresAt.slice(0, 10)} 만료
						</>
					)}
				</dd>
			</dl>

			{c.phase === "idle" &&
				(order ? (
					<p className="c-note strong">
						<b>켜면 조건이 맞을 때 확인 없이 주문이 나갑니다.</b>{" "}
						{card.range
							? "일반 매매는 봉 마감 기준이고, 로스컷은 현재 호가를 5초 주기로 확인합니다. 주식은 정규장 거래 가능 시간, 코인은 24시간 처리하며 서버 중단 중에는 손절할 수 없습니다."
							: "봉이 닫힌 뒤의 값으로만 판정하고, 주식은 정규장에서만 최악 허용가 안의 지정가로 냅니다. 서버가 멈춰 있던 동안의 신호로는 주문하지 않습니다."}
					</p>
				) : (
					<p className="c-note">봉이 닫힌 뒤의 값으로만 판정합니다 (중간에 꼬리로 찍고 돌아온 가격에는 울리지 않습니다).</p>
				))}
			<Warnings items={card.warnings} />
			<ConfirmBar c={c} verb={order ? "자동 매매 켜기" : "감시 켜기"} note={order ? undefined : "알림만 보내고 주문은 내지 않습니다."} onRetry={c.retry} />
		</ConfirmCard>
	);
}
