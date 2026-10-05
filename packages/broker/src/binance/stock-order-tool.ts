/**
 * binance_stock_order — Binance **미국 주식 직접 거래** 주문 준비 (Nest Trading → Alpaca). 실행은 확인 카드에서 사람이.
 *
 * 검증(validateEquityOrder)은 순수 함수 — 가격 0.01 · 수량 stepSize(소수점 주식) · 최소 주문금액 · 기준가 허용 범위 · 거래 가능 방향.
 * 단위에 안 맞는 값은 내림 보정하고 카드에 알린다. 카드는 Binance 현물 카드 모양을 쓴다 (market = "stock").
 * 본주 대비(orderGap) — Binance 호가가 본주(KIS·토스 현재가)와 벌어지는 일이 잦아, 괴리와 이 주문이 본주보다 몇 % 불리한지를 카드에 싣는다.
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { BinanceStockAction, OrderAction } from "../actions.ts";
import type { BrokerAccess } from "../portfolio.ts";
import { fetchQuote } from "../quote.ts";
import { cmpDec, floorToStep, mulDec, pctDiff } from "./decimal.ts";
import type { BinanceOrderCard } from "./order-tool.ts";
import { EQUITY_QUOTE, EQUITY_TICK, equityOpenOrders, equityPosition, equityQuote, equityRules, premiumOf, tradabilityProblem, type EquityRules } from "./stocks.ts";
import type { BinanceCreds } from "./trade.ts";

const trim = (v: string): string => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);

export interface EquityRequest {
	side: "BUY" | "SELL";
	type: "LIMIT" | "MARKET";
	quantity?: string;
	/** 시장가 매수 금액 (USDC) */
	notional?: string;
	price?: string;
	session?: "RTH" | "EXTENDED" | "24H";
}

export interface EquityValidated {
	errors: string[];
	warnings: string[];
	quantity?: string;
	notional?: string;
	price?: string;
	estimated?: string;
}

