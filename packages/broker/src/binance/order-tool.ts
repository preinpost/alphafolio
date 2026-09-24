/**
 * binance_order — Binance 현물 주문 **준비** (PLAN §36). 실행은 확인 카드에서 사람이.
 *
 * 검증(validateBinance)은 순수 함수 — 거래소 규칙(가격·수량 단위, 최소 주문금액, 가격 범위)·현재가 괴리·잔고.
 * 단위에 안 맞는 값은 내림 보정하고 카드에 알린다. 원주문(취소·재주문)은 서버가 미체결 조회로 찾는다.
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { BinanceAction, BinanceOriginal, OrderAction } from "../actions.ts";
import type { BrokerAccess } from "../portfolio.ts";
import { cmpDec, floorToStep, mulDec, pctDiff, subDec } from "./decimal.ts";
import { freeBalances, lastPrice, openOrders, symbolRules, type BinanceCreds, type SymbolRules } from "./trade.ts";

export interface BinanceOrderCard {
	kind: "binance-order-card";
	ok: boolean;
	token: string | null;
	expiresAt: number | null;
	action: "place" | "cancel" | "replace" | "oco" | "oto" | "cancel_all";
	symbol: string;
	base: string;
	quote: string;
	side: "BUY" | "SELL" | null;
	type: string | null;
	quantity: string | null;
	quoteQuantity: string | null;
	price: string | null;
	estimatedQuote: string | null;
	lastPrice: string | null;
	balance: { asset: string; free: string } | null;
	minNotional: string | null;
	original: BinanceOriginal | null;
	/** OCO·OTO·재주문 줄 — 라벨·내용·현재가 대비 % */
	lines: Array<{ label: string; text: string; pct: number | null }>;
	/** 전체 취소 대상 */
	orders: BinanceOriginal[];
	warnings: string[];
	errors: string[];
}

export interface BinanceRequest {
	action: BinanceOrderCard["action"];
	side?: "BUY" | "SELL";
	type?: "LIMIT" | "MARKET";
	quantity?: string;
	quoteQuantity?: string;
	price?: string;
	takeProfitPrice?: string;
	stopPrice?: string;
	stopLimitPrice?: string;
	buyPrice?: string;
	sellPrice?: string;
}

export interface BinanceValidated {
	errors: string[];
	warnings: string[];
	quantity?: string;
	quoteQuantity?: string;
	price?: string;
	takeProfitPrice?: string;
	stopPrice?: string;
	stopLimitPrice?: string;
	buyPrice?: string;
	sellPrice?: string;
	/** 예상 주문금액 (호가 자산) */
	notional?: string;
}

