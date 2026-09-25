/**
 * 외부 MCP 쓰기 확인 카드 (PLAN §39).
 *
 * ⚠️ [확인] 버튼이 TradingView 알림·관심목록 같은 외부 계정을 **실제로 바꾸는 유일한 경로**다.
 *    에이전트는 카드를 띄울 수만 있다 (주문 카드와 같은 원칙 — 뉴스·웹 본문의 지시문이 실행으로 이어지지 않게).
 *
 * 실행 결과는 요약 줄(알림 id·조건·만료…)로 보여 주고, 원본 응답은 접어 둔다 — 서버 응답 JSON 을 그대로 늘어놓지 않는다.
 */
import type { McpConfirmCard } from "@alphafolio/protocol";
import { api, type McpExecuteResult } from "../../lib/api.ts";
import { ConfirmBar, ConfirmError, useConfirm, Warnings, type ConfirmOutcome } from "./OrderCards.tsx";

async function executeMcp(token: string): Promise<ConfirmOutcome<McpExecuteResult>> {
	const r = await api.executeMcp(token);
	if (!r.ok) throw new ConfirmError(r.message, r);
	return { text: r.message, detail: r };
}

/** 이름 — 값 두 칸 (인자·결과 공용) */
function Rows({ rows }: { rows: Array<{ key: string; label: string; value: string; title?: string | undefined }> }) {
	return (
		<dl className="space-y-1.5">
			{rows.map((r) => (
				<div key={r.key} className="grid grid-cols-[minmax(0,6.5rem)_1fr] gap-3 text-xs">
					<dt className="truncate text-faint" title={r.title}>
						{r.label}
					</dt>
					{/* 값은 자르지 않고 줄을 바꾼다 — 무엇이 실행되는지 전부 보여야 한다 */}
					<dd className="min-w-0 break-words whitespace-pre-wrap text-ink tabular-nums">{r.value}</dd>
				</div>
			))}
		</dl>
	);
}

function Result({ r }: { r: McpExecuteResult }) {
	if (r.summary.length === 0 && !r.detail && !r.raw) return null;
	return (
		<div className="mt-2 space-y-2">
			{r.summary.length > 0 && <Rows rows={r.summary.map((s, i) => ({ key: `${i}`, label: s.label, value: s.value }))} />}
			{r.detail && <p className={`text-xs break-words ${r.ok ? "text-muted" : "text-danger"}`}>{r.detail}</p>}
			{r.raw && (r.summary.length > 0 || r.raw !== r.detail) && (
				<details className="text-[11px] text-faint">
					<summary className="cursor-pointer select-none">원본 응답</summary>
					<pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-card p-2 font-mono break-all whitespace-pre-wrap">{r.raw}</pre>
				</details>
			)}
		</div>
	);
}

export function McpConfirmCardView({ card }: { card: McpConfirmCard }) {
	const c = useConfirm<McpExecuteResult>(card.token, card.expiresAt, true, executeMcp);
	const border = card.destructive ? "border-danger/60" : "border-accent/60";

	return (
		<div className={`mt-2 rounded-xl border-2 ${border} bg-inset p-4`}>
			<div className="flex items-baseline justify-between gap-3">
				{/* 툴 이름·서버 설명(영문)은 제목에 마우스를 올리면 */}
				<div
					className={`min-w-0 text-sm font-semibold ${card.destructive ? "text-danger" : "text-ink"}`}
					title={[card.tool, card.description].filter(Boolean).join("\n")}
				>
					{card.label ?? card.tool}
				</div>
				<span className="shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-muted">{card.server}</span>
			</div>
			{/* 한글 이름이 없는 툴(프리셋 밖)은 무엇을 하는지 설명이라도 보여야 한다 */}
			{!card.label && card.description && <div className="mt-1 text-xs text-muted">{card.description}</div>}

			<div className="mt-3 border-t border-line pt-3">
				{card.args.length > 0 ? (
					<Rows
						rows={card.args.map((a) => ({
							key: a.name,
							label: a.label ?? a.name,
							value: a.value,
							title: [a.name, a.description].filter(Boolean).join(" — "),
						}))}
					/>
				) : (
					<div className="text-xs text-faint">인자 없음</div>
				)}
			</div>

			{c.phase === "idle" &&
				card.notes.map((n) => (
					<p key={n} className="mt-3 text-[11px] text-faint">
						{n}
					</p>
				))}
			<Warnings items={card.warnings} />
			<ConfirmBar c={c} verb={card.destructive ? "삭제·변경" : "실행"} />
			{c.detail && <Result r={c.detail} />}
		</div>
	);
}
