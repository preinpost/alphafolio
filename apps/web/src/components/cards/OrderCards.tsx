/**
 * 주문 카드.
 *
 * ⚠️ 이 컴포넌트의 [확인] 버튼이 **실제 주문이 나가는 유일한 경로**다.
 *    에이전트는 토큰이 담긴 카드를 띄울 수만 있고, 실행은 사람의 클릭이 한다.
 *    (외부 웹·뉴스 본문에 심긴 지시문이 주문으로 이어지지 않게 하는 장치)
 */
import { useEffect, useState } from "react";
import type { OrderListCard, OrderPreviewCard } from "@alphafolio/protocol";
import { api } from "../../lib/api.ts";

function money(value: number, currency: "KRW" | "USD"): string {
	return currency === "KRW"
		? `${Math.round(value).toLocaleString("ko-KR")}원`
		: `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

type Phase = "idle" | "sending" | "done" | "failed" | "expired";

export function OrderPreviewCardView({ card }: { card: OrderPreviewCard }) {
	const [phase, setPhase] = useState<Phase>("idle");
	const [message, setMessage] = useState<string | null>(null);
	const [remain, setRemain] = useState(() => secondsLeft(card.expiresAt));

	// 남은 시간 표시 — 토큰은 2분이라 사용자가 흐름을 알 수 있어야 한다
	useEffect(() => {
		if (!card.ok || phase !== "idle") return;
		const id = setInterval(() => {
			const left = secondsLeft(card.expiresAt);
			setRemain(left);
			if (left <= 0) setPhase("expired");
		}, 1000);
		return () => clearInterval(id);
	}, [card.ok, card.expiresAt, phase]);

	const sideLabel = card.side === "BUY" ? "매수" : "매도";
	const sideClass = card.side === "BUY" ? "text-up" : "text-down";

	if (!card.ok) {
		return (
			<div className="mt-2 rounded-xl border border-danger/50 bg-inset p-4">
				<div className="text-sm font-medium text-ink">
					주문을 준비하지 못했습니다 — {card.name}({card.symbol})
				</div>
				<ul className="mt-2 space-y-1">
					{card.errors.map((e) => (
						<li key={e} className="text-xs text-danger">
							· {e}
						</li>
					))}
				</ul>
			</div>
		);
	}

	async function confirm(): Promise<void> {
		if (!card.token) return;
		setPhase("sending");
		try {
			const r = await api.executeOrder(card.token);
			setPhase("done");
			setMessage(`주문이 접수되었습니다 (${r.orderId.slice(0, 10)}…)`);
		} catch (err) {
			setPhase("failed");
			setMessage(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<div className="mt-2 rounded-xl border-2 border-accent/60 bg-inset p-4">
			<div className="flex items-baseline justify-between gap-3">
				<div className="min-w-0">
					<div className="truncate text-sm font-semibold text-ink">
						{card.name} <span className="text-xs font-normal text-faint">{card.symbol}</span>
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

			{card.warnings.length > 0 && (
				<ul className="mt-3 space-y-1 border-t border-line pt-2">
					{card.warnings.map((w) => (
						<li key={w} className="text-xs text-muted">
							⚠️ {w}
						</li>
					))}
				</ul>
			)}

			<div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
				{phase === "idle" && (
					<>
						<button
							onClick={() => void confirm()}
							className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition active:scale-95"
						>
							확인하고 주문
						</button>
						<button onClick={() => setPhase("expired")} className="px-3 py-2 text-sm text-muted">
							취소
						</button>
						<span className="ml-auto text-[11px] text-faint">{remain}초 후 만료</span>
					</>
				)}
				{phase === "sending" && <span className="text-sm text-muted">주문 접수 중…</span>}
				{phase === "done" && <span className="text-sm text-success">{message}</span>}
				{phase === "failed" && (
					<div className="text-sm text-danger">
						{message}
						<div className="mt-1 text-[11px] text-faint">다시 주문하려면 챗에서 새로 요청하세요.</div>
					</div>
				)}
				{phase === "expired" && (
					<span className="text-sm text-muted">확인이 취소되었습니다. 필요하면 다시 요청하세요.</span>
				)}
			</div>
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