/** 거래소 규칙·현재가·잔고로 검증하고 단위를 맞춘다 (순수) */
export function validateBinance(req: BinanceRequest, rules: SymbolRules, last: string, free: Record<string, string> | null): BinanceValidated {
	const errors: string[] = [];
	const warnings: string[] = [];
	const out: BinanceValidated = { errors, warnings };
	if (rules.status !== "TRADING" || !rules.spot) errors.push(`${rules.symbol} 은(는) 지금 현물 거래할 수 없습니다 (상태 ${rules.status}).`);

	const positive = (label: string, v: string | undefined): v is string => {
		if (v === undefined || v === "") return false;
		if (!(Number(v) > 0)) {
			errors.push(`${label}이(가) 올바르지 않습니다: ${v}`);
			return false;
		}
		return true;
	};
	const price = (label: string, v: string | undefined, checkDev = true): string | undefined => {
		if (!positive(label, v)) return undefined;
		const p = floorToStep(v, rules.tickSize);
		if (cmpDec(p, v) !== 0) warnings.push(`${label} 가격 단위(${trim(rules.tickSize)})로 내림: ${v} → ${p}`);
		if (cmpDec(rules.minPrice, "0") > 0 && cmpDec(p, rules.minPrice) < 0) errors.push(`${label} ${p} 이(가) 최소 가격 ${trim(rules.minPrice)} 보다 낮습니다.`);
		if (cmpDec(rules.maxPrice, "0") > 0 && cmpDec(p, rules.maxPrice) > 0) errors.push(`${label} ${p} 이(가) 최대 가격 ${trim(rules.maxPrice)} 보다 높습니다.`);
		if (checkDev) {
			const dev = Math.abs(pctDiff(p, last));
			if (dev >= 50) errors.push(`${label} ${p} 이(가) 현재가 ${last} 와 ${dev}% 차이납니다 — 자릿수를 확인하세요.`);
			else if (dev >= 10) warnings.push(`${label} 이(가) 현재가와 ${dev}% 차이납니다.`);
		}
		return p;
	};
	const qty = (v: string | undefined, market = false): string | undefined => {
		if (!positive("수량", v)) return undefined;
		const step = market ? rules.marketStepSize : rules.stepSize;
		const q = floorToStep(v, step);
		if (cmpDec(q, v) !== 0) warnings.push(`수량 단위(${trim(step)})로 내림: ${v} → ${q}`);
		const min = market ? rules.marketMinQty : rules.minQty;
		const max = market ? rules.marketMaxQty : rules.maxQty;
		if (cmpDec(q, min) < 0 || cmpDec(q, "0") <= 0) errors.push(`수량 ${q} ${rules.base} 이(가) 최소 ${trim(min)} 보다 적습니다.`);
		if (cmpDec(max, "0") > 0 && cmpDec(q, max) > 0) errors.push(`수량 ${q} 이(가) 최대 ${trim(max)} 보다 많습니다.`);
		return q;
	};
	const notional = (n: string, market: boolean): void => {
		out.notional = n;
		if (cmpDec(rules.minNotional, "0") > 0 && (!market || rules.notionalAppliesToMarket) && cmpDec(n, rules.minNotional) < 0) {
			errors.push(`주문금액 ${n} ${rules.quote} 이(가) 최소 주문금액 ${trim(rules.minNotional)} ${rules.quote} 보다 적습니다.`);
		}
	};
	const needType = (t: string): void => {
		if (rules.orderTypes.length > 0 && !rules.orderTypes.includes(t)) errors.push(`${rules.symbol} 은(는) ${t} 주문을 지원하지 않습니다.`);
	};
	const balance = (asset: string, need: string, what: string): void => {
		if (!free) return;
		const have = free[asset] ?? "0";
		if (cmpDec(need, have) > 0) errors.push(`${asset} 잔고 부족 — ${what} ${need} > 주문 가능 ${trim(have)}.`);
	};

	switch (req.action) {
		case "place": {
			if (!req.side || !req.type) {
				errors.push("side(BUY/SELL)·type(LIMIT/MARKET) 이 필요합니다.");
				break;
			}
			needType(req.type);
			if (req.type === "LIMIT") {
				out.price = price("지정가", req.price);
				out.quantity = qty(req.quantity);
				if (!req.price) errors.push("지정가 주문에는 price 가 필요합니다.");
				if (out.price && out.quantity) notional(mulDec(out.price, out.quantity), false);
			} else if (req.quoteQuantity) {
				if (req.side !== "BUY") errors.push("금액(quoteQuantity) 주문은 시장가 매수만 됩니다.");
				if (positive("주문금액", req.quoteQuantity)) {
					out.quoteQuantity = req.quoteQuantity;
					notional(req.quoteQuantity, true);
				}
			} else {
				out.quantity = qty(req.quantity, true);
				if (out.quantity) notional(mulDec(last, out.quantity), true);
				if (req.side === "BUY") warnings.push("시장가 매수는 현재가보다 높게 체결될 수 있습니다.");
			}
			if (!out.quantity && !out.quoteQuantity && errors.length === 0) errors.push("수량(quantity) 또는 시장가 매수 금액(quoteQuantity)이 필요합니다.");
			if (req.side === "BUY" && out.notional) balance(rules.quote, out.notional, "주문금액");
			if (req.side === "SELL" && out.quantity) balance(rules.base, out.quantity, "매도 수량");
			break;
		}
		case "oco": {
			needType("LIMIT_MAKER");
			needType("STOP_LOSS_LIMIT");
			out.quantity = qty(req.quantity);
			out.takeProfitPrice = price("익절", req.takeProfitPrice);
			out.stopPrice = price("손절 스톱", req.stopPrice);
			out.stopLimitPrice = price("손절 지정가", req.stopLimitPrice ?? req.stopPrice);
			if (!req.takeProfitPrice || !req.stopPrice) errors.push("OCO 에는 takeProfitPrice·stopPrice 가 필요합니다.");
			if (out.takeProfitPrice && out.stopPrice && !(cmpDec(out.takeProfitPrice, last) > 0 && cmpDec(last, out.stopPrice) > 0)) {
				errors.push(`OCO 는 익절가(${out.takeProfitPrice}) > 현재가(${last}) > 손절 스톱가(${out.stopPrice}) 여야 합니다.`);
			}
			if (out.stopPrice && out.stopLimitPrice && cmpDec(out.stopLimitPrice, out.stopPrice) > 0) {
				warnings.push("손절 지정가가 스톱가보다 높습니다 — 급락 때 체결되지 않을 수 있습니다.");
			}
			if (out.quantity && out.stopLimitPrice) notional(mulDec(out.stopLimitPrice, out.quantity), false);
			if (out.quantity) balance(rules.base, out.quantity, "매도 수량");
			break;
		}
		case "oto": {
			out.quantity = qty(req.quantity);
			out.buyPrice = price("매수가", req.buyPrice);
			out.sellPrice = price("매도가", req.sellPrice);
			if (!req.buyPrice || !req.sellPrice) errors.push("OTO 에는 buyPrice·sellPrice 가 필요합니다.");
			if (out.buyPrice && out.sellPrice && cmpDec(out.sellPrice, out.buyPrice) <= 0) errors.push(`매도가(${out.sellPrice})는 매수가(${out.buyPrice})보다 높아야 합니다.`);
			if (out.buyPrice && cmpDec(out.buyPrice, last) >= 0) warnings.push("매수가가 현재가 이상이라 바로 체결될 수 있습니다.");
			if (out.quantity && out.buyPrice) {
				notional(mulDec(out.buyPrice, out.quantity), false);
				balance(rules.quote, out.notional!, "주문금액");
			}
			break;
		}
		default:
			break;
	}
	return out;
}

