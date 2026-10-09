/**
 * 주문 카드.
 *
 * ⚠️ 이 컴포넌트의 [확인] 버튼이 **실제 주문이 나가는 유일한 경로**다.
 *    에이전트는 토큰이 담긴 카드를 띄울 수만 있고, 실행은 사람의 클릭이 한다.
 *    (외부 웹·뉴스 본문에 심긴 지시문이 주문으로 이어지지 않게 하는 장치)
 *
 * 모양은 styles.css 의 .confirm — 무엇을·어디로·얼마나·언제까지를 한 장에 (brand-spec 규칙 5).
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { BinanceOrderCard, BinanceTransferCard, CardOutcome, ConditionalOrderCard, OrderChangeCard, OrderPreviewCard } from "@alphafolio/protocol";
import { api } from "../../lib/api.ts";
import { AlertIcon, CheckIcon } from "../icons.tsx";

function money(value: number, currency: "KRW" | "USD"): string {
	return currency === "KRW"
		? `${Math.round(value).toLocaleString("ko-KR")}원`
		: `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

type Phase = "idle" | "sending" | "done" | "failed" | "expired" | "dismissed";

/** 서버가 기억하는 이 카드의 버튼 결과 — CardView 가 넣는다. 다시 열어도 실행·닫기 결과가 그대로 보인다 */
export const CardOutcomeContext = createContext<CardOutcome | undefined>(undefined);

/** 처음 그릴 상태 — 기록이 있으면 그 결과, 없으면 남은 시간으로 (지난 카드가 1초 동안 버튼을 보이지 않게) */
function initialPhase(saved: CardOutcome | undefined, expiresAt: number | null): Phase {
	if (saved) return saved.state;
	return secondsLeft(expiresAt) > 0 ? "idle" : "expired";
}

export const BROKER_LABEL = { toss: "토스", kis: "한국투자", binance: "Binance" } as const;

/** 어느 증권사로 나가는지 — 카드마다 눈에 띄게 (토스로 준비한 주문과 KIS 주문이 섞이지 않게) */
export function BrokerBadge({ broker }: { broker: "toss" | "kis" | "binance" }) {
	return <span className="badge">{BROKER_LABEL[broker]}</span>;
}

/** 주문 실행 — 결과 문장 (주문번호 앞 12자). note 는 매매일지의 근거 한 줄 */
async function executeOrder(token: string, note?: string): Promise<string> {
	const r = await api.executeOrder(token, note?.trim() || undefined);
	const id = r.orderId ?? r.conditionalOrderId;
	return `${r.message}${id ? ` (${id.slice(0, 12)}${id.length > 12 ? "…" : ""})` : ""}`;
}

/** 실행 결과 — 문장 하나, 또는 문장 + 카드가 따로 그릴 값 (MCP 결과 요약) */
export type ConfirmOutcome<D> = string | { text: string; detail: D };

/** 실패지만 카드가 따로 그릴 값이 있다 (MCP 서버가 거절한 이유·원본) */
export class ConfirmError<D> extends Error {
	readonly detail: D;
	constructor(message: string, detail: D) {
		super(message);
		this.detail = detail;
	}
}

/**
 * 확인 버튼·남은 시간·결과 — 신규·정정·취소·조건주문 카드, MCP 쓰기 카드(McpCards) 공용.
 * ⚠️ confirm() 이 서버로 토큰을 보내는 것이 **실행되는 유일한 경로**다. run 은 실패면 throw 한다.
 */
