/**
 * Binance USDⓈ-M 선물 확인 카드 — 진입·청산·익절손절·취소·전체 취소·종목 설정.
 *
 * ⚠️ [확인] 버튼이 실제 주문이 나가는 유일한 경로다 (OrderCards 의 useConfirm 공용).
 *    레버리지·증거금 방식·예상 청산가·손절 유무를 눈에 띄게 — 선물은 잃을 수 있는 돈이 증거금 전부다.
 */
import type { BinanceFuturesCard } from "@alphafolio/protocol";
import { BrokerBadge, ConfirmBar, Problems, useConfirm, Warnings } from "./OrderCards.tsx";

/** 끝자리 0 떼기 (표시만) */
const tz = (v: string): string => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);
const abs = (v: string): string => tz(v.replace(/^-/, ""));

const VERB = { open: "진입", close: "청산", tpsl: "등록", cancel: "취소", cancel_all: "취소", settings: "변경" } as const;
const TITLE = { open: "진입", close: "청산", tpsl: "익절·손절", cancel: "주문 취소", cancel_all: "미체결 전체 취소", settings: "종목 설정" } as const;

function DirectionLabel({ d }: { d: "LONG" | "SHORT" | null }) {
	if (!d) return null;
	return <span className={d === "LONG" ? "text-up" : "text-down"}>{d === "LONG" ? "롱" : "숏"}</span>;
}

function Row({ label, children, strong = false }: { label: string; children: React.ReactNode; strong?: boolean }) {
	return (
		<div className="flex flex-wrap items-baseline gap-x-2 text-sm">
			<span className="shrink-0 text-faint">{label}</span>
			<span className={strong ? "font-medium text-ink" : "text-ink"}>{children}</span>
		</div>
	);
}

export function BinanceFuturesCardView({ card }: { card: BinanceFuturesCard }) {
	const c = useConfirm(card.token, card.expiresAt, card.ok);
	const pair = `${card.symbol} 선물`;
	if (!card.ok) return <Problems title={`Binance 선물 ${TITLE[card.action]}을(를) 준비하지 못했습니다 — ${card.symbol}`} errors={card.errors} />;
	const danger = card.action !== "settings" && card.action !== "tpsl";
	const m = card.marginAsset;

	return (
		<div className={`mt-2 rounded-xl border-2 bg-inset p-4 ${danger ? "border-danger/50" : "border-accent/60"}`}>
			<div className="flex items-center justify-between gap-3">
				<span className="truncate text-sm font-semibold text-ink">
					{pair} <span className="text-xs font-normal text-muted">{TITLE[card.action]}</span>
				</span>
				<BrokerBadge broker="binance" />
			</div>

			<div className="mt-2 space-y-1">
				{card.action === "open" && (
					<>
						<div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
							<span>
								<DirectionLabel d={card.direction} /> {card.quantity} {card.base} · {card.type === "LIMIT" ? `지정가 ${card.price}` : "시장가"}
							</span>
							<b className="text-ink">
								{card.leverage}x {card.marginType === "ISOLATED" ? "격리" : "교차"}
							</b>
						</div>
						{card.notional && (
							<Row label="크기·증거금">
								약 {Number(card.notional).toFixed(2)} {m} · 증거금 약 <b>{card.margin}</b> {m}
								{card.available ? ` (주문 가능 ${tz(card.available)})` : ""}
							</Row>
						)}
						{card.liqPrice && (
							<Row label="예상 청산가" strong>
								{card.liqPrice}
							</Row>
						)}
					</>
				)}
				{(card.action === "close" || card.action === "tpsl") && card.position && (
					<Row label="포지션">
						<DirectionLabel d={card.direction} /> {abs(card.position.amt)} {card.base} · 진입 {tz(card.position.entryPrice)} · 미실현{" "}
						<span className={Number(card.position.unrealized) >= 0 ? "text-up" : "text-down"}>{tz(card.position.unrealized)}</span> {m}
						{Number(card.position.liquidationPrice) > 0 ? ` · 청산가 ${tz(card.position.liquidationPrice)}` : ""}
					</Row>
				)}
				{card.action === "close" && (
					<Row label="청산" strong>
						{card.quantity} {card.base} · {card.type === "LIMIT" ? `지정가 ${card.price}` : "시장가"}
					</Row>
				)}
				{(card.stopLossPrice || card.takeProfitPrice) && (
					<Row label="익절·손절">
						{card.stopLossPrice ? <span className="text-down">손절 {card.stopLossPrice}</span> : <span className="text-danger">손절 없음</span>}
						{card.takeProfitPrice ? <span className="text-up"> · 익절 {card.takeProfitPrice}</span> : null}
						<span className="text-[11px] text-faint"> (표시가격 기준, 포지션 전체 시장가)</span>
					</Row>
				)}
				{(card.action === "cancel" || card.action === "cancel_all") && (
					<div className="text-sm text-ink">
						{card.action === "cancel_all" ? (
							<>
								미체결 <b>{card.orders.length}건</b>을 모두 취소합니다
							</>
						) : (
							"아래 주문을 취소합니다"
						)}
						<ul className="mt-1 space-y-0.5 text-xs text-muted">
							{card.orders.slice(0, 6).map((o) => (
								<li key={`${o.source}${o.id}`}>
									· {o.side === "BUY" ? "매수" : "매도"} {o.type} {o.closePosition ? "포지션 전체" : tz(o.quantity)}
									{Number(o.price) > 0 ? ` @ ${tz(o.price)}` : ""}
									{o.triggerPrice ? ` · 트리거 ${tz(o.triggerPrice)}` : ""} ({o.source === "algo" ? "조건부" : "일반"} #{o.id})
								</li>
							))}
							{card.orders.length > 6 && <li>· 외 {card.orders.length - 6}건</li>}
						</ul>
					</div>
				)}
				{card.lines.map((l) => (
					<Row key={l.label} label={l.label}>
						{l.text}
					</Row>
				))}
			</div>

			<div className="mt-2 text-[11px] text-faint">{card.markPrice ? `표시가격 ${tz(card.markPrice)} ${m}` : ""}</div>
			<Warnings items={card.warnings} />
			<ConfirmBar c={c} verb={VERB[card.action]} />
		</div>
	);
}
