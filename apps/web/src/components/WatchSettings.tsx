/**
 * 설정 → 감시 (PLAN §40). 만들기는 챗에서 (에이전트가 준비하고 카드에서 켠다), 여기는 보기·멈추기·다시 켜기·지우기.
 * 다시 켜기는 **여기서만** 된다 (에이전트·텔레그램은 못 한다 — 자동 동작을 허용하는 쪽이라 켜기와 같은 무게).
 * 자동 매매 하루 매수 한도도 여기서만 정한다 (없으면 매수 감시를 켤 수 없다).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type TradeCurrency, type TradeExecItem, type WatchEventItem, type WatchItem } from "../lib/api.ts";
import { kst } from "./cards/WatchCards.tsx";

const btn = "shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-ink disabled:opacity-40";

const STATE: Record<WatchItem["state"], { label: string; tone: string }> = {
	armed: { label: "켜짐", tone: "text-success" },
	paused: { label: "일시정지", tone: "text-muted" },
	done: { label: "소진", tone: "text-faint" },
	expired: { label: "만료", tone: "text-faint" },
	off: { label: "꺼짐", tone: "text-faint" },
};

const EVENT: Record<string, string> = {
	armed: "켬",
	fired: "발동",
	missed: "늦은 발동",
	expired: "만료",
	paused: "일시정지",
	resumed: "다시 켬",
	removed: "삭제",
	stopped: "비상 정지",
	error: "오류",
	ordered: "자동 매매",
	skipped: "주문 안 함",
};

const EXEC_STATE: Record<TradeExecItem["state"], { label: string; tone: string }> = {
	running: { label: "체결 중", tone: "text-accent" },
	filled: { label: "체결", tone: "text-success" },
	partial: { label: "일부 체결", tone: "text-ink" },
	none: { label: "미체결", tone: "text-muted" },
	unknown: { label: "결과 모름", tone: "text-danger" },
};

const money = (v: number, c: TradeCurrency) =>
	c === "KRW"
		? `${Math.round(v).toLocaleString("en-US")}원`
		: c === "USD"
			? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
			: `${v.toLocaleString("en-US", { maximumFractionDigits: v >= 1 ? 2 : 8 })} USDT`;

/** 체결 수량 — 주식 "3/5주", 코인 "0.01/0.02 BTC" (USDT 마켓만 자동 매매) */
const qtyPair = (filled: number, qty: number, symbol: string, coin: boolean) => {
	const f = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 8 });
	return coin ? `${f(filled)}/${f(qty)} ${symbol.replace(/USDT$/, "")}` : `${f(filled)}/${f(qty)}주`;
};

const LIMIT_LABEL: Record<TradeCurrency, string> = { KRW: "국장 (원)", USD: "미장 ($)", USDT: "코인 (USDT)" };

const BY: Record<string, string> = { app: "앱", agent: "에이전트", telegram: "텔레그램" };

function eventText(e: WatchEventItem): string {
	const bits = [EVENT[e.kind] ?? e.kind, e.detail.name ?? ""];
	if (e.detail.values) bits.push(Object.entries(e.detail.values).map(([k, v]) => `${k} ${v.toLocaleString("en-US")}`).join(" · "));
	if (e.detail.missed) bits.push(`놓친 ${e.detail.missed}번`);
	if (e.detail.count !== undefined) bits.push(`${e.detail.count}개`);
	if (e.detail.by) bits.push(`(${BY[e.detail.by] ?? e.detail.by})`);
	if (e.kind === "ordered" && e.detail.side) {
		const coin = /USDT$/.test(e.detail.symbol ?? "");
		bits.push(`${e.detail.side === "BUY" ? "매수" : "매도"} ${qtyPair(e.detail.filledQty ?? 0, e.detail.quantity ?? 0, e.detail.symbol ?? "", coin)}${e.detail.avgPrice ? ` @${e.detail.avgPrice.toLocaleString("en-US")}` : ""}`);
		if (e.detail.status) bits.push(EXEC_STATE[e.detail.status].label);
	}
	if (e.detail.reason && e.kind !== "ordered") bits.push(e.detail.reason);
	return bits.filter(Boolean).join(" · ");
}