/** 규칙·현재가(중간가)로 검증하고 단위를 맞춘다 (순수) */
export function validateEquityOrder(req: EquityRequest, rules: EquityRules, last: string | null, held: number | null): EquityValidated {
	const errors: string[] = [];
	const warnings: string[] = [];
	const out: EquityValidated = { errors, warnings };
	const bad = tradabilityProblem(rules, req.side);
	if (bad) errors.push(bad);
	const pos = (label: string, v: string | undefined): v is string => {
		if (v === undefined || v === "") return false;
		if (!/^\d+(\.\d+)?$/.test(v) || !(Number(v) > 0)) {
			errors.push(`${label}이(가) 올바르지 않습니다: ${v}`);
			return false;
		}
		return true;
	};
	if (req.type === "LIMIT") {
		if (req.notional) errors.push("지정가는 금액(notional)이 아니라 수량으로 합니다");
		if (!pos("가격", req.price)) errors.push(`지정가에는 가격이 필요합니다${last ? ` (현재가 약 $${last} — 사용자가 '현재가 근처' 라고 했으면 이 값으로)` : ""}`);
		if (!pos("수량", req.quantity)) errors.push("지정가에는 수량이 필요합니다");
	} else if (req.side === "BUY") {
		if (req.quantity && !req.notional && last && Number(last) > 0 && Number(req.quantity) > 0) {
			// 수량으로 시장가를 말했다 — 바로 고칠 수 있게 두 길을 숫자로
			const amt = (Number(req.quantity) * Number(last)).toFixed(2);
			errors.push(
				`Binance 시장가 매수는 금액(notional)으로만 됩니다. ${req.quantity}주를 사려면 — ① 지정가: type LIMIT · quantity ${req.quantity} · price 현재가 근처(약 $${last}) ` +
					`또는 ② 금액 시장가: notional ${amt} (약 ${req.quantity}주, 체결가에 따라 조금 다르다). 사용자가 '시장가'를 콕 집지 않았으면 ①로 준비한다`,
			);
			return out;
		}
		if (req.quantity || req.price) errors.push("시장가 매수는 금액(notional, USDC)으로만 합니다");
		if (!pos("금액", req.notional)) errors.push("시장가 매수에는 금액(notional, USDC)이 필요합니다");
	} else {
		if (req.notional || req.price) errors.push("시장가 매도는 수량으로만 합니다");
		if (!pos("수량", req.quantity)) errors.push("시장가 매도에는 수량이 필요합니다");
	}
	if (errors.length) return out;

	if (req.price) {
		const p = floorToStep(req.price, EQUITY_TICK);
		if (cmpDec(p, req.price) !== 0) warnings.push(`가격 단위(0.01)로 내림: ${req.price} → ${p}`);
		out.price = p;
		if (last && Number(last) > 0) {
			const up = Number(rules.multiplierUp) || 0;
			const down = Number(rules.multiplierDown) || 0;
			const band = up > 0 && down > 0 ? ` — 지금 $${(Number(last) * down).toFixed(2)} ~ $${(Number(last) * up).toFixed(2)} 안이어야 한다 (현재가 약 $${last})` : "";
			if (up > 0 && Number(p) > Number(last) * up) errors.push(`가격이 기준가 허용 범위(×${up}) 위입니다${band}`);
			if (down > 0 && Number(p) < Number(last) * down) errors.push(`가격이 기준가 허용 범위(×${down}) 아래입니다${band}`);
			const dev = Math.abs(pctDiff(p, last));
			if (dev >= 5) warnings.push(`지정가가 현재가와 ${dev}% 차이납니다.`);
		}
	}
	if (req.quantity) {
		const q = floorToStep(req.quantity, rules.stepSize);
		if (cmpDec(q, req.quantity) !== 0) warnings.push(`수량 단위(${trim(rules.stepSize)}${rules.fractionable ? "" : " — 소수점 주식이 안 되는 종목"})로 내림: ${req.quantity} → ${q}`);
		if (!(Number(q) > 0) || cmpDec(q, rules.minQty) < 0) errors.push(`수량이 최소 수량(${trim(rules.minQty)}주)보다 작습니다`);
		out.quantity = trim(q);
		if (req.side === "SELL" && held !== null && Number(q) > held) warnings.push(`체결 내역으로 본 보유(${held}주)보다 많습니다 — 넘치면 Binance 가 거절합니다.`);
	}
	if (req.notional) out.notional = trim(floorToStep(req.notional, "0.01"));
	const priceForAmount = out.price ?? last;
	const est = out.notional ?? (out.quantity && priceForAmount ? trim(floorToStep(mulDec(out.quantity, priceForAmount), "0.01")) : undefined);
	if (est) {
		out.estimated = est;
		if (Number(rules.minNotional) > 0 && Number(est) < Number(rules.minNotional)) {
			errors.push(`주문 금액(${est})이 최소 주문금액(${trim(rules.minNotional)} ${EQUITY_QUOTE})보다 작습니다`);
			// "0.1주" 를 금액 0.1 로 읽은 경우
			if (out.notional && last) errors.push(`notional 은 USDC 금액이다 — ${out.notional}주를 사려던 거면 type LIMIT · quantity ${out.notional} · price 약 $${last} (또는 notional ${(Number(out.notional) * Number(last)).toFixed(2)})`);
		}
	}
	if (req.type === "LIMIT" && (req.session ?? "RTH") !== "RTH") {
		if (req.session === "EXTENDED" && !rules.extendedSession) errors.push(`${rules.symbol} 은(는) 프리·애프터 거래가 안 됩니다`);
		if (req.session === "24H" && !rules.overnightSupported) errors.push(`${rules.symbol} 은(는) 24시간 거래가 안 됩니다`);
		if (out.quantity && !Number.isInteger(Number(out.quantity)) && req.session === "EXTENDED" && !rules.fractionable) errors.push("이 종목은 장 밖에 소수점 주식이 안 됩니다");
		warnings.push("장 밖 거래는 호가가 얇고 가격이 크게 움직일 수 있습니다.");
	}
	if (req.type === "MARKET") warnings.push(req.side === "BUY" ? "시장가 매수는 현재가보다 높게 체결될 수 있습니다." : "시장가 매도는 현재가보다 낮게 체결될 수 있습니다.");
	return out;
}

export type StockGap = NonNullable<BinanceOrderCard["gap"]>;

