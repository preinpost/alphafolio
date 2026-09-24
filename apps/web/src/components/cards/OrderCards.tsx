/**
 * 주문 카드.
 *
 * ⚠️ 이 컴포넌트의 [확인] 버튼이 **실제 주문이 나가는 유일한 경로**다.
 *    에이전트는 토큰이 담긴 카드를 띄울 수만 있고, 실행은 사람의 클릭이 한다.
 *    (외부 웹·뉴스 본문에 심긴 지시문이 주문으로 이어지지 않게 하는 장치)
 */
import { useEffect, useState } from "react";
import type { BinanceOrderCard, ConditionalOrderCard, OrderChangeCard, OrderListCard, OrderPreviewCard } from "@alphafolio/protocol";
import { api } from "../../lib/api.ts";

function money(value: number, currency: "KRW" | "USD"): string {
	return currency === "KRW"
		? `${Math.round(value).toLocaleString("ko-KR")}원`
		: `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

type Phase = "idle" | "sending" | "done" | "failed" | "expired";

const BROKER_LABEL = { toss: "토스", kis: "한국투자", binance: "Binance" } as const;

/** 어느 증권사로 나가는지 — 카드마다 눈에 띄게 (토스로 준비한 주문과 KIS 주문이 섞이지 않게) */
function BrokerBadge({ broker }: { broker: "toss" | "kis" | "binance" }) {
	return <span className="shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-muted">{BROKER_LABEL[broker]}</span>;
}

/**
 * 확인 버튼·남은 시간·결과 — 신규·정정·취소·조건주문 카드 공용.
 * ⚠️ confirm() 이 서버로 토큰을 보내는 것이 **실행되는 유일한 경로**다.
 */
function useConfirm(token: string | null, expiresAt: number | null, ok: boolean) {
	const [phase, setPhase] = useState<Phase>("idle");
	const [message, setMessage] = useState<string | null>(null);
	const [remain, setRemain] = useState(() => secondsLeft(expiresAt));

	// 남은 시간 표시 — 토큰은 2분이라 사용자가 흐름을 알 수 있어야 한다
	useEffect(() => {
		if (!ok || phase !== "idle") return;
		const id = setInterval(() => {
			const left = secondsLeft(expiresAt);
			setRemain(left);
			if (left <= 0) setPhase("expired");
		}, 1000);
		return () => clearInterval(id);
	}, [ok, expiresAt, phase]);

	async function confirm(): Promise<void> {
		if (!token) return;
		setPhase("sending");
		try {
			const r = await api.executeOrder(token);
			const id = r.orderId ?? r.conditionalOrderId;
			setPhase("done");
			setMessage(`${r.message}${id ? ` (${id.slice(0, 12)}${id.length > 12 ? "…" : ""})` : ""}`);
		} catch (err) {
			setPhase("failed");
			setMessage(err instanceof Error ? err.message : String(err));
		}
	}
	return { phase, message, remain, confirm, dismiss: () => setPhase("expired") };
}

function ConfirmBar({ c, verb }: { c: ReturnType<typeof useConfirm>; verb: string }) {
	return (
		<div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
			{c.phase === "idle" && (
				<>
					<button
						onClick={() => void c.confirm()}
						className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition active:scale-95"
					>
						확인하고 {verb}
					</button>
					<button onClick={c.dismiss} className="px-3 py-2 text-sm text-muted">
						닫기
					</button>
					<span className="ml-auto text-[11px] text-faint">{c.remain}초 후 만료</span>
				</>
			)}
			{c.phase === "sending" && <span className="text-sm text-muted">접수 중…</span>}
			{c.phase === "done" && <span className="text-sm text-success">{c.message}</span>}
			{c.phase === "failed" && (
				<div className="text-sm text-danger">
					{c.message}
					<div className="mt-1 text-[11px] text-faint">다시 하려면 챗에서 새로 요청하세요.</div>
				</div>
			)}
			{c.phase === "expired" && <span className="text-sm text-muted">확인이 취소되었습니다. 필요하면 다시 요청하세요.</span>}
		</div>
	);
}

function Problems({ title, errors }: { title: string; errors: string[] }) {
	return (
		<div className="mt-2 rounded-xl border border-danger/50 bg-inset p-4">
			<div className="text-sm font-medium text-ink">{title}</div>
			<ul className="mt-2 space-y-1">
				{errors.map((e) => (
					<li key={e} className="text-xs text-danger">
						· {e}
					</li>
				))}
			</ul>
		</div>
	);
}

function Warnings({ items }: { items: string[] }) {
	if (items.length === 0) return null;
	return (
		<ul className="mt-3 space-y-1 border-t border-line pt-2">
			{items.map((w) => (
				<li key={w} className="text-xs text-muted">
					⚠️ {w}
				</li>
			))}
		</ul>
	);
}

export function OrderPreviewCardView({ card }: { card: OrderPreviewCard }) {
	const c = useConfirm(card.token, card.expiresAt, card.ok);
	const sideLabel = card.side === "BUY" ? "매수" : "매도";
	const sideClass = card.side === "BUY" ? "text-up" : "text-down";
	if (!card.ok) return <Problems title={`주문을 준비하지 못했습니다 — ${card.name}(${card.symbol})`} errors={card.errors} />;

	return (
		<div className="mt-2 rounded-xl border-2 border-accent/60 bg-inset p-4">
			<div className="flex items-baseline justify-between gap-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="truncate text-sm font-semibold text-ink">
							{card.name} <span className="text-xs font-normal text-faint">{card.symbol}</span>
						</span>
						<BrokerBadge broker={card.broker} />
					</div>
					<div className={`mt-0.5 text-sm ${sideClass}`}>
						{sideLabel} {card.quantity.toLocaleString("ko-KR")}주 ·{" "}
						{card.orderType === "LIMIT" ? `지정가 ${money(card.price ?? 0, card.currency)}` : "시장가"}
					</div>
				</div>
				<div className="shrink-0 text-right">
					<div className="text-[11px] text-faint">예상 금액</div>
					<div className="text-base font-semibold text-ink">{money(card.estimatedAmount, card.currency)}</div>
				</div>
			</div>
			<Warnings items={card.warnings} />
			<ConfirmBar c={c} verb="주문" />
		</div>
	);
}

/** 정정(before → after)·취소 */
export function OrderChangeCardView({ card }: { card: OrderChangeCard }) {
	const c = useConfirm(card.token, card.expiresAt, card.ok);
	const o = card.original;
	const sideLabel = o.side === "BUY" ? "매수" : "매도";
	const cancel = card.action === "cancel";
	if (!card.ok) return <Problems title={`${cancel ? "취소" : "정정"}을 준비하지 못했습니다 — ${card.name}(${card.symbol})`} errors={card.errors} />;
	const price = (v: number | null, t: string) => (t === "MARKET" || v === null ? "시장가" : money(v, card.currency));

	return (
		<div className={`mt-2 rounded-xl border-2 bg-inset p-4 ${cancel ? "border-danger/50" : "border-accent/60"}`}>
			<div className="flex items-center justify-between gap-3">
				<span className="truncate text-sm font-semibold text-ink">
					{card.name} <span className="text-xs font-normal text-faint">{card.symbol}</span>{" "}
					<span className={o.side === "BUY" ? "text-up" : "text-down"}>{sideLabel}</span>
				</span>
				<BrokerBadge broker={card.broker} />
			</div>
			{cancel ? (
				<div className="mt-2 text-sm text-ink">
					미체결 {o.openQuantity.toLocaleString("ko-KR")}주 · {price(o.price, o.orderType)} 주문을 <b>취소</b>합니다
				</div>
			) : (
				<div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
					<span className="text-faint">가격</span>
					<span className="text-ink">
						{price(o.price, o.orderType)}
						{card.after && (card.after.price !== o.price || card.after.orderType !== o.orderType) ? (
							<> → <b>{price(card.after.price, card.after.orderType)}</b></>
						) : (
							<span className="text-faint"> (그대로)</span>
						)}
					</span>
					<span className="text-faint">수량</span>
					<span className="text-ink">
						{o.openQuantity.toLocaleString("ko-KR")}주
						{card.after && card.after.quantity !== o.openQuantity ? (
							<> → <b>{card.after.quantity.toLocaleString("ko-KR")}주</b></>
						) : (
							<span className="text-faint"> (그대로)</span>
						)}
					</span>
				</div>
			)}
			<div className="mt-1 text-[11px] text-faint">
				원주문 {o.orderId.length > 14 ? `${o.orderId.slice(0, 14)}…` : o.orderId}
				{o.orderedAt ? ` · 접수 ${o.orderedAt}` : ""}
			</div>
			<Warnings items={card.warnings} />
			<ConfirmBar c={c} verb={cancel ? "취소" : "정정"} />
		</div>
	);
}

/** 조건주문 — SINGLE / OCO(익절·손절) / OTO(매수 → 매도) */
export function ConditionalOrderCardView({ card }: { card: ConditionalOrderCard }) {
	const c = useConfirm(card.token, card.expiresAt, card.ok);
	const verb = card.action === "cancel" ? "취소" : card.action === "modify" ? "수정" : "등록";
	if (!card.ok) return <Problems title={`조건주문을 준비하지 못했습니다 — ${card.name}(${card.symbol})`} errors={card.errors} />;

	const typeLabel = card.type === "OCO" ? "익절·손절 (OCO)" : card.type === "OTO" ? "매수 후 매도 (OTO)" : "단일 조건";
	const pct = (v: number): string | null => {
		const base = card.avgPrice ?? card.currentPrice;
		if (!base) return null;
		const p = ((v - base) / base) * 100;
		return `${card.avgPrice ? "평단" : "현재가"} 대비 ${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
	};
	const legName = (i: 0 | 1, side: "BUY" | "SELL") =>
		card.type === "OCO" ? (i === 0 ? "익절" : "손절") : card.type === "OTO" ? (i === 0 ? "먼저 매수" : "그다음 매도") : side === "BUY" ? "매수" : "매도";
	const Leg = ({ i, leg }: { i: 0 | 1; leg: NonNullable<ConditionalOrderCard["second"]> }) => (
		// 가격은 절대 자르지 않는다 (확인 카드에서 잘리면 무엇을 확인하는지 알 수 없다) — 좁으면 줄을 바꾼다
		<div className="flex flex-wrap items-baseline gap-x-2 text-sm">
			<span className={`shrink-0 ${leg.side === "BUY" ? "text-up" : "text-down"}`}>{legName(i, leg.side)}</span>
			<span className="text-ink">
				감시 {money(leg.triggerPrice, card.currency)} → {leg.orderPrice !== null ? `지정가 ${money(leg.orderPrice, card.currency)}` : "시장가"}
			</span>
			{pct(leg.triggerPrice) && <span className="ml-auto text-[11px] text-faint">{pct(leg.triggerPrice)}</span>}
		</div>
	);

	return (
		<div className={`mt-2 rounded-xl border-2 bg-inset p-4 ${card.action === "cancel" ? "border-danger/50" : "border-accent/60"}`}>
			<div className="flex items-center justify-between gap-3">
				<span className="truncate text-sm font-semibold text-ink">
					{card.name} <span className="text-xs font-normal text-faint">{card.symbol}</span>
				</span>
				<span className="flex shrink-0 items-center gap-1.5">
					<span className="text-[11px] text-muted">{typeLabel}</span>
					<BrokerBadge broker="toss" />
				</span>
			</div>
			<div className="mt-2 space-y-1">
				<Leg i={0} leg={card.first} />
				{card.second && <Leg i={1} leg={card.second} />}
			</div>
			<div className="mt-2 text-xs text-muted">
				수량 {card.quantity.toLocaleString("ko-KR")}주 · 만료 {card.expireDate}
				{card.currentPrice ? ` · 현재가 ${money(card.currentPrice, card.currency)}` : ""}
				{card.action === "modify" ? " · 수정하면 조건주문 번호가 바뀝니다" : ""}
				{card.action === "cancel" ? " · 이 조건주문을 취소합니다" : ""}
			</div>
			<Warnings items={card.warnings} />
			<ConfirmBar c={c} verb={verb} />
		</div>
	);
}