export function useConfirm<D = never>(
	token: string | null,
	expiresAt: number | null,
	ok: boolean,
	run: (token: string) => Promise<ConfirmOutcome<D>> = executeOrder,
) {
	const saved = useContext(CardOutcomeContext);
	const [phase, setPhase] = useState<Phase>(() => initialPhase(saved, expiresAt));
	const [message, setMessage] = useState<string | null>(saved?.message ?? null);
	const [detail, setDetail] = useState<D | null>((saved?.detail as D | undefined) ?? null);
	const [remain, setRemain] = useState(() => secondsLeft(expiresAt));
	/** 처음 본 남은 시간 — 만료 막대의 100% */
	const [total] = useState(() => Math.max(1, secondsLeft(expiresAt)));

	// 다른 탭·기기에서 처리한 결과가 기록으로 늦게 오면 따른다 (보내는 중이면 이 화면의 응답을 기다린다)
	useEffect(() => {
		if (!saved) return;
		setPhase((p) => (p === "sending" ? p : saved.state));
		setMessage(saved.message);
		setDetail((saved.detail as D | undefined) ?? null);
	}, [saved?.at]);

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
			const out = await run(token);
			setPhase("done");
			if (typeof out === "string") setMessage(out);
			else {
				setMessage(out.text);
				setDetail(out.detail);
			}
		} catch (err) {
			setPhase("failed");
			setMessage(err instanceof Error ? err.message : String(err));
			if (err instanceof ConfirmError) setDetail(err.detail as D);
		}
	}
	/** 실패 뒤 같은 토큰으로 다시 (서버가 토큰을 소비하지 않은 실패만 의미가 있다 — 감시 켜기의 한도 확인 등) */
	const retry = () => setPhase(secondsLeft(expiresAt) > 0 ? "idle" : "expired");
	/** 닫기 — 서버에도 남긴다 (다시 열어도 닫은 카드로) */
	const dismiss = () => {
		setPhase("dismissed");
		if (token) void api.dismissCard(token).catch(() => {});
	};
	return { phase, message, detail, remain, total, confirm, retry, dismiss };
}

type ConfirmState = Pick<ReturnType<typeof useConfirm>, "phase" | "message" | "remain" | "total" | "confirm" | "dismiss">;

const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * 확인 카드 틀 — 만료 막대 · 제목줄(종류·증권사·남은 시간) · 본문.
 * danger: 취소·청산·삭제처럼 되돌리기 어려운 동작 (테두리·막대·확인 버튼이 빨갛다).
 */
export function ConfirmCard({
	c,
	title,
	badges,
	danger = false,
	label,
	children,
}: {
	c: ConfirmState;
	title: ReactNode;
	badges?: ReactNode;
	danger?: boolean;
	/** 스크린리더용 이름 */
	label?: string;
	children: ReactNode;
}) {
	const live = c.phase === "idle" || c.phase === "sending";
	const state = c.phase === "done" ? "done" : live ? "" : "closed";
	return (
		<section className={`confirm ${danger ? "danger" : ""} ${state}`} aria-label={label}>
			{c.phase === "idle" && (
				<div className="expiry">
					<i style={{ width: `${Math.min(100, (c.remain / c.total) * 100)}%` }} />
				</div>
			)}
			<div className="c-h">
				<span className="title">{title}</span>
				{badges}
				{c.phase === "idle" && (
					<span className="left" aria-label="남은 확인 시간">
						{mmss(c.remain)} 후 만료
					</span>
				)}
				{(c.phase === "expired" || c.phase === "dismissed") && <span className="left">{c.phase === "expired" ? "만료됨" : "닫음"}</span>}
			</div>
			{children}
		</section>
	);
}

/** 카드 아래 — 확인·닫기 버튼과 결과. note 는 누르기 전 한 줄 안내 */
export function ConfirmBar({
	c,
	verb,
	note,
	danger = false,
	onRetry,
}: {
	c: ConfirmState;
	verb: string;
	note?: ReactNode;
	danger?: boolean;
	/** 있으면 실패 뒤 [다시 시도] — 같은 카드로 (감시 켜기: 한도를 정한 뒤) */
	onRetry?: () => void;
}) {
	return (
		<div className="c-f">
			{c.phase === "idle" && (
				<>
					<span className="note">{note}</span>
					<button className="btn btn-secondary" onClick={c.dismiss}>
						닫기
					</button>
					<button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={() => void c.confirm()}>
						{verb}
					</button>
				</>
			)}
			{c.phase === "sending" && (
				<>
					<span className="note">접수하는 중입니다.</span>
					<button className="btn btn-secondary" disabled>
						닫기
					</button>
					<button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled>
						<span className="spin" />
						접수 중…
					</button>
				</>
			)}
			{c.phase === "done" && (
				<span className="note ok">
					<span className="badge ok">
						<CheckIcon size={12} />
						완료
					</span>{" "}
					{c.message}
				</span>
			)}
			{c.phase === "failed" && (
				<>
					<span className="note bad">
						{c.message}
						{!onRetry && <span className="muted"> · 다시 하려면 챗에서 새로 요청하세요.</span>}
					</span>
					{onRetry && (
						<button className="btn btn-secondary btn-sm" onClick={onRetry}>
							다시 시도
						</button>
					)}
				</>
			)}
			{c.phase === "expired" && <span className="note">확인 시간이 지나 만료되었습니다. 필요하면 다시 요청하세요.</span>}
			{c.phase === "dismissed" && <span className="note">닫았습니다. 필요하면 다시 요청하세요.</span>}
		</div>
	);
}

