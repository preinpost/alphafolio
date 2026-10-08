/**
 * Binance USDⓈ-M 선물 확인 카드 — 진입·청산·익절손절·취소·전체 취소·종목 설정.
 *
 * ⚠️ [확인] 버튼이 실제 주문이 나가는 유일한 경로다 (OrderCards 의 useConfirm 공용).
 *    레버리지·증거금 방식·예상 청산가·손절 유무를 눈에 띄게 — 선물은 잃을 수 있는 돈이 증거금 전부다.
 */
import type { BinanceFuturesCard } from "@alphafolio/protocol";
import { BrokerBadge, ConfirmBar, ConfirmCard, Line, Problems, useConfirm, Warnings } from "./OrderCards.tsx";

/** 끝자리 0 떼기 (표시만) */
const tz = (v: string): string => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);
const abs = (v: string): string => tz(v.replace(/^-/, ""));

const VERB = { open: "진입", close: "청산", tpsl: "등록", cancel: "취소", cancel_all: "취소", settings: "변경" } as const;
const TITLE = { open: "진입", close: "청산", tpsl: "익절·손절", cancel: "주문 취소", cancel_all: "미체결 전체 취소", settings: "종목 설정" } as const;

function DirectionLabel({ d }: { d: "LONG" | "SHORT" | null }) {
	if (!d) return null;
	return <span className={`side-tag ${d === "LONG" ? "buy" : "sell"}`}>{d === "LONG" ? "롱" : "숏"}</span>;
}

export function BinanceFuturesCardView({ card }: { card: BinanceFuturesCard }) {
	const c = useConfirm(card.token, card.expiresAt, card.ok);
	if (!card.ok) return <Problems title={`Binance 선물 ${TITLE[card.action]}을(를) 준비하지 못했습니다 — ${card.symbol}`} errors={card.errors} />;
	const danger = card.action !== "settings" && card.action !== "tpsl";
	const m = card.marginAsset;

	return (
		<ConfirmCard c={c} title={`선물 ${TITLE[card.action]}`} badges={<BrokerBadge broker="binance" />} danger={danger}>
			<div className="c-main">
				<div className="grow">
					<div className="sym">
						{card.symbol}
						<span className="mono">USDⓈ-M 선물</span>
						<DirectionLabel d={card.direction} />
					</div>
					{card.action === "open" && (
						<div className="how">
							{card.quantity} {card.base} · {card.type === "LIMIT" ? `지정가 ${card.price}` : "시장가"}
						</div>
					)}
					{card.action === "close" && (
						<div className="how">
							청산 {card.quantity} {card.base} · {card.type === "LIMIT" ? `지정가 ${card.price}` : "시장가"}
						</div>
					)}
				</div>
				{card.action === "open" && (
					<div className="total">
						<small>레버리지</small>
						<b>
							{card.leverage}x <span className="text-sm font-semibold">{card.marginType === "ISOLATED" ? "격리" : "교차"}</span>
						</b>
					</div>
				)}
			</div>

			<div className="c-sec c-lines">
				{card.action === "open" && card.notional && (
					<Line k="크기·증거금">
						약 {Number(card.notional).toFixed(2)} {m} · 증거금 약 <b>{card.margin}</b> {m}
						{card.available ? ` (주문 가능 ${tz(card.available)})` : ""}
					</Line>
				)}
				{card.action === "open" && card.liqPrice && (
					<Line k="예상 청산가">
						<b>{card.liqPrice}</b>
					</Line>
				)}
				{(card.action === "close" || card.action === "tpsl") && card.position && (
					<Line k="포지션">
						{abs(card.position.amt)} {card.base} · 진입 {tz(card.position.entryPrice)} · 미실현{" "}
						<span className={Number(card.position.unrealized) >= 0 ? "up" : "down"}>{tz(card.position.unrealized)}</span> {m}
						{Number(card.position.liquidationPrice) > 0 ? ` · 청산가 ${tz(card.position.liquidationPrice)}` : ""}
					</Line>
				)}
				{(card.stopLossPrice || card.takeProfitPrice || card.action === "open") && (
					<Line k="익절·손절" r="표시가격 기준, 포지션 전체 시장가">
						{card.stopLossPrice ? <span className="down">손절 {card.stopLossPrice}</span> : <b className="danger-text">손절 없음</b>}
						{card.takeProfitPrice ? <span className="up"> · 익절 {card.takeProfitPrice}</span> : null}
					</Line>
				)}
				{(card.action === "cancel" || card.action === "cancel_all") && (
					<>
						<div>
							{card.action === "cancel_all" ? (
								<>
									미체결 <b>{card.orders.length}건</b>을 모두 취소합니다
								</>
							) : (
								"아래 주문을 취소합니다"
							)}
						</div>
						{card.orders.slice(0, 6).map((o) => (
							<Line key={`${o.source}${o.id}`} k={o.side === "BUY" ? "매수" : "매도"} tone={o.side === "BUY" ? "up" : "down"} r={`${o.source === "algo" ? "조건부" : "일반"} #${o.id}`}>
								{o.type} {o.closePosition ? "포지션 전체" : tz(o.quantity)}
								{Number(o.price) > 0 ? ` @ ${tz(o.price)}` : ""}
								{o.triggerPrice ? ` · 트리거 ${tz(o.triggerPrice)}` : ""}
							</Line>
						))}
						{card.orders.length > 6 && <div className="muted">외 {card.orders.length - 6}건</div>}
					</>
				)}
				{card.lines.map((l) => (
					<Line key={l.label} k={l.label}>
						{l.text}
					</Line>
				))}
			</div>

			{card.markPrice && (
				<div className="c-meta">
					표시가격 {tz(card.markPrice)} {m}
				</div>
			)}
			<Warnings items={card.warnings} />
			<ConfirmBar c={c} verb={VERB[card.action]} danger={danger} />
		</ConfirmCard>
	);
}
