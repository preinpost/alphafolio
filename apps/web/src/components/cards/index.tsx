/**
 * 툴 결과 details → 카드 렌더러 디스패처.
 *
 * 카드는 **확인 다이얼로그뿐**이다 — 사람이 [확인]·[취소] 를 눌러야 실행되는 주문·감시·외부 MCP 쓰기.
 * 조회 결과(시세·지표·보유·가계부 등)는 카드 없이 답변 텍스트로만 보인다 (serialize.ts 가 걸러 보낸다).
 */
import type { CardOutcome, UICard } from "@alphafolio/protocol";
import { BinanceFuturesCardView } from "./FuturesCards.tsx";
import { McpConfirmCardView } from "./McpCards.tsx";
import { WatchConfirmCardView } from "./WatchCards.tsx";
import { BinanceOrderCardView, BinanceTransferCardView, CardOutcomeContext, ConditionalOrderCardView, OrderChangeCardView, OrderPreviewCardView } from "./OrderCards.tsx";

/** outcome — 서버가 기억하는 버튼 결과 (실행·실패·닫기). 카드의 useConfirm 이 처음 상태로 쓴다 */
export function CardView({ card, outcome }: { card: UICard; outcome?: CardOutcome | undefined }) {
	return (
		<CardOutcomeContext.Provider value={outcome}>
			<CardBody card={card} />
		</CardOutcomeContext.Provider>
	);
}

function CardBody({ card }: { card: UICard }) {
	switch (card.kind) {
		case "order-preview-card":
			return <OrderPreviewCardView card={card} />;
		case "order-change-card":
			return <OrderChangeCardView card={card} />;
		case "conditional-order-card":
			return <ConditionalOrderCardView card={card} />;
		case "binance-order-card":
			return <BinanceOrderCardView card={card} />;
		case "binance-transfer-card":
			return <BinanceTransferCardView card={card} />;
		case "binance-futures-card":
			return <BinanceFuturesCardView card={card} />;
		case "watch-confirm-card":
			return <WatchConfirmCardView card={card} />;
		case "mcp-confirm-card":
			return <McpConfirmCardView card={card} />;
		default:
			// 서버가 새 확인 카드를 보냈는데 화면이 옛 번들인 경우 (서비스워커 캐시, 실측 2026-09-25) —
			// 조용히 빈칸이 되면 확인할 방법이 없다
			return <UnknownCardView kind={(card as { kind: string }).kind} />;
	}
}

function UnknownCardView({ kind }: { kind: string }) {
	return (
		<div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-line bg-inset px-4 py-3 text-xs text-muted">
			<span>이 카드는 새 버전에서 보입니다 ({kind}).</span>
			<button onClick={() => location.reload()} className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-ink">
				새로고침
			</button>
		</div>
	);
}
