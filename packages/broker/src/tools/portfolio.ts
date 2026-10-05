/** 보유 종목·자산 현황·보유 종목 점검 툴. */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { ensureMigrated, resolveLedger, resolvePeriod, summary as ledgerSummary } from "@alphafolio/ledger";
import { fetchPortfolio } from "../portfolio.ts";
import { inspectPortfolioSignals } from "../portfolio-signals.ts";
import type { BrokerToolDeps, HoldingsDetails, OverviewDetails, PortfolioSignalsDetails } from "./contracts.ts";
import { won, usd, usdCash, cashText, money, signed } from "./format.ts";
import type { CryptoHolding, CurrencySplit, ManualHolding } from "../normalize.ts";
import { walletLabel } from "../sources/index.ts";

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

const qty = (n: number): string => String(Number(n.toPrecision(8)));
const usdt = (n: number): string => `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT`;
const approx = (krw: number): string => (krw > 0 ? ` ≈ ${won(krw)}` : "");

/** 화폐별 — 원래 통화 금액 (원화 환산은 곁에). 0 인 화폐는 뺀다 */
function currencyText(amount: CurrencySplit, krw: CurrencySplit): string {
	const parts = [
		amount.krw !== 0 && `원화 ${won(amount.krw)}`,
		amount.usd !== 0 && `달러 ${usdCash(amount.usd)}${approx(krw.usd)}`,
		amount.usdt !== 0 && `코인 ${usdt(amount.usdt)}${approx(krw.usdt)}`,
	].filter(Boolean);
	return `화폐별 (원래 통화 — 달러는 달러로, 코인은 USDT 로 말한다): ${parts.join(" · ")}`;
}

/** 코인 목록 — 1달러 미만 잔돈은 개수만 */
function cryptoText(crypto: readonly CryptoHolding[], totalUsdt: number, totalKrw: number): string {
	const shown = crypto.filter((c) => c.valueUsd === null || c.valueUsd >= 1).slice(0, 20);
	const rest = crypto.length - shown.length;
	const lines = shown.map(
		(c) =>
			`- ${c.asset}${c.stable ? " (스테이블)" : ""} ${qty(c.quantity)} · ` +
			(c.valueUsd === null ? "시세 없음" : `${usdt(c.valueUsd)}${approx(c.valueKrw)}`) +
			(c.avgPriceUsd !== null && c.profitPct !== null
				? ` · 평단 ${usd(c.avgPriceUsd)} (${c.profitPct >= 0 ? "+" : ""}${c.profitPct}%${c.costCoverage !== null && c.costCoverage < 0.95 ? `, 보유의 ${Math.round(c.costCoverage * 100)}%만 체결로 설명 — 나머지는 원가 모름` : ""})`
				: "") +
			` · ${c.wallets.map((w) => walletLabel(w.wallet)).join("·")}`,
	);
	return (
		`코인 (Binance) ${crypto.length}종 · 평가 ${usdt(totalUsdt)}${approx(totalKrw)} (USDT 환산 · 평단은 현물 체결로 추정, 입금·보상분은 원가를 모른다)\n` +
		lines.join("\n") +
		(rest > 0 ? `\n… 외 ${rest}종 (1달러 미만 잔돈 등)` : "")
	);
}

const MANUAL_KIND: Record<ManualHolding["kind"], string> = { deposit: "예금·현금", pension: "연금", real_estate: "부동산", investment: "기타 투자", other: "기타" };

/** 직접 입력 자산 — 사용자가 적어 둔 금액이라 시세가 아니다 */
function manualText(manual: readonly ManualHolding[]): string {
	const total = manual.reduce((s, m) => s + m.valueKrw, 0);
	return (
		`직접 입력 자산 ${manual.length}개 · ${won(total)} (사용자가 적어 둔 금액 — 시세가 아니다)\n` +
		manual
			.map(
				(m) =>
					`- ${m.name} (${MANUAL_KIND[m.kind]}) ${m.currency === "USD" ? `${usd(m.amount)}${m.valueKrw > 0 ? ` ≈ ${won(m.valueKrw)}` : ""}` : won(m.amount)}` +
					` · ${m.updatedAt.slice(0, 10)} 기준${m.memo ? ` · ${m.memo}` : ""}`,
			)
			.join("\n")
	);
}