/** 준비하지 못한 카드 — 토큰이 없으므로 버튼도 없다 */
export function Problems({ title, errors }: { title: string; errors: string[] }) {
	return (
		<div className="notice bad">
			<AlertIcon size={16} />
			<div className="min-w-0">
				<b>{title}</b>
				<ul>
					{errors.map((e) => (
						<li key={e}>{e}</li>
					))}
				</ul>
			</div>
		</div>
	);
}

export function Warnings({ items }: { items: string[] }) {
	if (items.length === 0) return null;
	return (
		<ul className="c-warnings">
			{items.map((w) => (
				<li key={w}>
					<AlertIcon size={13} />
					<span>{w}</span>
				</li>
			))}
		</ul>
	);
}

/** 매수·매도 표시 — 손익 색(상승 레드·하락 블루)과 같은 관례 */
export function SideTag({ side }: { side: "BUY" | "SELL" }) {
	return <span className={`side-tag ${side === "BUY" ? "buy" : "sell"}`}>{side === "BUY" ? "매수" : "매도"}</span>;
}

/** 키 — 값 한 줄. 값은 자르지 않고 줄을 바꾼다 */
export function Line({ k, children, r, tone }: { k: ReactNode; children: ReactNode; r?: ReactNode; tone?: "up" | "down" }) {
	return (
		<div className="c-line">
			<span className={`k ${tone ?? ""}`}>{k}</span>
			<span>{children}</span>
			{r && <span className="r">{r}</span>}
		</div>
	);
}

/**
 * 매매 근거 한 줄 (선택) — 주문과 함께 매매일지에 남는다 (PLAN §42). 주문 내용에는 영향이 없다.
 * 누르기 전에만 보인다 — 나간 뒤에는 일지 탭에서 고친다.
 */
export function JournalNote({ phase, value, onChange }: { phase: string; value: string; onChange: (v: string) => void }) {
	if (phase !== "idle") return null;
	return (
		<label className="c-journal">
			<span>매매 근거 (선택) — 매매일지에 남습니다</span>
			<input className="input input-sm" maxLength={1000} placeholder="예: 20일선 지지 확인, 실적 발표 전 분할 매수" value={value} onChange={(e) => onChange(e.target.value)} />
		</label>
	);
}

export function OrderPreviewCardView({ card }: { card: OrderPreviewCard }) {
	const [note, setNote] = useState("");
	const c = useConfirm(card.token, card.expiresAt, card.ok, (token) => executeOrder(token, note));
	const sideLabel = card.side === "BUY" ? "매수" : "매도";
	if (!card.ok) return <Problems title={`주문을 준비하지 못했습니다 — ${card.name}(${card.symbol})`} errors={card.errors} />;

	return (
		<ConfirmCard c={c} title={`${sideLabel} 주문 확인`} badges={<BrokerBadge broker={card.broker} />} label={`${sideLabel} 주문 확인`}>
			<div className="c-main">
				<div className="grow">
					<div className="sym">
						{card.name}
						<span className="mono">{card.symbol}</span>
						<SideTag side={card.side} />
					</div>
					<div className="how">
						{card.orderType === "LIMIT" ? `지정가 ${money(card.price ?? 0, card.currency)}` : "시장가"} × {card.quantity.toLocaleString("ko-KR")}주
					</div>
				</div>
				<div className="total">
					<small>예상 금액</small>
					<b>{money(card.estimatedAmount, card.currency)}</b>
				</div>
			</div>
			<Warnings items={card.warnings} />
			<JournalNote phase={c.phase} value={note} onChange={setNote} />
			<ConfirmBar c={c} verb="주문" note={`주문을 누르면 ${BROKER_LABEL[card.broker]}로 바로 전송됩니다.`} />
		</ConfirmCard>
	);
}