function RangeStatus({ range }: { range: NonNullable<WatchItem["range"]> }) {
	const quantity = (value: number) => `${value.toLocaleString("en-US", { maximumFractionDigits: 8 })} ${range.unit}`;
	return (
		<div className="space-y-1 rounded-lg border border-line bg-inset p-2 text-xs text-ink">
			<p>{range.phase} · 종료된 회차 {range.cycles}회</p>
			<p>전략 보유분 {quantity(range.qty)} · 매입원가 {money(range.cost, range.currency)}{range.qty > 0 && range.buyEstimated ? " (매수 비용 추정)" : ""}</p>
			<p>실현 순손익 {money(range.realizedPnl, range.currency)}{range.pnlEstimated ? " (비용 추정 포함)" : ""}</p>
			{range.dustQty > 0 && <p className="text-muted">최소 주문 단위 미만 잔량 {quantity(range.dustQty)}은 별도 보유로 남아 있습니다.</p>}
		</div>
	);
}

/** 하루 매수 한도 — 통화별. 비우고 저장하면 지운다 */
function LimitRow({ currency, value, onSave, busy }: { currency: TradeCurrency; value: number | null; onSave: (v: number | null) => void; busy: boolean }) {
	const [draft, setDraft] = useState<string>(value === null ? "" : String(value));
	const parsed = draft.trim() === "" ? null : Number(draft.replace(/,/g, ""));
	const invalid = parsed !== null && !(Number.isFinite(parsed) && parsed > 0);
	const changed = parsed !== value;
	return (
		<div className="flex items-center gap-2">
			<span className="w-20 shrink-0 text-xs text-muted">{LIMIT_LABEL[currency]}</span>
			<input
				className="min-w-0 flex-1 rounded-lg border border-line bg-card px-2 py-1.5 text-sm text-ink tabular-nums"
				inputMode="decimal"
				placeholder="없음 — 매수 감시를 켤 수 없음"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
			/>
			<button className={btn} disabled={busy || invalid || !changed} onClick={() => onSave(parsed)}>
				저장
			</button>
		</div>
	);
}