/** 불리할 때 경고하는 선 (%) */
const GAP_WARN_PCT = 1;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 본주 대비 (순수) — 호가·본주 시세가 없으면 null.
 * 불리 % 는 매수면 본주보다 비싸게, 매도면 싸게 사고파는 만큼 (+ 불리 · − 유리). 시장가는 매수 ask · 매도 bid 로 본다.
 */
export function orderGap(
	q: { bid: number; ask: number } | null,
	underlying: { price: number; source: string } | null,
	side: "BUY" | "SELL",
	limitPrice?: string,
): StockGap | null {
	const p = underlying ? premiumOf(q, underlying.price) : null;
	if (!p || !q || !underlying) return null;
	const cost = (pct: number | null): number | null => (pct === null ? null : side === "BUY" ? pct : 0 - pct);
	const limit = limitPrice && Number(limitPrice) > 0 ? round2(((Number(limitPrice) - underlying.price) / underlying.price) * 100) : null;
	return {
		bid: q.bid > 0 ? q.bid : null,
		ask: q.ask > 0 ? q.ask : null,
		underlying: underlying.price,
		source: underlying.source,
		pct: p.pct,
		marketCostPct: cost(side === "BUY" ? p.askPct : p.bidPct),
		limitCostPct: cost(limit),
		spreadPct: p.spreadPct,
	};
}

const signed = (n: number): string => `${n >= 0 ? "+" : ""}${n}%`;
const costText = (n: number): string => (n >= 0 ? `${n}% 불리` : `${0 - n}% 유리`);

/** 에이전트에게 주는 본주 대비 한 줄 */
export function gapText(g: StockGap, side: "BUY" | "SELL"): string {
	const verb = side === "BUY" ? "사면" : "팔면";
	return (
		`본주 대비: Binance 매수호가 ${g.bid ?? "—"} / 매도호가 ${g.ask ?? "—"} vs 본주 $${g.underlying} [${g.source}] → 괴리 ${signed(g.pct)}` +
		`${g.marketCostPct !== null ? ` · 시장가로 ${verb} 본주보다 ${costText(g.marketCostPct)}` : ""}` +
		`${g.limitCostPct !== null ? ` · 지정가로 ${verb} 본주보다 ${costText(g.limitCostPct)}` : ""}` +
		`${g.spreadPct !== null ? ` · 호가 폭 ${g.spreadPct}%` : ""}` +
		"\n  ※ Binance 호가는 최대 ~5초, 본주 시세는 증권사 조회 시점 — 장 마감·장 밖에는 괴리가 커 보일 수 있다"
	);
}

/** 불리 % 가 선을 넘으면 경고 (순수) */
export function gapWarnings(g: StockGap, side: "BUY" | "SELL", type: "LIMIT" | "MARKET"): string[] {
	const verb = side === "BUY" ? "비싸게 삽니다" : "싸게 팝니다";
	const out: string[] = [];
	if (type === "MARKET" && g.marketCostPct !== null && g.marketCostPct >= GAP_WARN_PCT)
		out.push(`시장가 — 지금 호가로는 본주($${g.underlying})보다 약 ${g.marketCostPct}% ${verb}. 지정가를 고려해 보세요.`);
	if (type === "LIMIT" && g.limitCostPct !== null && g.limitCostPct >= GAP_WARN_PCT) out.push(`지정가가 본주($${g.underlying})보다 ${g.limitCostPct}% 불리합니다 — ${verb}.`);
	return out;
}

function connected<T>(make: (() => T) | undefined): T | null {
	if (!make) return null;
	try {
		return make();
	} catch {
		return null;
	}
}