/** 끝자리 0 떼기 — Binance 는 "0.00100000" 처럼 준다 (값은 그대로, 표시만) */
const tz = (v: string): string => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);

/** Binance 현물 — 신규·취소·재주문·OCO·OTO·전체 취소 (값은 거래소 단위로 보정된 문자열) */
export function BinanceOrderCardView({ card }: { card: BinanceOrderCard }) {
	const c = useConfirm(card.token, card.expiresAt, card.ok);
	const pair = `${card.base}/${card.quote}`;
	const verb = { place: "주문", cancel: "취소", replace: "재주문", oco: "등록", oto: "등록", cancel_all: "취소" }[card.action];
	if (!card.ok) return <Problems title={`Binance ${verb}을 준비하지 못했습니다 — ${pair}`} errors={card.errors} />;
	const sideLabel = card.side === "BUY" ? "매수" : card.side === "SELL" ? "매도" : "";
	const sideClass = card.side === "BUY" ? "text-up" : "text-down";
	const danger = card.action === "cancel" || card.action === "cancel_all";

	return (
		<div className={`mt-2 rounded-xl border-2 bg-inset p-4 ${danger ? "border-danger/50" : "border-accent/60"}`}>
			<div className="flex items-center justify-between gap-3">
				<span className="truncate text-sm font-semibold text-ink">
					{pair}{" "}
					{card.action === "replace" && card.side ? <span className={sideClass}>{sideLabel} </span> : null}
					{card.action === "oco" ? <span className="text-xs font-normal text-muted">익절·손절 (OCO)</span> : null}
					{card.action === "oto" ? <span className="text-xs font-normal text-muted">매수 후 매도 (OTO)</span> : null}
				</span>
				<BrokerBadge broker="binance" />
			</div>

			{card.action === "place" && (
				<div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3">
					<span className={`text-sm ${sideClass}`}>
						{sideLabel}{" "}
						{card.quantity ? `${card.quantity} ${card.base}` : `${card.quoteQuantity} ${card.quote} 어치`} ·{" "}
						{card.type === "LIMIT" ? `지정가 ${card.price} ${card.quote}` : "시장가"}
					</span>
					{card.estimatedQuote && (
						<span className="text-sm text-ink">
							주문금액 <b>{card.estimatedQuote}</b> {card.quote}
						</span>
					)}
				</div>
			)}
			{card.action === "cancel" && card.original && (
				<div className="mt-2 text-sm text-ink">
					<span className={card.original.side === "BUY" ? "text-up" : "text-down"}>{card.original.side === "BUY" ? "매수" : "매도"}</span>{" "}
					{tz(card.original.origQty)} {card.base} @ {tz(card.original.price)} {card.quote} 주문을 <b>취소</b>합니다
				</div>
			)}
			{card.action === "cancel_all" && (
				<div className="mt-2 text-sm text-ink">
					미체결 <b>{card.orders.length}건</b>을 모두 취소합니다
					<ul className="mt-1 space-y-0.5 text-xs text-muted">
						{card.orders.slice(0, 5).map((o) => (
							<li key={o.orderId}>
								· {o.side === "BUY" ? "매수" : "매도"} {tz(o.origQty)} {card.base} @ {tz(o.price)} {card.quote}
							</li>
						))}
						{card.orders.length > 5 && <li>· 외 {card.orders.length - 5}건</li>}
					</ul>
				</div>
			)}
			{card.lines.length > 0 && (
				<div className="mt-2 space-y-1">
					{card.action === "oco" || card.action === "oto" ? (
						<div className="text-sm text-ink">
							수량 {card.quantity} {card.base}
						</div>
					) : null}
					{card.lines.map((l) => (
						// 가격은 자르지 않는다 — 좁으면 줄을 바꾼다
						<div key={l.label} className="flex flex-wrap items-baseline gap-x-2 text-sm">
							<span className="shrink-0 text-faint">{l.label}</span>
							<span className="text-ink">{l.text}</span>
							{l.pct !== null && <span className="ml-auto text-[11px] text-faint">현재가 대비 {l.pct >= 0 ? "+" : ""}{l.pct}%</span>}
						</div>
					))}
				</div>
			)}
			<div className="mt-2 text-[11px] text-faint">
				{card.lastPrice ? `현재가 ${card.lastPrice} ${card.quote}` : ""}
				{card.balance ? ` · 잔고 ${card.balance.asset} ${card.balance.free}` : ""}
				{card.minNotional ? ` · 최소 주문 ${card.minNotional} ${card.quote}` : ""}
				{card.original ? ` · 원주문 #${card.original.orderId}` : ""}
			</div>
			<Warnings items={card.warnings} />
			<ConfirmBar c={c} verb={verb} />
		</div>
	);
}

