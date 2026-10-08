/**
 * 설정 → 감시 (PLAN §40). 만들기는 챗에서 (에이전트가 준비하고 카드에서 켠다), 여기는 보기·멈추기·다시 켜기·지우기.
 * 다시 켜기는 **여기서만** 된다 (에이전트·텔레그램은 못 한다 — 자동 동작을 허용하는 쪽이라 켜기와 같은 무게).
 * 자동 매매 하루 매수 한도도 여기서만 정한다 (없으면 매수 감시를 켤 수 없다).
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type TradeCurrency, type TradeExecItem, type WatchEventItem, type WatchItem } from "../lib/api.ts";
import { toast } from "../lib/toast.ts";
import { kst } from "./cards/WatchCards.tsx";
import { AlertIcon, InfoIcon, PauseIcon, PlayIcon, TrashIcon } from "./icons.tsx";

const STATE: Record<WatchItem["state"], { label: string; tone: string }> = {
	armed: { label: "켜짐", tone: "ok" },
	paused: { label: "일시정지", tone: "warn" },
	done: { label: "소진", tone: "" },
	expired: { label: "만료", tone: "" },
	off: { label: "꺼짐", tone: "" },
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
	running: { label: "체결 중", tone: "accent" },
	filled: { label: "체결", tone: "ok" },
	partial: { label: "일부 체결", tone: "warn" },
	none: { label: "미체결", tone: "" },
	unknown: { label: "결과 모름", tone: "bad" },
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
		bits.push(
			`${e.detail.side === "BUY" ? "매수" : "매도"} ${qtyPair(e.detail.filledQty ?? 0, e.detail.quantity ?? 0, e.detail.symbol ?? "", coin)}${e.detail.avgPrice ? ` @${e.detail.avgPrice.toLocaleString("en-US")}` : ""}`,
		);
		if (e.detail.status) bits.push(EXEC_STATE[e.detail.status].label);
	}
	if (e.detail.reason && e.kind !== "ordered") bits.push(e.detail.reason);
	return bits.filter(Boolean).join(" · ");
}

function RangeStatus({ range }: { range: NonNullable<WatchItem["range"]> }) {
	const quantity = (value: number) => `${value.toLocaleString("en-US", { maximumFractionDigits: 8 })} ${range.unit}`;
	return (
		<div className="mt-2 flex flex-col gap-0.5 rounded-lg border border-line bg-inset px-3 py-2 text-[12px]">
			<span>
				{range.phase} · 종료된 회차 {range.cycles}회
			</span>
			<span className="num">
				전략 보유분 {quantity(range.qty)} · 매입원가 {money(range.cost, range.currency)}
				{range.qty > 0 && range.buyEstimated ? " (매수 비용 추정)" : ""}
			</span>
			<span className="num">
				실현 순손익 <b className={range.realizedPnl > 0 ? "up" : range.realizedPnl < 0 ? "down" : ""}>{money(range.realizedPnl, range.currency)}</b>
				{range.pnlEstimated ? " (비용 추정 포함)" : ""}
			</span>
			{range.dustQty > 0 && <span className="text-muted">최소 주문 단위 미만 잔량 {quantity(range.dustQty)}은 별도 보유로 남아 있습니다.</span>}
		</div>
	);
}

/** 하루 매수 한도 — 통화별. 비우고 저장하면 지운다 */
function LimitRow({ currency, value, onSave, busy }: { currency: TradeCurrency; value: number | null; onSave: (v: number | null) => void; busy: boolean }) {
	const [draft, setDraft] = useState<string>(value === null ? "" : value.toLocaleString("en-US"));
	const parsed = draft.trim() === "" ? null : Number(draft.replace(/,/g, ""));
	const invalid = parsed !== null && !(Number.isFinite(parsed) && parsed > 0);
	const changed = parsed !== value;

	function submit(e: FormEvent): void {
		e.preventDefault();
		if (!invalid && changed) onSave(parsed);
	}

	return (
		<form className="key-row" onSubmit={submit}>
			<div className="who">
				<div className="name">{LIMIT_LABEL[currency]}</div>
				<div className="meta">
					{value === null ? <span className="badge warn">한도 없음</span> : <span className="badge ok">하루 {money(value, currency)}</span>}
				</div>
			</div>
			<div className="edit">
				<input
					className="input input-sm num"
					inputMode="decimal"
					aria-label={`${LIMIT_LABEL[currency]} 하루 한도`}
					aria-invalid={invalid}
					placeholder="없음 — 매수 감시를 켤 수 없음"
					value={draft}
					onChange={(e) => {
						const [i = "", d] = e.target.value.replace(/[^\d.]/g, "").split(".");
						const int = i ? Number(i).toLocaleString("en-US") : "";
						setDraft(d !== undefined ? `${int || "0"}.${d.slice(0, 2)}` : int);
					}}
				/>
				<button type="submit" className="btn btn-secondary btn-sm" disabled={busy || invalid || !changed}>
					저장
				</button>
			</div>
		</form>
	);
}

