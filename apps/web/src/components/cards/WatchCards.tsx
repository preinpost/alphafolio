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
import { ConfirmBar, ConfirmCard, Line, useConfirm, Warnings } from "./OrderCards.tsx";

/** epoch ms → "09/26 19:00" (KST — 서버 알림과 같은 표기) */
export function kst(t: number): string {
	const k = new Date(t + 9 * 3_600_000).toISOString();
	return `${k.slice(5, 7)}/${k.slice(8, 10)} ${k.slice(11, 16)}`;
}

const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 8 });

/** ms → "3시간 40분" */
function span(ms: number): string {
	const m = Math.round(ms / 60_000);
	return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ""}`;
}

/** 미리보기의 울림이 몇 시간 안에 몰려 있으면 — 기준선 근처를 오르내린 것이라 횟수만 보면 오해한다 */
function clusterHint(card: WatchConfirmCard): string | null {
	const r = card.preview.recent;
	if (r.length < 3 || card.limits.cooldownSec > 0 || card.limits.maxFires === 1) return null;
	const d = (r.at(-1)?.at ?? 0) - (r[0]?.at ?? 0);
	if (d > 6 * 3_600_000) return null;
	return `최근 ${r.length}번이 ${span(d)} 안에 몰려 있습니다 — 기준선 근처를 오르내린 것이라, 쿨다운을 두면 한 번만 울립니다.`;
}

/** 언제까지·몇 번 — 한 줄 */
function scheduleText(card: WatchConfirmCard): string {
	if (card.range) return "정지하거나 로스컷이 날 때까지 반복";
	const { maxFires, cooldownSec, expiresAt } = card.limits;
	const until = expiresAt.slice(0, 10);
	return `${until}까지 ${maxFires ? `최대 ${maxFires}번` : "계속"}${cooldownSec ? ` · 다시 울리기까지 ${Math.round(cooldownSec / 60)}분` : ""}`;
}

export function WatchConfirmCardView({ card }: { card: WatchConfirmCard }) {
	const qc = useQueryClient();
	const order = card.order ?? null;
	const c = useConfirm(card.token, card.expiresAt, true, async (token) => {
		const r = await api.armWatch(token);
		void qc.invalidateQueries({ queryKey: ["watch"] });
		toast(order ? "자동 매매를 켰습니다" : "감시를 켰습니다 — 봉이 닫힐 때마다 확인합니다");
		return order ? `자동 매매를 켰습니다 (${r.watch.id}) — 조건이 맞으면 주문합니다` : `감시를 켰습니다 (${r.watch.id}) — 봉이 닫힐 때마다 확인합니다`;
	});
	const { preview } = card;
	// 예전 카드에는 마감 시각이 없다 — 봉 시작으로
	const lastAt = card.lastCloseAt ?? card.lastBarAt;
	const lastLabel = card.lastCloseAt != null ? "마지막 마감" : "마지막 봉 시작";
	const target = card.target ?? null;
	const gap = target !== null && card.lastClose ? ((target - card.lastClose) / card.lastClose) * 100 : null;
	const hint = clusterHint(card);
	const lastFire = preview.recent.at(-1);
	// 이름을 안 주면 조건 줄의 앞부분이 이름이 된다 — 같은 말을 두 번 쓰지 않는다
	const dupe = card.text.startsWith(card.name);

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
					<div className="sym">{dupe ? card.text : card.name}</div>
					{(!dupe || card.preset) && (
						<div className="how w-cond">{[dupe ? "" : card.text, card.preset ? `프리셋 ${card.preset}` : ""].filter(Boolean).join(" · ")}</div>
					)}
				</div>
				{card.lastClose !== null && (
					<div className="total">
						<small>
							{lastLabel}
							{lastAt !== null && ` · ${kst(lastAt)}`}
						</small>
						<b>{n(card.lastClose)}</b>
						{target !== null && gap !== null && (
							<small>
								목표 {n(target)}까지{" "}
								<span className="w-gap">
									{gap >= 0 ? "+" : ""}
									{gap.toFixed(2)}%
								</span>
							</small>
						)}
					</div>
				)}
			</div>

			{!card.range && (
				<div className="c-sec c-lines">
					<Line k={`지난 ${preview.days}일이었다면`} r={lastFire && `마지막 ${kst(lastFire.at)}`}>
						<b>{preview.count === 0 ? "한 번도 울리지 않음" : `${preview.count}번 울림`}</b>
					</Line>
					{hint && <p className="w-hint">{hint}</p>}
					{preview.recent.length > 0 && (
						<details>
							<summary className="cursor-pointer select-none">최근 {preview.recent.length}번 보기</summary>
							<ol className="w-fires">
								{[...preview.recent].reverse().map((r) => (
									<li key={r.at}>
										<span>{kst(r.at)}</span>
										<span>{n(r.close)}</span>
									</li>
								))}
							</ol>
						</details>
					)}
				</div>
			)}

			{(card.range || card.feed || order) && (
				<dl className="kv c-kv">
					{card.range && (
						<>
							<dt>반복 범위</dt>
							<dd>
								매수 {n(card.range.buyPrice)} 이하 · 매도 {n(card.range.sellPrice)} 이상
							</dd>
							<dt>비용 계산</dt>
							<dd>{card.range.fees}</dd>
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
				</dl>
			)}

			<div className="c-meta">
				{["앱 화면", ...card.channels.map((x) => (x === "telegram" ? "텔레그램" : x))].join(" · ")}으로 알림 · {scheduleText(card)}
			</div>

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