export function createBinanceStockOrderTool(deps: { brokers: BrokerAccess; prepareOrder?: (a: OrderAction) => { token: string; expiresAt: number } }) {
	return defineTool({
		name: "binance_stock_order",
		label: "Binance 미국 주식 주문 준비",
		description:
			"Binance 의 **미국 주식 직접 거래**(Nest Trading → Alpaca, 실제 주식 — bStock 토큰 아님) 주문을 준비한다. 실행하지 않는다 — 확인 카드에서 사용자가 [확인] 해야 나간다. " +
			"action: place(LIMIT = price + quantity + session / MARKET 매수 = notional(USDC 금액), MARKET 매도 = quantity) / cancel(orderId — 모르면 비우고 불러 미체결 목록을 받는다). " +
			"소수점 주식 가능 (quantity 0.5 · 금액 주문), 최소 5 USDC, 가격 소수 2자리. 대금은 USDC. session: RTH(정규장, 기본) · EXTENDED(프리·애프터) · 24H. " +
			"사용자가 Binance 로 미국 주식을 사고판다고 명시했을 때만 호출한다 (한국투자·토스 미국 주식은 order_prepare).",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("place"), Type.Literal("cancel")]),
			symbol: Type.String({ description: "미국 티커 — AAPL · NVDA · SPY" }),
			side: Type.Optional(Type.Union([Type.Literal("BUY"), Type.Literal("SELL")])),
			type: Type.Optional(Type.Union([Type.Literal("LIMIT"), Type.Literal("MARKET")])),
			quantity: Type.Optional(Type.String({ description: "주 수 (문자열, 소수점 가능 — 예 '0.5')" })),
			notional: Type.Optional(Type.String({ description: "시장가 매수 금액 (USDC, 예 '100')" })),
			price: Type.Optional(Type.String({ description: "지정가 (USD, 소수 2자리)" })),
			session: Type.Optional(Type.Union([Type.Literal("RTH"), Type.Literal("EXTENDED"), Type.Literal("24H")])),
			orderId: Type.Optional(Type.String({ description: "cancel 대상 (UUID)" })),
		}),
		execute: async (_id, params) => {
			if (!deps.prepareOrder) throw new Error("주문 기능이 비활성 상태입니다.");
			const creds = connected(deps.brokers.binance) as BinanceCreds | null;
			if (!creds) throw new Error("Binance 미국 주식 주문에는 키가 필요합니다 — 설정 → 코인 (Binance) (출금 권한 없이 발급).");
			const symbol = params.symbol.trim().toUpperCase().replace(/[^A-Z.]/g, "");
			const rules = await equityRules(creds, symbol);
			if (!rules) throw new Error(`Binance 에서 거래할 수 없는 미국 주식입니다: ${symbol}`);
			// 본주 시세는 KIS·토스 — 없거나 실패해도 주문은 준비한다 (본주 대비만 빠진다)
			const [q, underlying] = await Promise.all([
				equityQuote(creds, symbol).catch(() => null),
				params.action === "place" ? fetchQuote(deps.brokers, symbol).then((u) => ({ price: u.price, source: u.source }), () => null) : null,
			]);
			const last = q && q.bid > 0 && q.ask > 0 ? trim(floorToStep(String((q.bid + q.ask) / 2), "0.0001")) : q?.ask ? String(q.ask) : null;

			const card: BinanceOrderCard = {
				kind: "binance-order-card", market: "stock", ok: false, token: null, expiresAt: null, action: params.action, symbol, base: symbol, quote: EQUITY_QUOTE,
				side: params.side ?? null, type: params.type ?? null, quantity: null, quoteQuantity: null, price: null, estimatedQuote: null,
				lastPrice: last, balance: null, minNotional: Number(rules.minNotional) > 0 ? trim(rules.minNotional) : null, gap: null,
				original: null, lines: [], orders: [], warnings: [], errors: [],
			};
			let action: BinanceStockAction | null = null;

			if (params.action === "cancel") {
				const open = (await equityOpenOrders(creds)).filter((o) => o.symbol === symbol);
				const asOriginal = (o: (typeof open)[number]) => ({ orderId: o.orderId, side: o.side, type: o.orderType, price: o.limitPrice ?? "0", origQty: o.qty ?? o.notional ?? "0", executedQty: o.filledQty });
				const o = open.find((x) => x.orderId === params.orderId);
				if (!o) {
					card.errors.push(params.orderId ? `미체결 목록에 없는 주문입니다 (${params.orderId}) — 이미 체결·취소됐거나 번호가 틀렸습니다.` : `취소할 orderId 를 골라 주세요 (${symbol} 미체결 ${open.length}건).`);
					card.orders = open.map(asOriginal);
					for (const x of open) card.errors.push(`  · orderId=${x.orderId} ${x.side === "BUY" ? "매수" : "매도"} ${x.qty ?? `${x.notional} USDC`}${x.limitPrice ? ` @ $${x.limitPrice}` : " 시장가"} (체결 ${x.filledQty}) ${x.status}`);
				} else {
					card.original = asOriginal(o);
					card.side = o.side;
					action = { kind: "binance-stock-cancel", broker: "binance_stock", symbol, original: { orderId: o.orderId, side: o.side, type: o.orderType, price: o.limitPrice ?? "0", qty: o.qty ?? "0", filledQty: o.filledQty } };
				}
			} else {
				if (!params.side || !params.type) card.errors.push("side(BUY·SELL)와 type(LIMIT·MARKET)이 필요합니다");
				else {
					const held = params.side === "SELL" ? await equityPosition(creds, symbol).then((p) => p.qty).catch(() => null) : null;
					const v = validateEquityOrder({ side: params.side, type: params.type, quantity: params.quantity, notional: params.notional, price: params.price, session: params.session }, rules, last, held);
					card.errors.push(...v.errors);
					card.warnings.push(...v.warnings);
					card.quantity = v.quantity ?? null;
					card.quoteQuantity = v.notional ?? null;
					card.price = v.price ?? null;
					card.estimatedQuote = v.estimated ?? null;
					if (held !== null) card.balance = { asset: `${symbol} (체결 내역 추정)`, free: String(held) };
					card.gap = orderGap(q, underlying, params.side, params.type === "LIMIT" ? v.price : undefined);
					if (card.gap) card.warnings.push(...gapWarnings(card.gap, params.side, params.type));
					if (v.errors.length === 0) {
						action = {
							kind: "binance-stock-place", broker: "binance_stock", symbol, quote: EQUITY_QUOTE, side: params.side, type: params.type,
							...(v.quantity ? { quantity: v.quantity } : {}), ...(v.notional ? { notional: v.notional } : {}), ...(v.price ? { price: v.price } : {}),
							...(params.type === "LIMIT" ? { session: params.session ?? "RTH" } : {}), estimatedQuote: v.estimated ?? "0",
						};
					}
				}
			}
			card.warnings.push("Binance 미국 주식 — Nest Trading(ADGM) → Alpaca 체결·보관. 앱에서 미국 주식 약관에 동의해 둬야 주문이 됩니다. 산 주식은 토큰(bStock)으로 바꾸지 않습니다.");

			const px =
				card.gap && card.side
					? `\n${gapText(card.gap, card.side)}`
					: q
						? `\n현재 호가: 매수 $${q.bid} · 매도 $${q.ask}${last ? ` (중간 $${last})` : ""}${params.action === "place" ? " — 본주 시세를 못 받아 괴리는 못 봤다" : ""}`
						: "";
			if (!action || card.errors.length) {
				return { content: [{ type: "text" as const, text: `Binance 미국 주식 ${params.action} 을(를) 준비하지 못했습니다 (${symbol}).\n${card.errors.map((e) => `- ${e}`).join("\n")}${px}` }], details: card };
			}
			const { token, expiresAt } = deps.prepareOrder(action);
			card.ok = true;
			card.token = token;
			card.expiresAt = expiresAt;
			const what =
				action.kind === "binance-stock-place"
					? `${action.side === "BUY" ? "매수" : "매도"} ${action.quantity ? `${action.quantity}주` : `${action.notional} USDC어치`} ${action.type === "LIMIT" ? `지정가 $${action.price} (${action.session})` : "시장가"}`
					: `취소 ${action.original.orderId.slice(0, 12)}`;
			return {
				content: [
					{
						type: "text" as const,
						text: `확인이 필요합니다 — [Binance 미국 주식] ${symbol} ${what}${action.kind === "binance-stock-place" ? px : ""}${card.warnings.length ? `\n⚠️ ${card.warnings.join("\n⚠️ ")}` : ""}\n화면의 카드에서 사용자가 [확인] 을 눌러야 실행됩니다.`,
					},
				],
				details: card,
			};
		},
	});
}