export function WatchSettings({ onOpenConversation }: { onOpenConversation?: (id: string) => void }) {
	const qc = useQueryClient();
	// 발동은 서버에서 일어난다 — 화면을 열어 둔 동안 가끔 다시 읽는다 (watch_event 가 오면 바로)
	const view = useQuery({ queryKey: ["watch"], queryFn: api.watches, refetchInterval: 60_000 });
	const act = useMutation({
		mutationFn: ({ run }: { run: () => Promise<unknown>; done?: string }) => run(),
		onSuccess: (_r, v) => {
			if (v.done) toast(v.done);
		},
		onSettled: () => void qc.invalidateQueries({ queryKey: ["watch"] }),
	});

	const d = view.data;
	const armed = d?.items.filter((i) => i.state === "armed").length ?? 0;

	return (
		<>
			{d && !d.storageReady && (
				<div className="notice bad">
					<AlertIcon size={16} />
					<span>감시 저장소가 준비되지 않았습니다 (서버 DB 미설정).</span>
				</div>
			)}
			{d && d.channels.length === 0 && (
				<div className="notice">
					<InfoIcon size={16} />
					<span>
						알림 채널이 없어 앱을 열어 둔 동안에만 알립니다. 연결 탭의 <b>알림 (텔레그램)</b> 을 설정하면 폰으로 받습니다.
					</span>
				</div>
			)}
			{d?.telegram.problem && (
				<div className="notice bad">
					<AlertIcon size={16} />
					<span>텔레그램 명령 수신: {d.telegram.problem}</span>
				</div>
			)}

			{d?.trading && (
				<section className="card">
					<div className="card-h">
						<h2>자동 매매 한도</h2>
					</div>
					<p className="card-b text-[13px] text-muted">
						하루(시장 현지 날짜 — 코인은 UTC) 동안 자동 매수에 쓸 수 있는 최대 금액입니다. 한도가 없으면 매수 감시를 켤 수 없고, 넘으면 신호가 와도 주문하지 않습니다. 매도(손절·익절)는
						보유 수량으로만 제한합니다. 코인은 Binance 현물 USDT 마켓만 자동 매매합니다.
					</p>
					<div className="rows border-t border-line">
						{(["KRW", "USD", "USDT"] as const).map((c) => (
							<LimitRow
								key={`${c}-${d.trading?.limits[c] ?? null}`}
								currency={c}
								value={d.trading?.limits[c] ?? null}
								busy={act.isPending}
								onSave={(v) => act.mutate({ run: () => api.setTradeLimit(c, v), done: v === null ? "한도를 지웠습니다" : "한도를 저장했습니다" })}
							/>
						))}
					</div>
				</section>
			)}

			<section className="card">
				<div className="card-h">
					<h2>
						감시 목록<span className="count">{d?.items.length ?? ""}</span>
					</h2>
					<span className="spacer" />
					{armed > 0 && (
						<button
							className="btn btn-danger btn-sm"
							disabled={act.isPending}
							onClick={() => {
								if (confirm(`켜진 감시 ${armed}개를 모두 일시정지할까요? 진행 중인 자동 매매도 걸린 주문을 취소하고 멈춥니다.`))
									act.mutate({ run: () => api.stopAllWatches(), done: "모든 감시를 멈췄습니다" });
							}}
						>
							비상 정지
						</button>
					)}
				</div>
				<div className="rows border-t border-line">
					{d?.items.length === 0 && <div className="empty">켜진 감시가 없습니다. 챗에서 “ETH 1시간봉 종가가 2,600 아래로 마감하면 알려줘”처럼 말해 보세요.</div>}
					{d?.items.map((w) => (
						<WatchRow key={w.id} w={w} busy={act.isPending} act={act.mutate} onOpenConversation={onOpenConversation} />
					))}
				</div>
				{act.error && <p className="field-err px-5 pb-4">{act.error.message}</p>}
				<p className="border-t border-line px-5 py-3 text-[12.5px] text-muted max-md:px-4">
					봉이 닫힌 뒤의 값으로 판정하고, 조건이 이어지는 동안은 다시 울리지 않습니다. 서버가 멈춰 있던 동안의 발동은 돌아온 뒤 “늦은 알림” 하나로 옵니다. 텔레그램에서는 /list 로
					보고, 일시정지·삭제·/stop(비상 정지)을 할 수 있습니다 — 다시 켜기는 여기서만.
				</p>
			</section>

			{d?.trading && d.trading.execs.length > 0 && (
				<section className="card">
					<div className="card-h">
						<h2>최근 자동 매매</h2>
					</div>
					<div className="rows border-t border-line">
						{d.trading.execs.map((x) => (
							<div key={x.id} className="row items-start">
								<span className={`badge ${EXEC_STATE[x.state].tone}`} style={{ minWidth: 64, justifyContent: "center" }}>
									{EXEC_STATE[x.state].label}
								</span>
								<span className="grow">
									<span className="name font-medium">
										<span className={x.side === "BUY" ? "up" : "down"}>{x.side === "BUY" ? "매수" : "매도"}</span> {x.symbol}{" "}
										{qtyPair(x.filledQty, x.quantity, x.symbol, x.currency === "USDT")}
										{x.avgPrice !== null ? ` · 평균 ${money(x.avgPrice, x.currency)}` : ""}
									</span>
									<span className="meta">
										{x.account} · 최악 {money(x.worstPrice, x.currency)} · 주문 {x.orders}건{x.slippageBps !== null ? ` · 슬리피지 ${x.slippageBps}bp` : ""}
									</span>
									{x.reason && <span className={`meta ${x.state === "unknown" ? "danger-text" : ""}`}>{x.reason}</span>}
								</span>
								<span className="hist-when">{kst(x.at)}</span>
							</div>
						))}
					</div>
				</section>
			)}

			{d && d.events.length > 0 && (
				<section className="card">
					<div className="card-h">
						<h2>최근 기록</h2>
					</div>
					<div className="rows border-t border-line">
						{d.events.map((e) => (
							<div key={e.id} className="row" style={{ minHeight: 44 }}>
								<span className="hist-when">{kst(e.at)}</span>
								<span className={`grow text-[13px] ${e.kind === "fired" || e.kind === "missed" || e.kind === "ordered" ? "" : "text-muted"}`}>{eventText(e)}</span>
							</div>
						))}
					</div>
				</section>
			)}
		</>
	);
}