const trim = (v: string): string => v.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

function connected<T>(get: (() => T) | undefined): T | null {
	if (!get) return null;
	try {
		return get();
	} catch {
		return null;
	}
}

const normSymbol = (s: string): string => s.trim().toUpperCase().replace(/[/\s_-]/g, "");

export function createBinanceOrderTool(deps: { brokers: BrokerAccess; prepareOrder?: (a: OrderAction) => { token: string; expiresAt: number } }) {
	return defineTool({
		name: "binance_order",
		label: "Binance 주문 준비",
		description:
			"Binance **현물** 주문을 준비한다 (실행하지 않는다 — 확인 카드에서 사용자가 [확인] 해야 나간다). " +
			"action: place(신규 — LIMIT 은 price+quantity, MARKET 은 quantity 또는 매수 금액 quoteQuantity) / cancel(orderId) / " +
			"replace(orderId + 새 price·quantity, 지정가) / oco(보유분 익절·손절 매도: quantity·takeProfitPrice·stopPrice·stopLimitPrice) / " +
			"oto(지정가 매수 체결 후 지정가 매도: quantity·buyPrice·sellPrice) / cancel_all(종목 미체결 전부). " +
			"수량은 기준 자산(BTC 등), 가격은 호가 자산(USDT 등). 거래소 단위에 맞춰 서버가 내림 보정한다. " +
			"출금·이체·마진·선물은 지원하지 않는다. 사용자가 명시적으로 요청했을 때만 호출한다.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("place"), Type.Literal("cancel"), Type.Literal("replace"), Type.Literal("oco"), Type.Literal("oto"), Type.Literal("cancel_all")]),
			symbol: Type.String({ description: "예: BTCUSDT (BTC/USDT 도 된다)" }),
			side: Type.Optional(Type.Union([Type.Literal("BUY"), Type.Literal("SELL")])),
			type: Type.Optional(Type.Union([Type.Literal("LIMIT"), Type.Literal("MARKET")])),
			quantity: Type.Optional(Type.String({ description: "기준 자산 수량 (문자열, 예: '0.0012')" })),
			quoteQuantity: Type.Optional(Type.String({ description: "시장가 매수 금액 (호가 자산, 예: '100')" })),
			price: Type.Optional(Type.String()),
			orderId: Type.Optional(Type.Number({ description: "cancel·replace 대상 — data_call binance GET /api/v3/openOrders 로 확인" })),
			takeProfitPrice: Type.Optional(Type.String()),
			stopPrice: Type.Optional(Type.String()),
			stopLimitPrice: Type.Optional(Type.String({ description: "비우면 stopPrice 와 같게" })),
			buyPrice: Type.Optional(Type.String()),
			sellPrice: Type.Optional(Type.String()),
		}),
		execute: async (_id, params) => {
			if (!deps.prepareOrder) throw new Error("주문 기능이 비활성 상태입니다.");
			const creds = connected(deps.brokers.binance) as BinanceCreds | null;
			if (!creds) throw new Error("Binance 주문에는 키가 필요합니다 — 설정 → 코인 (Binance) (출금 권한 없이 발급).");
			const symbol = normSymbol(params.symbol);
			const rules = await symbolRules(symbol, creds);
			if (!rules) throw new Error(`Binance 에 없는 종목입니다: ${symbol}`);
			const last = await lastPrice(symbol, creds);

			const card: BinanceOrderCard = {
				kind: "binance-order-card", ok: false, token: null, expiresAt: null, action: params.action, symbol, base: rules.base, quote: rules.quote,
				side: params.side ?? null, type: params.type ?? null, quantity: null, quoteQuantity: null, price: null, estimatedQuote: null,
				lastPrice: last, balance: null, minNotional: cmpDec(rules.minNotional, "0") > 0 ? trim(rules.minNotional) : null,
				original: null, lines: [], orders: [], warnings: [], errors: [],
			};
			const base = { broker: "binance" as const, symbol, base: rules.base, quote: rules.quote };
			let action: BinanceAction | null = null;

			if (params.action === "cancel" || params.action === "replace" || params.action === "cancel_all") {
				const open = await openOrders(creds, symbol);
				if (params.action === "cancel_all") {
					card.orders = open;
					if (open.length === 0) card.errors.push(`${symbol} 미체결 주문이 없습니다.`);
					else action = { kind: "binance-cancel-all", ...base, count: open.length };
				} else {
					const o = open.find((x) => x.orderId === params.orderId);
					if (!o) {
						card.errors.push(`미체결 목록에 없는 주문입니다 (#${params.orderId ?? "?"}) — 이미 체결·취소됐거나 번호가 틀렸습니다.`);
						card.orders = open;
					} else {
						card.original = o;
						card.side = o.side;
						if (params.action === "cancel") action = { kind: "binance-cancel", ...base, original: o };
						else {
							if (o.type !== "LIMIT") card.errors.push(`재주문은 지정가 주문만 됩니다 (원주문 ${o.type}).`);
							// 남은 수량 — Number 로 빼면 0.3 − 0.1 = 0.19999… 가 되어 단위 내림에서 한 단위가 깎인다
							const remaining = floorToStep(subDec(o.origQty, o.executedQty), rules.stepSize);
							const v = validateBinance({ action: "place", side: o.side, type: "LIMIT", price: params.price ?? o.price, quantity: params.quantity ?? remaining }, rules, last, null);
							card.errors.push(...v.errors);
							card.warnings.push(...v.warnings);
							if (v.price && v.quantity && cmpDec(v.price, o.price) === 0 && cmpDec(v.quantity, remaining) === 0) card.errors.push("바뀌는 것이 없습니다.");
							card.price = v.price ?? null;
							card.quantity = v.quantity ?? null;
							card.lines = [
								{ label: "가격", text: `${trim(o.price)} → ${v.price ?? "?"} ${rules.quote}`, pct: null },
								{ label: "수량", text: `${trim(remaining)} → ${v.quantity ?? "?"} ${rules.base}`, pct: null },
							];
							if (v.price && v.quantity) action = { kind: "binance-replace", ...base, original: o, price: v.price, quantity: v.quantity };
						}
					}
				}
			} else {
				const free = await freeBalances(creds).catch((e: Error) => {
					card.warnings.push(`잔고를 확인하지 못했습니다: ${e.message.slice(0, 80)}`);
					return null;
				});
				const v = validateBinance(params as BinanceRequest, rules, last, free);
				card.errors.push(...v.errors);
				card.warnings.push(...v.warnings);
				card.quantity = v.quantity ?? null;
				card.quoteQuantity = v.quoteQuantity ?? null;
				card.price = v.price ?? null;
				card.estimatedQuote = v.notional ?? null;
				const balAsset = params.action === "oco" || params.side === "SELL" ? rules.base : rules.quote;
				if (free) card.balance = { asset: balAsset, free: trim(free[balAsset] ?? "0") };
				if (params.action === "place" && params.side && params.type && (v.quantity || v.quoteQuantity)) {
					action = {
						kind: "binance-place", ...base, side: params.side, type: params.type,
						...(v.quantity ? { quantity: v.quantity } : {}), ...(v.quoteQuantity ? { quoteOrderQty: v.quoteQuantity } : {}),
						...(v.price ? { price: v.price } : {}), estimatedQuote: v.notional ?? "0",
					};
				}
				if (params.action === "oco" && v.quantity && v.takeProfitPrice && v.stopPrice && v.stopLimitPrice) {
					card.side = "SELL";
					card.lines = [
						{ label: "익절", text: `지정가 ${v.takeProfitPrice} ${rules.quote}`, pct: pctDiff(v.takeProfitPrice, last) },
						{ label: "손절", text: `스톱 ${v.stopPrice} → 지정가 ${v.stopLimitPrice} ${rules.quote}`, pct: pctDiff(v.stopPrice, last) },
					];
					action = { kind: "binance-oco", ...base, quantity: v.quantity, takeProfitPrice: v.takeProfitPrice, stopPrice: v.stopPrice, stopLimitPrice: v.stopLimitPrice };
				}
				if (params.action === "oto" && v.quantity && v.buyPrice && v.sellPrice) {
					card.side = "BUY";
					card.lines = [
						{ label: "먼저 매수", text: `지정가 ${v.buyPrice} ${rules.quote}`, pct: pctDiff(v.buyPrice, last) },
						{ label: "그다음 매도", text: `지정가 ${v.sellPrice} ${rules.quote}`, pct: pctDiff(v.sellPrice, last) },
					];
					action = { kind: "binance-oto", ...base, quantity: v.quantity, buyPrice: v.buyPrice, sellPrice: v.sellPrice };
				}
			}

			if (card.errors.length > 0 || !action) {
				if (card.errors.length === 0) card.errors.push("준비할 수 없습니다 — 파라미터를 확인하세요.");
				return { content: [{ type: "text" as const, text: `Binance ${params.action} 을(를) 준비하지 못했습니다 (${symbol}).\n${card.errors.map((e) => `- ${e}`).join("\n")}` }], details: card };
			}
			const { token, expiresAt } = deps.prepareOrder(action);
			card.ok = true;
			card.token = token;
			card.expiresAt = expiresAt;
			return {
				content: [
					{
						type: "text" as const,
						text:
							`확인이 필요합니다 — [Binance] ${symbol} ${params.action}` +
							(card.quantity ? ` ${card.quantity} ${rules.base}` : card.quoteQuantity ? ` ${card.quoteQuantity} ${rules.quote}` : "") +
							(card.price ? ` @ ${card.price} ${rules.quote}` : "") +
							(card.estimatedQuote ? ` · 주문금액 약 ${card.estimatedQuote} ${rules.quote}` : "") +
							`. 현재가 ${last} ${rules.quote}. 화면의 확인 버튼을 눌러야 나갑니다 (2분 내).` +
							(card.warnings.length ? `\n⚠️ ${card.warnings.join("\n⚠️ ")}` : ""),
					},
				],
				details: card,
			};
		},
	});
}
