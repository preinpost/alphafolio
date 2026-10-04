/**
 * 브로커 도구 조립. 공개 진입점·이름·등록 순서는 유지한다.
 * 자격증명은 실행 시점에 해석하고, 주문은 준비만 한다.
 * 조회·분석·포트폴리오·주문 준비·범용 조회의 구현은 tools/ 아래에 둔다.
 */
import type { BrokerToolDeps } from "./tools/contracts.ts";
import { createMarketTools } from "./tools/market.ts";
import { createAnalysisTools } from "./tools/analysis.ts";
import { createPortfolioTools } from "./tools/portfolio.ts";
import { createStockOrderTools } from "./tools/stock-orders.ts";
import { createGatewayTools } from "./tools/gateways.ts";

export type * from "./tools/contracts.ts";
export { renderTiming } from "./tools/analysis.ts";
export { currentMonthKST } from "@alphafolio/ledger";

export function createBrokerTools(deps: BrokerToolDeps) {
	const market = createMarketTools(deps);
	const analysis = createAnalysisTools(deps);
	const portfolio = createPortfolioTools(deps);
	const orders = createStockOrderTools(deps);
	const gateways = createGatewayTools(deps);
	return [
		market.marketPrice, market.marketTechnical, analysis.marketTiming, analysis.stockResearch,
		market.marketMovers, market.marketNews, market.marketOverseasNews, analysis.marketFinancials,
		portfolio.portfolioHoldings, portfolio.portfolioSignals, portfolio.financeOverview,
		orders.orderPrepare, orders.orderList, gateways.kisFind, gateways.kisCall, gateways.tossQuery,
	];
}

export const BROKER_TOOL_NAMES = [
	"market_price",
	"market_technical",
	"market_timing",
	"stock_research",
	"market_movers",
	"market_news",
	"market_overseas_news",
	"market_financials",
	"portfolio_holdings",
	"portfolio_signals",
	"finance_overview",
	"order_prepare",
	"order_list",
	"kis_find",
	"kis_call",
	"toss_query",
] as const;
