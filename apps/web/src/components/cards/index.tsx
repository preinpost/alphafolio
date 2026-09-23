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
import { ConditionalOrderCardView, OrderChangeCardView, OrderListCardView, OrderPreviewCardView } from "./OrderCards.tsx";

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
		case "overview-card":
			return <OverviewCardView card={card} />;
		default:
			return <LedgerCardView card={card} />;
	}
}
