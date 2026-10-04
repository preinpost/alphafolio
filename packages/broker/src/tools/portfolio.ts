/** 보유 종목·자산 현황·보유 종목 점검 툴. */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { ensureMigrated, resolveLedger, resolvePeriod, summary as ledgerSummary } from "@alphafolio/ledger";
import { fetchPortfolio } from "../portfolio.ts";
import { inspectPortfolioSignals } from "../portfolio-signals.ts";
import type { BrokerToolDeps, HoldingsDetails, OverviewDetails, PortfolioSignalsDetails } from "./contracts.ts";
import { won, usdCash, cashText, money, signed } from "./format.ts";

const PERIOD_ENUM = Type.Union(
	[
		Type.Literal("today"),
		Type.Literal("yesterday"),
		Type.Literal("this_week"),
		Type.Literal("this_month"),
		Type.Literal("last_month"),
		Type.Literal("last_7d"),
		Type.Literal("last_30d"),
		Type.Literal("this_year"),
	],
	{ description: "조회 기간 (기본 this_month)" },
);

export function createPortfolioTools(deps: BrokerToolDeps) {
	const portfolioHoldings = defineTool({
		name: "portfolio_holdings",
		label: "보유 종목",
		description:
			"증권 계좌의 보유 종목과 평가금액을 조회한다 (KIS·토스 모두, 국내+해외, 원화 환산). " +
			"'내 주식', '얼마 벌었어', '포트폴리오' 같은 질문에 쓴다. 조회 전용이며 주문은 하지 않는다.",
		parameters: Type.Object({}),
		execute: async () => {
			const p = await fetchPortfolio(deps.brokers);
			const details: HoldingsDetails = {
				kind: "holdings-card",
				holdings: p.holdings,
				brokers: p.brokers,
				stockValueKrw: p.stockValueKrw,
				cashKrw: p.cashKrw,
				cashUsd: p.cashUsd,
				profitKrw: p.profitKrw,
				usdKrw: p.usdKrw,
			};

			if (p.holdings.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`보유 종목이 없습니다. 예수금 ${cashText(p.cashKrw, p.cashUsd)}` +
								(p.warnings.length > 0 ? `\n\n⚠️ ${p.warnings.join("\n⚠️ ")}` : ""),
						},
					],
					details,
				};
			}

			// 채팅에 카드가 없으니 목록을 싣는다 — 너무 많으면 평가금액 상위만 (나머지는 투자 탭)
			const top = p.holdings
				.slice(0, 30)
				.map(
					(h) =>
						`- ${h.name} (${h.symbol}) ${h.quantity}주 · 평단 ${money(h.avgPrice, h.currency)} · 현재 ${money(h.price, h.currency)} · ` +
						`평가 ${won(h.valueKrw)} (${h.profitPct >= 0 ? "+" : ""}${h.profitPct}%)`,
				);

			return {
				content: [
					{
						type: "text" as const,
						text:
							`보유 ${p.holdings.length}종목 · 평가금액 ${won(p.stockValueKrw)} · ` +
							`평가손익 ${signed(p.profitKrw, "KRW")} · 예수금 ${cashText(p.cashKrw, p.cashUsd)}` +
							(p.usdKrw > 0 ? ` (환율 ${p.usdKrw.toLocaleString("ko-KR")}원)` : "") +
							`\n\n${top.join("\n")}` +
							(p.holdings.length > top.length ? `\n… 외 ${p.holdings.length - top.length}종목 (여기엔 없음 — 전체는 투자 탭에서)` : "") +
							(p.warnings.length > 0 ? `\n\n⚠️ ${p.warnings.join("\n⚠️ ")}` : ""),
					},
				],
				details,
			};
		},
	});

	const portfolioSignals = defineTool({
		name: "portfolio_signals",
		label: "보유 종목 점검",
		description:
			"보유 종목 전체의 기술적 상태를 한 번에 점검한다 — 평단 대비 수익률, 추세, RSI, 신호. " +
			"'내 종목 어때?', '과열된 거 있어?', '손실 큰 거 점검해줘' 같은 요청에 쓴다. " +
			"종목마다 시세를 조회하므로 몇 초 걸린다. 평가금액 상위 순으로 최대 12종목만 본다.",
		parameters: Type.Object({}),
		execute: async () => {
			const { rows, skipped, warnings, targetCount } = await inspectPortfolioSignals(deps.brokers);
			const details: PortfolioSignalsDetails = { kind: "portfolio-signals-card", rows, skipped, warnings };
			const notes =
				(skipped.length > 0 ? `\n\n제외: ${skipped.join(", ")}` : "") +
				(warnings.length > 0 ? `\n\n⚠️ ${warnings.join("\n⚠️ ")}` : "");

			if (rows.length === 0) {
				const text = targetCount > 0
					? `보유 ${targetCount}종목의 시세를 가져오지 못해 점검하지 못했습니다.`
					: warnings.length > 0
						? "보유 조회에 경고가 있어 점검할 종목을 확인하지 못했습니다. 미보유 여부는 단정할 수 없습니다."
						: "점검할 보유 종목이 없습니다.";
				return {
					content: [{ type: "text" as const, text: text + notes }],
					details,
				};
			}

			const lines = rows.map((r) => {
				const tag = r.signals.length > 0 ? ` · ${r.signals.join(", ")}` : "";
				return (
					`- ${r.name}: ${money(r.price, r.currency)} ` +
					`(평단 대비 ${r.vsAvgPct >= 0 ? "+" : ""}${r.vsAvgPct}%) · ${r.trend} · RSI ${r.rsi ?? "—"}${tag}`
				);
			});

			return {
				content: [
					{
						type: "text" as const,
						text:
							`보유 ${rows.length}종목 기술적 점검\n${lines.join("\n")}` + notes,
					},
				],
				details,
			};
		},
	});

	const financeOverview = defineTool({
		name: "finance_overview",
		label: "자산 현황",
		description:
			"투자자산(증권 평가금액·예수금)과 가계부 현금흐름(수입·지출·잉여)을 한 번에 본다. " +
			"'자산 현황', '순자산', '이번 달 여유 얼마나 되지', '적립식으로 얼마 넣을 수 있어' 같은 질문에 쓴다. " +
			"현금흐름은 사용자의 기본 가계부 기준이다 (공유 가계부면 멤버 전체).",
		parameters: Type.Object({
			period: Type.Optional(PERIOD_ENUM),
		}),
		execute: async (_id, params) => {
			const { from, to } = resolvePeriod((params.period as never) ?? "this_month");

			// 증권 조회가 실패해도 가계부 쪽은 보여준다 (키 미설정이 흔한 경우)
			const [portfolio, ledgerRows] = await Promise.allSettled([
				fetchPortfolio(deps.brokers),
				(async () => {
					const cfg = deps.ledger();
					await ensureMigrated(cfg);
					const book = await resolveLedger(cfg, deps.member);
					return ledgerSummary(cfg, book.id, { from, to });
				})(),
			]);

			const p = portfolio.status === "fulfilled" ? portfolio.value : null;
			const rows = ledgerRows.status === "fulfilled" ? ledgerRows.value : [];

			const income = rows.reduce((s, r) => s + r.income, 0);
			const expense = rows.reduce((s, r) => s + r.expense, 0);
			const surplus = income - expense;

			const details: OverviewDetails = {
				kind: "overview-card",
				from,
				to,
				investKrw: p?.stockValueKrw ?? 0,
				cashKrw: p?.cashKrw ?? 0,
				cashUsd: p?.cashUsd ?? 0,
				profitKrw: p?.profitKrw ?? 0,
				income,
				expense,
				surplus,
			};

			const lines: string[] = [`${from} ~ ${to}`];

			if (p) {
				lines.push(
					`투자자산 ${won(p.stockValueKrw + p.cashKrw)} ` +
						`(주식 ${won(p.stockValueKrw)} / 예수금 ${won(p.cashKrw)}) · ` +
						(p.cashUsd > 0 ? `달러 예수금 ${usdCash(p.cashUsd)} (투자자산 합계에는 미포함, 원화로 환산해 말하지 않는다) · ` : "") +
						`평가손익 ${signed(p.profitKrw, "KRW")}`,
				);
				for (const w of p.warnings) lines.push(`⚠️ ${w}`);
			} else {
				lines.push(
					`투자자산: 조회하지 못했습니다 — ${portfolio.status === "rejected" ? String((portfolio.reason as Error)?.message ?? portfolio.reason) : ""}`,
				);
			}

			if (ledgerRows.status === "rejected") {
				lines.push("가계부: 조회하지 못했습니다");
			} else {
				lines.push(
					`가계부 수입 ${won(income)} / 지출 ${won(expense)} → ` +
						`${surplus >= 0 ? `잉여 ${won(surplus)}` : `적자 ${won(-surplus)}`}`,
				);
			}

			return { content: [{ type: "text" as const, text: lines.join("\n") }], details };
		},
	});

	return { portfolioHoldings, portfolioSignals, financeOverview };
}