/** 정정(before → after)·취소 */
export function OrderChangeCardView({ card }: { card: OrderChangeCard }) {
	const c = useConfirm(card.token, card.expiresAt, card.ok);
	const o = card.original;
	const cancel = card.action === "cancel";
	if (!card.ok) return <Problems title={`${cancel ? "취소" : "정정"}을 준비하지 못했습니다 — ${card.name}(${card.symbol})`} errors={card.errors} />;
	const price = (v: number | null, t: string) => (t === "MARKET" || v === null ? "시장가" : money(v, card.currency));
	const same = <span className="muted"> (그대로)</span>;

	return (
		<ConfirmCard c={c} title={cancel ? "주문 취소 확인" : "주문 정정 확인"} badges={<BrokerBadge broker={card.broker} />} danger={cancel}>
			<div className="c-main">
				<div className="grow">
					<div className="sym">
						{card.name}
						<span className="mono">{card.symbol}</span>
						<SideTag side={o.side} />
					</div>
					{cancel && (
						<div className="how">
							미체결 {o.openQuantity.toLocaleString("ko-KR")}주 · {price(o.price, o.orderType)} 주문을 <b>취소</b>합니다
						</div>
					)}
				</div>
			</div>
			{!cancel && (
				<div className="c-sec c-lines">
					<Line k="가격">
						{price(o.price, o.orderType)}
						{card.after && (card.after.price !== o.price || card.after.orderType !== o.orderType) ? (
							<>
								{" "}
								→ <b>{price(card.after.price, card.after.orderType)}</b>
							</>
						) : (
							same
						)}
					</Line>
					<Line k="수량">
						{o.openQuantity.toLocaleString("ko-KR")}주
						{card.after && card.after.quantity !== o.openQuantity ? (
							<>
								{" "}
								→ <b>{card.after.quantity.toLocaleString("ko-KR")}주</b>
							</>
						) : (
							same
						)}
					</Line>
				</div>
			)}
			<div className="c-meta">
				원주문 <span className="mono">{o.orderId.length > 14 ? `${o.orderId.slice(0, 14)}…` : o.orderId}</span>
				{o.orderedAt ? ` · 접수 ${o.orderedAt}` : ""}
			</div>
			<Warnings items={card.warnings} />
			<ConfirmBar c={c} verb={cancel ? "취소" : "정정"} danger={cancel} />
		</ConfirmCard>
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
	const leg = (i: 0 | 1, l: NonNullable<ConditionalOrderCard["second"]>) => (
		<Line key={i} k={legName(i, l.side)} tone={l.side === "BUY" ? "up" : "down"} r={pct(l.triggerPrice)}>
			감시 {money(l.triggerPrice, card.currency)} → {l.orderPrice !== null ? `지정가 ${money(l.orderPrice, card.currency)}` : "시장가"}
		</Line>
	);

	return (
		<ConfirmCard
			c={c}
			title={`조건주문 ${verb}`}
			badges={
				<>
					<span className="badge">{typeLabel}</span>
					<BrokerBadge broker="toss" />
				</>
			}
			danger={card.action === "cancel"}
		>
			<div className="c-main">
				<div className="grow">
					<div className="sym">
						{card.name}
						<span className="mono">{card.symbol}</span>
					</div>
					<div className="how">수량 {card.quantity.toLocaleString("ko-KR")}주</div>
				</div>
			</div>
			<div className="c-sec c-lines">
				{leg(0, card.first)}
				{card.second && leg(1, card.second)}
			</div>
			<div className="c-meta">
				만료 {card.expireDate}
				{card.currentPrice ? ` · 현재가 ${money(card.currentPrice, card.currency)}` : ""}
				{card.action === "modify" ? " · 수정하면 조건주문 번호가 바뀝니다" : ""}
				{card.action === "cancel" ? " · 이 조건주문을 취소합니다" : ""}
			</div>
			<Warnings items={card.warnings} />
			<ConfirmBar c={c} verb={verb} danger={card.action === "cancel"} />
		</ConfirmCard>
	);
}

/** 끝자리 0 떼기 — Binance 는 "0.00100000" 처럼 준다 (값은 그대로, 표시만) */
const tz = (v: string): string => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);

