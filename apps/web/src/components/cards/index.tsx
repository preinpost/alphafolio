/**
 * 툴 결과 details → 카드 렌더러 디스패처.
 *
 * 툴은 content(LLM이 읽는 텍스트)에 집계만 넣고 원시 목록은 details 로 보낸다.
 * 여기서 그 details 를 사람이 보는 형태로 그린다 (PLAN.md §7.4).
 */
import type { UICard } from "@alphafolio/protocol";
import { LedgerCardView } from "./LedgerCards.tsx";
import {
	FinancialsCardView,
	HoldingsCardView,
	MoversCardView,
	NewsCardView,
	PortfolioSignalsCardView,
	OverviewCardView,
	QuoteCardView,
	TechnicalCardView,
	TimingCardView,
	ResearchCardView,
} from "./BrokerCards.tsx";
import { McpConfirmCardView } from "./McpCards.tsx";
import { WatchConfirmCardView } from "./WatchCards.tsx";
import { BinanceOrderCardView, ConditionalOrderCardView, OrderChangeCardView, OrderListCardView, OrderPreviewCardView } from "./OrderCards.tsx";

export function CardView({ card }: { card: UICard }) {
	switch (card.kind) {
		case "quote-card":
			return <QuoteCardView card={card} />;
		case "technical-card":
			return <TechnicalCardView card={card} />;
		case "research-card":
			return <ResearchCardView card={card} />;
		case "timing-card":
			return <TimingCardView card={card} />;
		case "portfolio-signals-card":
			return <PortfolioSignalsCardView card={card} />;
		case "financials-card":
			return <FinancialsCardView card={card} />;
		case "holdings-card":
			return <HoldingsCardView card={card} />;
		case "movers-card":
			return <MoversCardView card={card} />;
		case "news-card":
			return <NewsCardView card={card} />;
		case "order-preview-card":
			return <OrderPreviewCardView card={card} />;
		case "order-list-card":
			return <OrderListCardView card={card} />;
		case "order-change-card":
			return <OrderChangeCardView card={card} />;
		case "conditional-order-card":
			return <ConditionalOrderCardView card={card} />;
		case "binance-order-card":
			return <BinanceOrderCardView card={card} />;
		case "watch-confirm-card":
			return <WatchConfirmCardView card={card} />;
		case "mcp-confirm-card":
			return <McpConfirmCardView card={card} />;
		case "overview-card":
			return <OverviewCardView card={card} />;
		default:
			// 가계부 카드만 여기로. 모르는 종류를 가계부 렌더러에 넘기면 **조용히 빈칸**이 된다 —
			// 서버가 새 카드를 보냈는데 화면이 옛 번들인 경우 (서비스워커 캐시, 실측 2026-09-25)
			if (card.kind.startsWith("ledger-")) return <LedgerCardView card={card} />;
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
