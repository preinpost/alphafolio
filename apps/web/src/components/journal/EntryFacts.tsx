import type { JournalEntryDto } from "@alphafolio/protocol";
import type { ReactNode } from "react";
import { BROKER_LABEL, money, pnlText, SOURCE_LABEL, tradeText } from "../../lib/journal.ts";
import { StatusBadge } from "./EntryList.tsx";

/** 계좌·앱에서 들어온 기록의 체결 사실 — 고칠 수 없다 */
export function EntryFacts({ editing, onOpenConversation }: { editing: JournalEntryDto; onOpenConversation: (id: string) => void }) {
	const ctx = editing.context;
	return (
		<div className="jr-facts">
			<Fact k="체결">
				{tradeText(editing)} <StatusBadge e={editing} />
			</Fact>
			<Fact k="날짜">
				{editing.date} {new Date(editing.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
			</Fact>
			<Fact k="계좌">
				{BROKER_LABEL[editing.broker]} · {SOURCE_LABEL[editing.source]}
			</Fact>
			{pnlText(editing) && <Fact k="실현손익">{pnlText(editing)} (Binance 계산 · 수수료·펀딩비 제외)</Fact>}
			{editing.fee !== null && <Fact k="수수료·세금">{money(editing.fee, editing.currency)}</Fact>}
			{ctx?.orderType && (
				<Fact k="주문">
					{ctx.orderType === "LIMIT" ? `지정가${ctx.limitPrice ? ` ${money(ctx.limitPrice, editing.currency)}` : ""}` : "시장가"}
					{ctx.ordered ? ` × ${ctx.ordered}` : ""}
				</Fact>
			)}
			{ctx?.trigger && (
				<Fact k="감시">
					{ctx.trigger}
					{ctx.leg === "stop" ? " · 손절" : ctx.leg === "take" ? " · 익절" : ""}
					{ctx.condition && <span className="muted"> — {ctx.condition}</span>}
				</Fact>
			)}
			{ctx?.slippageBps !== undefined && ctx.slippageBps !== null && <Fact k="슬리피지">{ctx.slippageBps}bp (신호 때 중간가 대비)</Fact>}
			{editing.status === "pending" && <p className="field-hint">체결은 [가져오기]가 증권사에서 확인해 채웁니다.</p>}
			{editing.conversationId && (
				<button type="button" className="text-link text-[13px]" onClick={() => onOpenConversation(editing.conversationId!)}>
					주문을 준비한 대화 보기
				</button>
			)}
		</div>
	);
}

function Fact({ k, children }: { k: string; children: ReactNode }) {
	return (
		<div className="jr-fact">
			<span className="k">{k}</span>
			<span>{children}</span>
		</div>
	);
}