const BINANCE_TITLE = { place: "주문 확인", cancel: "주문 취소", replace: "재주문", oco: "익절·손절 (OCO)", oto: "매수 후 매도 (OTO)", cancel_all: "미체결 전체 취소" } as const;

/** Binance 현물 — 신규·취소·재주문·OCO·OTO·전체 취소 (값은 거래소 단위로 보정된 문자열) */
export function BinanceOrderCardView({ card }: { card: BinanceOrderCard }) {
	const [note, setNote] = useState("");
	// 신규 주문만 일지에 남는다 — 취소·OCO 등은 근거를 받지 않는다
	const c = useConfirm(card.token, card.expiresAt, card.ok, (token) => executeOrder(token, card.action === "place" ? note : undefined));
	// 미국 주식 직접 거래 — 수량은 주, 대금은 USDC
	const stock = card.market === "stock";
	const pair = stock ? card.base : `${card.base}/${card.quote}`;
	const unit = stock ? "주" : ` ${card.base}`;
	const priceUnit = stock ? "USD" : card.quote;
	const verb = { place: "주문", cancel: "취소", replace: "재주문", oco: "등록", oto: "등록", cancel_all: "취소" }[card.action];
	if (!card.ok) return <Problems title={`Binance ${verb}을 준비하지 못했습니다 — ${pair}`} errors={card.errors} />;
	const danger = card.action === "cancel" || card.action === "cancel_all";
	const sideTitle = card.action === "place" && card.side ? `${card.side === "BUY" ? "매수" : "매도"} ` : "";

	return (
		<ConfirmCard c={c} title={`${sideTitle}${BINANCE_TITLE[card.action]}`} badges={<BrokerBadge broker="binance" />} danger={danger}>
			<div className="c-main">
				<div className="grow">
					<div className="sym">
						{pair}
						{stock && <span className="mono">미국 주식</span>}
						{(card.action === "place" || card.action === "replace") && card.side && <SideTag side={card.side} />}
					</div>
					{card.action === "place" && (
						<div className="how">
							{card.quantity ? `${card.quantity}${unit}` : `${card.quoteQuantity} ${card.quote} 어치`} ·{" "}
							{card.type === "LIMIT" ? (stock ? `지정가 $${card.price}` : `지정가 ${card.price} ${card.quote}`) : "시장가"}
						</div>
					)}
					{(card.action === "oco" || card.action === "oto") && (
						<div className="how">
							수량 {card.quantity} {card.base}
						</div>
					)}
					{card.action === "cancel" && card.original && (
						<div className="how">
							{card.original.side === "BUY" ? "매수" : "매도"} {tz(card.original.origQty)}
							{unit} @ {tz(card.original.price)} {priceUnit} 주문을 <b>취소</b>합니다
						</div>
					)}
					{card.action === "cancel_all" && (
						<div className="how">
							미체결 <b>{card.orders.length}건</b>을 모두 취소합니다
						</div>
					)}
				</div>
				{card.action === "place" && card.estimatedQuote && (
					<div className="total">
						<small>주문금액</small>
						<b>
							{card.estimatedQuote} <span className="text-sm font-semibold">{card.quote}</span>
						</b>
					</div>
				)}
			</div>

			{card.gap && card.side && <StockGapLine gap={card.gap} side={card.side} type={card.type} />}

			{card.action === "cancel_all" && card.orders.length > 0 && (
				<div className="c-sec c-lines">
					{card.orders.slice(0, 5).map((o) => (
						<Line key={o.orderId} k={o.side === "BUY" ? "매수" : "매도"} tone={o.side === "BUY" ? "up" : "down"}>
							{tz(o.origQty)}
							{unit} @ {tz(o.price)} {priceUnit}
							{stock ? ` (${String(o.orderId).slice(0, 8)})` : ""}
						</Line>
					))}
					{card.orders.length > 5 && <div className="muted">외 {card.orders.length - 5}건</div>}
				</div>
			)}

			{card.lines.length > 0 && (
				<div className="c-sec c-lines">
					{card.lines.map((l) => (
						<Line key={l.label} k={l.label} r={l.pct !== null ? `현재가 대비 ${l.pct >= 0 ? "+" : ""}${l.pct}%` : undefined}>
							{l.text}
						</Line>
					))}
				</div>
			)}

			<div className="c-meta">
				{[
					card.lastPrice ? `현재가 ${card.lastPrice} ${priceUnit}` : "",
					card.gap
						? `매수호가 ${card.gap.bid ?? "—"} / 매도호가 ${card.gap.ask ?? "—"}${card.gap.spreadPct !== null ? ` · 호가 폭 ${card.gap.spreadPct}%` : ""}`
						: "",
					card.balance ? `잔고 ${card.balance.asset} ${card.balance.free}` : "",
					card.minNotional ? `최소 주문 ${card.minNotional} ${card.quote}` : "",
					card.original ? `원주문 #${card.original.orderId}` : "",
				]
					.filter(Boolean)
					.join(" · ")}
			</div>
			<Warnings items={card.warnings} />
			{card.action === "place" && <JournalNote phase={c.phase} value={note} onChange={setNote} />}
			<ConfirmBar c={c} verb={verb} danger={danger} note={card.action === "place" ? "누르면 Binance 로 바로 전송됩니다." : undefined} />
		</ConfirmCard>
	);
}