function WatchRow({
	w,
	busy,
	act,
	onOpenConversation,
}: {
	w: WatchItem;
	busy: boolean;
	act: (v: { run: () => Promise<unknown>; done?: string }) => void;
	onOpenConversation: ((id: string) => void) | undefined;
}) {
	const st = STATE[w.state];
	const dim = w.state === "done" || w.state === "expired" || w.state === "off";
	return (
		<div className={`row w-row items-start ${dim ? "dim" : ""}`}>
			<span className="grow">
				<span className="name">{w.name}</span>
				<span className="cond-text" title={w.text}>
					{w.text}
				</span>
				{w.order && (
					<span className="meta" title={w.order}>
						<span className="badge warn mr-1.5">자동 매매</span>
						{w.order}
					</span>
				)}
				{w.range && <RangeStatus range={w.range} />}
				<span className="meta">
					발동 {w.fires}
					{w.maxFires ? `/${w.maxFires}` : ""}회 · {w.repeat ? "정지할 때까지 반복" : `만료 ${w.expiresAt.slice(0, 10)}`}
					{w.lastFiredAt ? ` · 마지막 ${kst(w.lastFiredAt)}` : ""}
					{w.state === "armed" && w.nextEvalAt ? ` · 다음 확인 ${kst(w.nextEvalAt)}` : ""} · <span className="mono">{w.id}</span>
				</span>
				{w.lastError && <span className="meta danger-text">최근 오류: {w.lastError}</span>}
				{w.conversationId && onOpenConversation && (
					<span className="w-acts">
						<button className="btn btn-ghost btn-sm -ml-2.5" onClick={() => onOpenConversation(w.conversationId as string)}>
							만든 대화 열기
						</button>
					</span>
				)}
			</span>
			<span className={`badge ${st.tone}`}>{st.label}</span>
			{w.state === "armed" ? (
				<button
					className="icon-btn"
					disabled={busy}
					aria-label="일시정지"
					title="일시정지"
					onClick={() => {
						if (!w.repeat || confirm("전략을 일시정지할까요? 손절 감시도 중단되며 보유분은 매도하지 않습니다."))
							act({ run: () => api.pauseWatch(w.id), done: `${w.name} 일시정지` });
					}}
				>
					<PauseIcon size={16} />
				</button>
			) : w.state === "paused" ? (
				<button
					className="icon-btn"
					disabled={busy || w.range?.resumeBlocked}
					aria-label="다시 켜기"
					title={w.range?.resumeBlocked ? "계좌의 주문·잔고를 확인해야 합니다" : "다시 켜기"}
					onClick={() => act({ run: () => api.resumeWatch(w.id), done: `${w.name} 다시 켬` })}
				>
					<PlayIcon size={16} />
				</button>
			) : (
				<span className="icon-btn" aria-hidden="true" />
			)}
			<button
				className="icon-btn"
				disabled={busy || w.range?.removalBlocked}
				aria-label={`${w.name} 삭제`}
				title={w.range?.removalBlocked ? "보유분 또는 확인이 필요한 주문이 있습니다" : "삭제"}
				onClick={() => {
					const dustWarning = w.range?.dustQty ? " 최소 주문 단위 미만 잔량은 계좌에 그대로 남습니다." : "";
					if (confirm(`${w.name} 을(를) 삭제할까요? 되돌릴 수 없습니다.${dustWarning}`)) act({ run: () => api.deleteWatch(w.id), done: `${w.name} 삭제` });
				}}
			>
				<TrashIcon size={16} />
			</button>
		</div>
	);
}