function secondsLeft(expiresAt: number | null): number {
	if (!expiresAt) return 0;
	return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

// ── 주문 목록 ───────────────────────────────────────────────────────────

export function OrderListCardView({ card }: { card: OrderListCard }) {
	if (card.orders.length === 0) {
		return (
			<div className="mt-2 rounded-xl border border-line bg-inset px-4 py-3 text-xs text-muted">
				{card.status === "OPEN" ? "미체결 주문이 없습니다." : "주문 내역이 없습니다."}
			</div>
		);
	}

	return (
		<div className="mt-2 overflow-hidden rounded-xl border border-line bg-inset">
			<div className="px-4 py-2.5 text-xs text-muted">
				{card.status === "OPEN" ? "미체결" : "종료"} 주문 {card.orders.length}건
			</div>
			{card.orders.map((o) => (
				<div key={o.orderId} className="flex items-center justify-between border-t border-line px-4 py-2">
					<div className="min-w-0">
						<div className="truncate text-sm text-ink">
							{o.symbol} <span className={o.side === "BUY" ? "text-up" : "text-down"}>{o.side === "BUY" ? "매수" : "매도"}</span>
						</div>
						<div className="text-[11px] text-faint">
							{o.quantity}주 · {o.price ? Number(o.price).toLocaleString("ko-KR") : "시장가"} · {o.status}
						</div>
					</div>
					<div className="shrink-0 text-right text-[11px] text-muted">
						체결 {o.execution?.filledQuantity ?? "0"}
					</div>
				</div>
			))}
		</div>
	);
}