export function WatchSettings({ onOpenConversation }: { onOpenConversation?: (id: string) => void }) {
	const qc = useQueryClient();
	// 발동은 서버에서 일어난다 — 화면을 열어 둔 동안 가끔 다시 읽는다 (watch_event 가 오면 바로)
	const view = useQuery({ queryKey: ["watch"], queryFn: api.watches, refetchInterval: 60_000 });
	const act = useMutation({
		mutationFn: (run: () => Promise<unknown>) => run(),
		onSettled: () => void qc.invalidateQueries({ queryKey: ["watch"] }),
	});

	const d = view.data;
	const armed = d?.items.filter((i) => i.state === "armed").length ?? 0;

	return (
		<div className="space-y-6">
			{d && !d.storageReady && <p className="rounded-xl border border-danger/40 bg-inset p-3 text-xs text-danger">감시 저장소가 준비되지 않았습니다 (서버 DB 미설정).</p>}
			{d && d.channels.length === 0 && (
				<p className="rounded-xl border border-line bg-inset p-3 text-xs text-muted">
					알림 채널이 없어 앱을 열어 둔 동안에만 알립니다. 연결 탭의 <b>알림 (텔레그램)</b> 을 설정하면 폰으로 받습니다.
				</p>
			)}
			{d?.telegram.problem && <p className="rounded-xl border border-danger/40 bg-inset p-3 text-xs text-danger">텔레그램 명령 수신: {d.telegram.problem}</p>}

			<section>
				<div className="mb-2 flex items-center justify-between gap-2">
					<h2 className="text-sm font-medium text-muted">감시 {d ? `${d.items.length}개` : ""}</h2>
					{armed > 0 && (
						<button
							className="rounded-lg border border-danger/50 px-3 py-1.5 text-xs text-danger disabled:opacity-40"
							disabled={act.isPending}
							onClick={() => {
								if (confirm(`켜진 감시 ${armed}개를 모두 일시정지할까요? 진행 중인 자동 매매도 걸린 주문을 취소하고 멈춥니다.`)) act.mutate(() => api.stopAllWatches());
							}}
						>
							비상 정지
						</button>
					)}
				</div>
				<div className="space-y-3 rounded-xl border border-line p-3">
					{d?.items.length === 0 && (
						<p className="text-xs text-faint">
							감시가 없습니다. 챗에서 &ldquo;ETH 1시간봉 종가가 2,600 아래로 마감하면 알려줘&rdquo; 처럼 요청하면 확인 카드가 뜨고, [켜기] 를 누르면 시작합니다.
						</p>
					)}
					{d?.items.map((w) => (
						<div key={w.id} className="space-y-1.5 border-b border-line pb-3 last:border-0 last:pb-0">
							<div className="flex items-baseline justify-between gap-2">
								<div className="min-w-0 truncate text-sm text-ink">{w.name}</div>
								<span className={`shrink-0 text-[11px] ${STATE[w.state].tone}`}>{STATE[w.state].label}</span>
							</div>
							<div className="text-xs text-muted">{w.text}</div>
							{w.order && (
								<div className="text-xs text-ink">
									<span className="mr-1 rounded border border-accent/50 px-1 text-[10px] text-accent">자동 매매</span>
									{w.order}
								</div>
							)}
							{w.range && <RangeStatus range={w.range} />}
							<div className="text-[11px] text-faint">
								발동 {w.fires}
								{w.maxFires ? `/${w.maxFires}` : ""}회 · {w.repeat ? "정지할 때까지 반복" : `만료 ${w.expiresAt.slice(0, 10)}`}
								{w.lastFiredAt ? ` · 마지막 발동 ${kst(w.lastFiredAt)}` : ""}
								{w.state === "armed" && w.nextEvalAt ? ` · 다음 확인 ${kst(w.nextEvalAt)}` : ""}
							</div>
							{w.lastError && <div className="text-[11px] text-danger">최근 오류: {w.lastError}</div>}
							<div className="flex flex-wrap items-center gap-2 pt-0.5">
								{w.state === "armed" && (
									<button className={btn} disabled={act.isPending} onClick={() => {
										if (!w.repeat || confirm("전략을 일시정지할까요? 손절 감시도 중단되며 보유분은 매도하지 않습니다.")) act.mutate(() => api.pauseWatch(w.id));
									}}>
										일시정지
									</button>
								)}
								{w.state === "paused" && (
									<button className={btn} disabled={act.isPending || w.range?.resumeBlocked} title={w.range?.resumeBlocked ? "계좌의 주문·잔고를 확인해야 합니다" : undefined} onClick={() => act.mutate(() => api.resumeWatch(w.id))}>
										다시 켜기
									</button>
								)}
								{w.conversationId && onOpenConversation && (
									<button className={btn} onClick={() => onOpenConversation(w.conversationId as string)}>
										만든 대화
									</button>
								)}
								<button
									className="shrink-0 text-xs text-faint disabled:opacity-40"
									disabled={act.isPending || w.range?.removalBlocked}
									title={w.range?.removalBlocked ? "보유분 또는 확인이 필요한 주문이 있습니다" : undefined}
									onClick={() => {
										const dustWarning = w.range?.dustQty ? " 최소 주문 단위 미만 잔량은 계좌에 그대로 남습니다." : "";
										if (confirm(`${w.name} 을(를) 삭제할까요? 되돌릴 수 없습니다.${dustWarning}`)) act.mutate(() => api.deleteWatch(w.id));
									}}
								>
									삭제
								</button>
							</div>
						</div>
					))}
					{act.error && <p className="text-xs text-danger">{act.error.message}</p>}
				</div>
				<p className="mt-2 text-xs text-faint">
					봉이 닫힌 뒤의 값으로 판정하고, 조건이 이어지는 동안은 다시 울리지 않습니다. 서버가 멈춰 있던 동안의 발동은 돌아온 뒤 &ldquo;늦은 알림&rdquo; 하나로 옵니다.
					텔레그램에서는 /list 로 보고, 일시정지·삭제·/stop(비상 정지)을 할 수 있습니다 — 다시 켜기는 여기서만.
				</p>
			</section>

			{d?.trading && (
				<section>
					<h2 className="mb-2 text-sm font-medium text-muted">자동 매매 한도</h2>
					<div className="space-y-2 rounded-xl border border-line p-3">
						{(["KRW", "USD", "USDT"] as const).map((c) => (
							<LimitRow key={`${c}-${d.trading?.limits[c] ?? null}`} currency={c} value={d.trading?.limits[c] ?? null} busy={act.isPending} onSave={(v) => act.mutate(() => api.setTradeLimit(c, v))} />
						))}
						<p className="text-[11px] text-faint">
							하루(시장 현지 날짜 — 코인은 UTC) 동안 자동 매수에 쓸 수 있는 최대 금액입니다. 코인은 Binance 현물 USDT 마켓만 자동 매매합니다. 한도가 없으면 매수 감시를 켤 수 없고, 넘으면 신호가 와도 주문하지 않습니다. 매도(손절·익절)는 보유 수량으로만 제한합니다.
						</p>
					</div>
				</section>
			)}

			{d?.trading && d.trading.execs.length > 0 && (
				<section>
					<h2 className="mb-2 text-sm font-medium text-muted">최근 자동 매매</h2>
					<ul className="space-y-2 rounded-xl border border-line p-3">
						{d.trading.execs.map((x) => (
							<li key={x.id} className="space-y-0.5 border-b border-line pb-2 text-xs last:border-0 last:pb-0">
								<div className="flex items-baseline gap-2">
									<span className="shrink-0 text-faint tabular-nums">{kst(x.at)}</span>
									<span className={x.side === "BUY" ? "text-up" : "text-down"}>{x.side === "BUY" ? "매수" : "매도"}</span>
									<span className="text-ink">
										{x.symbol} {qtyPair(x.filledQty, x.quantity, x.symbol, x.currency === "USDT")}
										{x.avgPrice !== null ? ` · 평균 ${money(x.avgPrice, x.currency)}` : ""}
									</span>
									<span className={`ml-auto shrink-0 ${EXEC_STATE[x.state].tone}`}>{EXEC_STATE[x.state].label}</span>
								</div>
								<div className="text-[11px] text-faint">
									{x.account} · 최악 {money(x.worstPrice, x.currency)} · 주문 {x.orders}건{x.slippageBps !== null ? ` · 슬리피지 ${x.slippageBps}bp` : ""}
								</div>
								{x.reason && <div className={`text-[11px] ${x.state === "unknown" ? "text-danger" : "text-muted"}`}>{x.reason}</div>}
							</li>
						))}
					</ul>
				</section>
			)}

			{d && d.events.length > 0 && (
				<section>
					<h2 className="mb-2 text-sm font-medium text-muted">최근 기록</h2>
					<ul className="space-y-1 rounded-xl border border-line p-3">
						{d.events.map((e) => (
							<li key={e.id} className="flex gap-3 text-xs">
								<span className="shrink-0 text-faint tabular-nums">{kst(e.at)}</span>
								<span className={`min-w-0 ${e.kind === "fired" || e.kind === "missed" || e.kind === "ordered" ? "text-ink" : "text-muted"}`}>{eventText(e)}</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}
