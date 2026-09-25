/**
 * 외부 MCP 쓰기 확인 카드 (PLAN §39).
 *
 * ⚠️ [확인] 버튼이 TradingView 알림·관심목록 같은 외부 계정을 **실제로 바꾸는 유일한 경로**다.
 *    에이전트는 카드를 띄울 수만 있다 (주문 카드와 같은 원칙 — 뉴스·웹 본문의 지시문이 실행으로 이어지지 않게).
 */
import type { McpConfirmCard } from "@alphafolio/protocol";
import { api } from "../../lib/api.ts";
import { ConfirmBar, useConfirm, Warnings } from "./OrderCards.tsx";

/** 결과 한 줄 — 서버 응답은 길 수 있어 앞부분만 (전체는 챗에서 조회로) */
async function executeMcp(token: string): Promise<string> {
	const r = await api.executeMcp(token);
	const out = r.output.replace(/\s+/g, " ").trim();
	const text = `${r.message}${out ? ` — ${out.length > 300 ? `${out.slice(0, 299)}…` : out}` : ""}`;
	if (!r.ok) throw new Error(text);
	return text;
}

export function McpConfirmCardView({ card }: { card: McpConfirmCard }) {
	const c = useConfirm(card.token, card.expiresAt, true, executeMcp);
	const border = card.destructive ? "border-danger/60" : "border-accent/60";

	return (
		<div className={`mt-2 rounded-xl border-2 ${border} bg-inset p-4`}>
			<div className="flex items-baseline justify-between gap-3">
				<div className="min-w-0">
					<div className={`text-sm font-semibold ${card.destructive ? "text-danger" : "text-ink"}`}>{card.label ?? card.tool}</div>
					{card.label && <div className="truncate font-mono text-[11px] text-faint">{card.tool}</div>}
				</div>
				<span className="shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-muted">{card.server}</span>
			</div>
			{card.description && <div className="mt-1 text-xs text-muted">{card.description}</div>}

			{card.args.length > 0 ? (
				<dl className="mt-3 space-y-1.5 border-t border-line pt-2">
					{card.args.map((a) => (
						<div key={a.name} className="grid grid-cols-[minmax(0,7rem)_1fr] gap-2 text-xs">
							<dt className="min-w-0 text-faint" title={a.description ?? undefined}>
								<div className="truncate">{a.label ?? a.name}</div>
								{a.label && <div className="truncate font-mono text-[10px]">{a.name}</div>}
							</dt>
							{/* 값은 자르지 않고 줄을 바꾼다 — 무엇이 실행되는지 전부 보여야 한다 */}
							<dd className="min-w-0 font-mono break-all whitespace-pre-wrap text-ink">{a.value}</dd>
						</div>
					))}
				</dl>
			) : (
				<div className="mt-3 border-t border-line pt-2 text-xs text-faint">인자 없음</div>
			)}

			{card.notes.map((n) => (
				<p key={n} className="mt-2 text-[11px] text-faint">
					ℹ︎ {n}
				</p>
			))}
			<Warnings items={card.warnings} />
			<ConfirmBar c={c} verb={card.destructive ? "삭제·변경" : "실행"} />
		</div>
	);
}