/** 미국 주식 — 본주 대비. Binance 호가가 본주와 벌어지는 일이 잦다 (1% 이상 불리하면 빨갛게) */
function StockGapLine({ gap, side, type }: { gap: NonNullable<BinanceOrderCard["gap"]>; side: "BUY" | "SELL"; type: string | null }) {
	const verb = side === "BUY" ? "사면" : "팔면";
	const cost = (label: string, n: number) => (
		<Line k={label}>
			본주보다{" "}
			<b className={n >= 1 ? "danger-text" : ""}>
				{Math.abs(n)}% {n >= 0 ? "불리" : "유리"}
			</b>
		</Line>
	);
	return (
		<div className="c-sec c-lines">
			<Line k="본주">
				${gap.underlying} · 괴리{" "}
				<b>
					{gap.pct >= 0 ? "+" : ""}
					{gap.pct}%
				</b>
			</Line>
			{gap.marketCostPct !== null && cost(`시장가로 ${verb}`, gap.marketCostPct)}
			{type === "LIMIT" && gap.limitCostPct !== null && cost(`지정가로 ${verb}`, gap.limitCostPct)}
		</div>
	);
}

const WALLET_LABEL = { SPOT: "현물", FUNDING: "펀딩", EARN: "Earn 유연 예치", FUTURES: "선물(USDⓈ-M)" } as const;

/** Binance 지갑 간 이동 — 같은 계정 안 (현물·펀딩·Earn·선물). 외부 출금이 아니다 */
export function BinanceTransferCardView({ card }: { card: BinanceTransferCard }) {
	const c = useConfirm(card.token, card.expiresAt, card.ok);
	const route = `${WALLET_LABEL[card.from]} → ${WALLET_LABEL[card.to]}`;
	if (!card.ok) return <Problems title={`Binance 지갑 이동을 준비하지 못했습니다 — ${route}${card.asset ? ` ${card.asset}` : ""}`} errors={card.errors} />;

	return (
		<ConfirmCard c={c} title="지갑 이동 확인" badges={<BrokerBadge broker="binance" />}>
			<div className="c-main">
				<div className="grow">
					<div className="sym">
						{card.asset}
						<span className="mono">같은 계정 내부</span>
					</div>
					<div className="how">
						<b>{WALLET_LABEL[card.from]}</b> → <b>{WALLET_LABEL[card.to]}</b>
					</div>
				</div>
				<div className="total">
					<small>옮길 수량</small>
					<b>
						{card.all ? `전량 (약 ${card.amount})` : card.amount} <span className="text-sm font-semibold">{card.asset}</span>
					</b>
				</div>
			</div>
			<div className="c-meta">
				{[
					card.available ? `${WALLET_LABEL[card.from]} 이동 가능 ${card.available} ${card.asset}` : "",
					card.productId ? `Earn 상품 ${card.productId}` : "",
					card.api ?? "",
				]
					.filter(Boolean)
					.join(" · ")}
			</div>
			<Warnings items={card.warnings} />
			<ConfirmBar c={c} verb="옮기기" />
		</ConfirmCard>
	);
}

function secondsLeft(expiresAt: number | null): number {
	if (!expiresAt) return 0;
	return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}