export function createPortfolioTools(deps: BrokerToolDeps) {
	const portfolioHoldings = defineTool({
		name: "portfolio_holdings",
		label: "보유 종목",
		description:
			"연결된 계좌의 보유 자산과 평가금액을 조회한다 — 증권(KIS·토스, 국내+해외), Binance 미국 주식(지갑 EQ_ 잔고, 평단은 체결 내역)·bStock 토큰, 코인(Binance 현물·펀딩·Earn, 평단 추정), " +
			"투자 탭에서 직접 입력한 자산(예금·연금·부동산 등), 원화 환산 총자산. " +
			"'내 주식', '내 코인', '얼마 벌었어', '포트폴리오', '총자산' 같은 질문에 쓴다. 조회 전용이며 주문은 하지 않는다.",
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
				crypto: p.crypto,
				manual: p.manual,
				cryptoValueKrw: p.cryptoValueKrw,
				netWorthKrw: p.netWorthKrw,
			};

			const sections: string[] = [];
			// 증권 계좌가 아예 연결되지 않았고 주식도 없으면 (코인만) 주식 줄을 쓰지 않는다
			const hasStockAccount = p.sources.some((s) => s.id === "kis" || s.id === "toss");
			if (hasStockAccount && p.holdings.length === 0) {
				sections.push(`보유 종목이 없습니다. 예수금 ${cashText(p.cashKrw, p.cashUsd)}`);
			} else if (p.holdings.length > 0) {
				// 채팅에 카드가 없으니 목록을 싣는다 — 너무 많으면 평가금액 상위만 (나머지는 투자 탭)
				const top = p.holdings
					.slice(0, 30)
					.map(
						(h) =>
							`- ${h.name} (${h.symbol}) ${h.quantity}주 · ` +
							(h.avgPrice > 0 ? `평단 ${money(h.avgPrice, h.currency)} · ` : "평단 모름 · ") +
							`현재 ${money(h.price, h.currency)} · 평가 ${h.currency === "USD" ? `${usd(h.value)}${approx(h.valueKrw)}` : won(h.valueKrw)}` +
							(h.avgPrice > 0 ? ` (${h.profitPct >= 0 ? "+" : ""}${h.profitPct}%)` : "") +
							(h.broker === "binance" ? ` · Binance${h.note ? ` ${h.note}` : ""}` : ""),
					);
				sections.push(
					`보유 ${p.holdings.length}종목 · 평가금액 ${won(p.stockValueKrw)} · ` +
						`평가손익 ${signed(p.profitKrw, "KRW")} · 예수금 ${cashText(p.cashKrw, p.cashUsd)}` +
						(p.usdKrw > 0 ? ` (환율 ${p.usdKrw.toLocaleString("ko-KR")}원)` : "") +
						`\n\n${top.join("\n")}` +
						(p.holdings.length > top.length ? `\n… 외 ${p.holdings.length - top.length}종목 (여기엔 없음 — 전체는 투자 탭에서)` : ""),
				);
			}

			if (p.crypto.length > 0) sections.push(cryptoText(p.crypto, p.byCurrency.usdt, p.cryptoValueKrw));
			if (p.manual.length > 0) sections.push(manualText(p.manual));
			// 계좌가 여럿이면 환산 합계 — 달러·코인을 원화로 바꾼 값이라고 밝힌다
			if (p.crypto.length > 0 || p.manual.length > 0 || p.sources.length > 1) {
				sections.push(`총자산 (원화 환산 합계 — 주식·예수금·달러·코인·직접 입력) ${won(p.netWorthKrw)}`);
			}
			if (p.byCurrency.usd !== 0 || p.byCurrency.usdt !== 0) sections.push(currencyText(p.byCurrency, p.byCurrencyKrw));

			return {
				content: [
					{
						type: "text" as const,
						text: sections.join("\n\n") + (p.warnings.length > 0 ? `\n\n⚠️ ${p.warnings.join("\n⚠️ ")}` : ""),
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
			"투자자산(증권 평가금액·예수금·코인)과 가계부 현금흐름(수입·지출·잉여)을 한 번에 본다. " +
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
				cryptoKrw: p?.cryptoValueKrw ?? 0,
				netWorthKrw: p?.netWorthKrw ?? 0,
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
				if (p.crypto.length > 0) {
					lines.push(`코인 ${won(p.cryptoValueKrw)} (Binance, 달러 시세를 원화로 환산 — 위 투자자산 합계에는 미포함)`);
				}
				if (p.manual.length > 0) {
					lines.push(`직접 입력 자산 ${won(p.manual.reduce((s, m) => s + m.valueKrw, 0))} (예금·연금·부동산 등 사용자가 적어 둔 금액 — 위 투자자산 합계에는 미포함)`);
				}
				if (p.crypto.length > 0 || p.manual.length > 0) {
					lines.push(`총자산 (원화 환산 합계 — 주식·예수금·달러·코인·직접 입력) ${won(p.netWorthKrw)}`);
				}
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
