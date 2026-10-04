/** 보유 종목 기술적 점검 유스케이스. SDK·도구 스키마·채팅 출력에 의존하지 않는다. */
import { fetchPortfolio, type BrokerAccess } from "./portfolio.ts";
import { fetchChart } from "./quote.ts";
import { analyze } from "./indicators.ts";

export const PORTFOLIO_SIGNAL_LIMIT = 12;

export interface PortfolioSignalRow {
	symbol: string;
	name: string;
	currency: "KRW" | "USD";
	price: number;
	avgPrice: number;
	/** 평단 대비 % */
	vsAvgPct: number;
	trend: string;
	rsi: number | null;
	signals: string[];
}

export interface PortfolioInspection {
	rows: PortfolioSignalRow[];
	skipped: string[];
	warnings: string[];
	targetCount: number;
}

export async function inspectPortfolioSignals(brokers: BrokerAccess): Promise<PortfolioInspection> {
	const portfolio = await fetchPortfolio(brokers);
	const targets = portfolio.holdings.slice(0, PORTFOLIO_SIGNAL_LIMIT);
	const rows: PortfolioSignalRow[] = [];
	const skipped: string[] = [];

	// 순차 조회 — 브로커 레이트 리밋이 앱키 단위라 병렬로 쏴도 어차피 직렬화된다.
	for (const h of targets) {
		try {
			const chart = await fetchChart(brokers, h.symbol, "D");
			const snap = analyze(chart.bars);
			if (!snap) {
				skipped.push(`${h.name}(시세 없음)`);
				continue;
			}
			rows.push({
				symbol: h.symbol, name: h.name, currency: h.currency, price: snap.price, avgPrice: h.avgPrice,
				vsAvgPct: h.avgPrice > 0 ? Math.round(((snap.price - h.avgPrice) / h.avgPrice) * 1000) / 10 : 0,
				trend: snap.trend, rsi: snap.rsi, signals: snap.signals,
			});
		} catch (err) {
			skipped.push(`${h.name}(${err instanceof Error ? err.message.slice(0, 40) : "조회 실패"})`);
		}
	}
	if (portfolio.holdings.length > targets.length) {
		skipped.push(`외 ${portfolio.holdings.length - targets.length}종목은 생략`);
	}
	return { rows, skipped, warnings: portfolio.warnings, targetCount: targets.length };
}
