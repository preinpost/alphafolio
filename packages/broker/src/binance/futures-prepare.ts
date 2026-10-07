/**
 * binance_futures 동작별 준비 — Binance 조회 → 검증(futures-validate.ts) → 확인 카드 + 토큰.
 * 실행하지 않는다. 원주문·포지션·종목 설정·계정 모드는 서버가 Binance 에서 조회한 값이다 (모델 값을 믿지 않는다).
 */
import type { BinanceFuturesAction, FuturesMarginType, FuturesPositionSide, OrderAction } from "../actions.ts";
import { emptyCard, orderLine, positionLine, type BinanceFuturesCard, type FuturesCardAction } from "./futures-card.ts";
import { trim, validateClose, validateOpen, validateTpsl } from "./futures-validate.ts";
import {
	futuresAccount,
	futuresHedgeMode,
	futuresMark,
	futuresMultiAssets,
	futuresOpenOrders,
	futuresPositions,
	futuresRules,
	futuresSymbolConfig,
	leverageBrackets,
	type FuturesPosition,
	type FuturesRules,
} from "./futures.ts";
import type { BinanceCreds } from "./trade.ts";

export interface PrepareDeps {
	creds: BinanceCreds;
	prepareOrder: (a: OrderAction) => { token: string; expiresAt: number };
}

export interface Prepared {
	content: Array<{ type: "text"; text: string }>;
	details: BinanceFuturesCard;
}

export interface FuturesParams {
	symbol: string;
	side?: "BUY" | "SELL";
	type?: "LIMIT" | "MARKET";
	quantity?: string;
	notional?: string;
	margin?: string;
	price?: string;
	leverage?: number;
	marginType?: FuturesMarginType;
	takeProfitPrice?: string;
	stopLossPrice?: string;
	/** 양방향 모드에서 청산·익절손절할 포지션 */
	positionSide?: "LONG" | "SHORT";
	orderId?: number;
	algoId?: number;
}

const ACTION_TEXT: Record<FuturesCardAction, string> = {
	open: "진입",
	close: "청산",
	tpsl: "익절·손절",
	cancel: "취소",
	cancel_all: "전체 취소",
	settings: "설정 변경",
};

const marginText = (m: FuturesMarginType): string => (m === "ISOLATED" ? "격리" : "교차");

/** 종목 규칙 — 없거나 무기한이 아니면 사용자에게 바로 알린다 */
export async function symbolRulesOrThrow(symbol: string, c: BinanceCreds): Promise<FuturesRules> {
	const rules = await futuresRules(symbol, c);
	if (!rules) throw new Error(`Binance USDⓈ-M 선물에 없는 종목입니다: ${symbol} (예: BTCUSDT · ETHUSDT)`);
	return rules;
}

function fill(card: BinanceFuturesCard, rules: FuturesRules): void {
	card.base = rules.base;
	card.marginAsset = rules.marginAsset;
	if (rules.contractType && rules.contractType !== "PERPETUAL") card.warnings.push(`${rules.symbol} 은(는) 만기가 있는 계약입니다 (${rules.contractType}).`);
}

/** 카드를 마무리한다 — 오류가 있으면 토큰 없이, 없으면 토큰을 붙인다 */
export function finish(card: BinanceFuturesCard, action: BinanceFuturesAction | null, deps: PrepareDeps, summary: string): Prepared {
	if (card.errors.length > 0 || !action) {
		if (card.errors.length === 0) card.errors.push("준비할 수 없습니다 — 파라미터를 확인하세요.");
		return {
			content: [{ type: "text", text: `Binance 선물 ${ACTION_TEXT[card.action]}을(를) 준비하지 못했습니다 (${card.symbol}).\n${card.errors.map((e) => `- ${e}`).join("\n")}` }],
			details: card,
		};
	}
	const { token, expiresAt } = deps.prepareOrder(action);
	card.ok = true;
	card.token = token;
	card.expiresAt = expiresAt;
	return {
		content: [
			{
				type: "text",
				text:
					`확인이 필요합니다 — [Binance 선물] ${card.symbol} ${summary}` +
					(card.markPrice ? ` · 표시가격 ${trim(card.markPrice)}` : "") +
					". 화면의 확인 버튼을 눌러야 나갑니다 (2분 내)." +
					(card.warnings.length ? `\n⚠️ ${card.warnings.join("\n⚠️ ")}` : ""),
			},
		],
		details: card,
	};
}

/** 단방향은 BOTH, 양방향은 진입 방향 */
const openSide = (hedge: boolean, side: "BUY" | "SELL"): FuturesPositionSide => (hedge ? (side === "BUY" ? "LONG" : "SHORT") : "BOTH");

// ── 진입 ────────────────────────────────────────────────────

export async function prepareOpen(p: FuturesParams, deps: PrepareDeps): Promise<Prepared> {
	const c = deps.creds;
	const card = emptyCard("open", p.symbol);
	const rules = await symbolRulesOrThrow(p.symbol, c);
	fill(card, rules);
	if (!p.side || !p.type) {
		card.errors.push("side(BUY=롱 · SELL=숏)와 type(LIMIT·MARKET)이 필요합니다.");
		return finish(card, null, deps, "");
	}
	const [mark, config, hedge, multi, brackets, positions, orders, account] = await Promise.all([
		futuresMark(p.symbol, c),
		futuresSymbolConfig(c, p.symbol),
		futuresHedgeMode(c),
		futuresMultiAssets(c),
		leverageBrackets(c, p.symbol),
		futuresPositions(c, p.symbol),
		futuresOpenOrders(c, p.symbol),
		futuresAccount(c).catch((e: Error) => {
			card.warnings.push(`증거금을 확인하지 못했습니다: ${e.message.slice(0, 80)}`);
			return null;
		}),
	]);
	const leverage = p.leverage ?? config.leverage;
	const marginType = p.marginType ?? config.marginType;
	const asset = account?.assets.find((a) => a.asset === rules.marginAsset);
	const available = account ? (multi ? account.availableBalance : (asset?.availableBalance ?? "0")) : null;

	const v = validateOpen(
		{ side: p.side, type: p.type, quantity: p.quantity, notional: p.notional, margin: p.margin, price: p.price, leverage, marginType, takeProfitPrice: p.takeProfitPrice, stopLossPrice: p.stopLossPrice },
		{ rules, mark: mark.markPrice, available, brackets, current: config, hasPosition: positions.length > 0, hasOpenOrders: orders.length > 0 },
	);
	card.errors.push(...v.errors);
	card.warnings.push(...v.warnings);
	Object.assign(card, {
		direction: p.side === "BUY" ? "LONG" : "SHORT", type: p.type, quantity: v.quantity ?? null, price: v.price ?? null, notional: v.notional ?? null,
		margin: v.margin ?? null, leverage, marginType, liqPrice: v.liqPrice, markPrice: mark.markPrice, available,
		takeProfitPrice: v.takeProfitPrice ?? null, stopLossPrice: v.stopLossPrice ?? null,
	});
	if (leverage !== config.leverage) card.lines.push({ label: "레버리지", text: `${config.leverage}x → ${leverage}x` });
	if (marginType !== config.marginType) card.lines.push({ label: "증거금 방식", text: `${marginText(config.marginType)} → ${marginText(marginType)}` });
	const same = positions.find((x) => (Number(x.amt) > 0) === (p.side === "BUY"));
	const opposite = positions.find((x) => (Number(x.amt) > 0) !== (p.side === "BUY"));
	if (same) card.warnings.push(`이미 같은 방향 포지션이 있어 더해집니다: ${positionLine(same).slice(2)}`);
	if (opposite && !hedge) card.warnings.push("단방향 모드 — 반대 포지션이 있어 이 주문은 그 포지션을 먼저 줄입니다 (넘치면 방향이 바뀝니다). 청산이면 action=close 를 쓰세요.");
	if (Number(mark.fundingRate) !== 0) {
		card.lines.push({ label: "펀딩", text: `최근 ${(Number(mark.fundingRate) * 100).toFixed(4)}% / 8시간 (${Number(mark.fundingRate) > 0 ? "롱이 냄" : "숏이 냄"})` });
	}

	let action: BinanceFuturesAction | null = null;
	if (v.errors.length === 0 && v.quantity) {
		action = {
			kind: "binance-futures-open", broker: "binance", symbol: p.symbol, base: rules.base, marginAsset: rules.marginAsset,
			side: p.side, positionSide: openSide(hedge, p.side), type: p.type, quantity: v.quantity, ...(v.price ? { price: v.price } : {}),
			leverage, marginType, current: config, estimatedNotional: v.notional ?? "0",
			...(v.takeProfitPrice ? { takeProfitPrice: v.takeProfitPrice } : {}), ...(v.stopLossPrice ? { stopLossPrice: v.stopLossPrice } : {}),
		};
	}
	const summary =
		`${p.side === "BUY" ? "롱" : "숏"} ${v.quantity ?? "?"} ${rules.base} ${p.type === "LIMIT" ? `지정가 ${v.price}` : "시장가"} · ${leverage}x ${marginText(marginType)}` +
		(v.notional ? ` · 크기 약 ${Number(v.notional).toFixed(2)} · 증거금 약 ${v.margin} ${rules.marginAsset}` : "") +
		(v.liqPrice ? ` · 예상 청산가 ${v.liqPrice}` : "") +
		(v.stopLossPrice ? ` · 손절 ${v.stopLossPrice}` : "") +
		(v.takeProfitPrice ? ` · 익절 ${v.takeProfitPrice}` : "");
	return finish(card, action, deps, summary);
}

// ── 종목 설정 ───────────────────────────────────────────────

export async function prepareSettings(p: FuturesParams, deps: PrepareDeps): Promise<Prepared> {
	const c = deps.creds;
	const card = emptyCard("settings", p.symbol);
	const rules = await symbolRulesOrThrow(p.symbol, c);
	fill(card, rules);
	if (p.leverage === undefined && !p.marginType) {
		card.errors.push("leverage 또는 marginType(ISOLATED·CROSSED)이 필요합니다.");
		return finish(card, null, deps, "");
	}
	const [config, brackets, positions, orders] = await Promise.all([
		futuresSymbolConfig(c, p.symbol),
		leverageBrackets(c, p.symbol),
		futuresPositions(c, p.symbol),
		futuresOpenOrders(c, p.symbol),
	]);
	const maxLev = brackets[0]?.initialLeverage ?? 125;
	if (p.leverage !== undefined) {
		if (!Number.isInteger(p.leverage) || p.leverage < 1) card.errors.push(`레버리지는 1 이상 정수여야 합니다: ${p.leverage}`);
		else if (p.leverage > maxLev) card.errors.push(`${p.symbol} 최대 레버리지는 ${maxLev}x 입니다.`);
		else if (p.leverage !== config.leverage) card.lines.push({ label: "레버리지", text: `${config.leverage}x → ${p.leverage}x` });
	}
	if (p.marginType && p.marginType !== config.marginType) {
		if (positions.length > 0 || orders.length > 0) card.errors.push("포지션·미체결이 있는 동안은 증거금 방식을 바꿀 수 없습니다.");
		else card.lines.push({ label: "증거금 방식", text: `${marginText(config.marginType)} → ${marginText(p.marginType)}` });
	}
	if (card.errors.length === 0 && card.lines.length === 0) card.errors.push(`이미 ${config.leverage}x ${marginText(config.marginType)} 입니다 — 바뀌는 것이 없습니다.`);
	card.leverage = p.leverage ?? config.leverage;
	card.marginType = p.marginType ?? config.marginType;
	if (positions.length > 0 && p.leverage !== undefined && p.leverage > config.leverage) card.warnings.push("열린 포지션의 레버리지도 함께 올라가 청산가가 가까워집니다.");
	const action: BinanceFuturesAction | null =
		card.errors.length === 0
			? {
					kind: "binance-futures-settings", broker: "binance", symbol: p.symbol, base: rules.base, marginAsset: rules.marginAsset, current: config,
					...(p.leverage !== undefined ? { leverage: p.leverage } : {}), ...(p.marginType ? { marginType: p.marginType } : {}),
				}
			: null;
	return finish(card, action, deps, `설정 ${card.lines.map((l) => `${l.label} ${l.text}`).join(" · ")}`);
}

// ── 청산·익절손절·취소 (아래) ───────────────────────────────

/** 대상 포지션 — 단방향은 하나, 양방향은 positionSide 로 고른다. 못 고르면 오류를 카드에 */
export function pickPosition(positions: FuturesPosition[], hedge: boolean, want: "LONG" | "SHORT" | undefined, card: BinanceFuturesCard): FuturesPosition | null {
	if (positions.length === 0) {
		card.errors.push(`${card.symbol} 열린 포지션이 없습니다.`);
		return null;
	}
	if (!hedge) return positions[0]!;
	if (want) {
		const hit = positions.find((x) => x.positionSide === want);
		if (!hit) card.errors.push(`${card.symbol} ${want} 포지션이 없습니다.`);
		return hit ?? null;
	}
	if (positions.length === 1) return positions[0]!;
	card.errors.push(`양방향 모드 — LONG·SHORT 포지션이 모두 있습니다. positionSide 를 정해 주세요.\n${positions.map(positionLine).join("\n")}`);
	return null;
}


const directionOf = (pos: FuturesPosition): "LONG" | "SHORT" => (Number(pos.amt) > 0 ? "LONG" : "SHORT");
const positionView = (pos: FuturesPosition): BinanceFuturesCard["position"] => ({
	amt: pos.amt,
	entryPrice: pos.entryPrice,
	unrealized: pos.unrealized,
	liquidationPrice: pos.liquidationPrice,
});

/** 청산·익절손절 공통 — 규칙·표시가격·모드·포지션 */
async function positionContext(p: FuturesParams, c: BinanceCreds, card: BinanceFuturesCard) {
	const rules = await symbolRulesOrThrow(p.symbol, c);
	fill(card, rules);
	const [mark, hedge, positions] = await Promise.all([futuresMark(p.symbol, c), futuresHedgeMode(c), futuresPositions(c, p.symbol)]);
	card.markPrice = mark.markPrice;
	const pos = pickPosition(positions, hedge, p.positionSide, card);
	if (pos) {
		card.position = positionView(pos);
		card.direction = directionOf(pos);
		card.liqPrice = Number(pos.liquidationPrice) > 0 ? pos.liquidationPrice : null;
	}
	return { rules, mark: mark.markPrice, pos };
}

// ── 청산 ────────────────────────────────────────────────────

export async function prepareClose(p: FuturesParams, deps: PrepareDeps): Promise<Prepared> {
	const card = emptyCard("close", p.symbol);
	const { rules, mark, pos } = await positionContext(p, deps.creds, card);
	if (!pos) return finish(card, null, deps, "");
	const type = p.type ?? "MARKET";
	const v = validateClose({ type, quantity: p.quantity, price: p.price }, rules, mark, pos);
	card.errors.push(...v.errors);
	card.warnings.push(...v.warnings);
	Object.assign(card, { type, quantity: v.quantity ?? null, price: v.price ?? null });
	const all = v.quantity !== undefined && v.quantity === trim(pos.amt.replace(/^-/, ""));
	if (!all && v.quantity) card.warnings.push("일부 청산 — 남은 포지션의 익절·손절(포지션 전체 조건)은 그대로 남습니다.");
	const action: BinanceFuturesAction | null =
		v.errors.length === 0 && v.quantity
			? {
					kind: "binance-futures-close", broker: "binance", symbol: p.symbol, base: rules.base, marginAsset: rules.marginAsset,
					side: v.side, positionSide: pos.positionSide, type, quantity: v.quantity, ...(v.price ? { price: v.price } : {}), positionAmt: pos.amt,
				}
			: null;
	const dir = directionOf(pos) === "LONG" ? "롱" : "숏";
	return finish(card, action, deps, `${dir} ${all ? "전량 " : ""}청산 ${v.quantity ?? "?"} ${rules.base} ${type === "LIMIT" ? `지정가 ${v.price}` : "시장가"} · 미실현 ${pos.unrealized} ${rules.marginAsset}`);
}

// ── 열린 포지션에 익절·손절 ─────────────────────────────────

export async function prepareTpsl(p: FuturesParams, deps: PrepareDeps): Promise<Prepared> {
	const card = emptyCard("tpsl", p.symbol);
	const { rules, mark, pos } = await positionContext(p, deps.creds, card);
	if (!pos) return finish(card, null, deps, "");
	const v = validateTpsl({ takeProfitPrice: p.takeProfitPrice, stopLossPrice: p.stopLossPrice }, rules, mark, pos);
	card.errors.push(...v.errors);
	card.warnings.push(...v.warnings);
	card.takeProfitPrice = v.takeProfitPrice ?? null;
	card.stopLossPrice = v.stopLossPrice ?? null;
	// 이미 걸린 포지션 전체 조건 — 새로 걸면 둘 다 살아 있다 (먼저 닿는 쪽이 닫는다)
	const existing = (await futuresOpenOrders(deps.creds, p.symbol).catch(() => [])).filter((o) => o.source === "algo" && o.closePosition && o.positionSide === pos.positionSide);
	if (existing.length > 0) {
		card.orders = existing;
		card.warnings.push(`이미 걸린 익절·손절 ${existing.length}건이 있습니다 — 바꾸려면 먼저 취소하세요 (action=cancel algoId).\n${existing.map(orderLine).join("\n")}`);
	}
	const side = Number(pos.amt) > 0 ? "SELL" : "BUY";
	const action: BinanceFuturesAction | null =
		v.errors.length === 0
			? {
					kind: "binance-futures-tpsl", broker: "binance", symbol: p.symbol, base: rules.base, marginAsset: rules.marginAsset, side, positionSide: pos.positionSide,
					...(v.takeProfitPrice ? { takeProfitPrice: v.takeProfitPrice } : {}), ...(v.stopLossPrice ? { stopLossPrice: v.stopLossPrice } : {}),
				}
			: null;
	const dir = directionOf(pos) === "LONG" ? "롱" : "숏";
	return finish(card, action, deps, `${dir} ${trim(pos.amt.replace(/^-/, ""))} ${rules.base}${v.stopLossPrice ? ` · 손절 ${v.stopLossPrice}` : ""}${v.takeProfitPrice ? ` · 익절 ${v.takeProfitPrice}` : ""}`);
}

// ── 취소 ────────────────────────────────────────────────────

export async function prepareCancel(p: FuturesParams, deps: PrepareDeps, all: boolean): Promise<Prepared> {
	const card = emptyCard(all ? "cancel_all" : "cancel", p.symbol);
	const rules = await symbolRulesOrThrow(p.symbol, deps.creds);
	fill(card, rules);
	const open = await futuresOpenOrders(deps.creds, p.symbol);
	const base = { broker: "binance" as const, symbol: p.symbol, base: rules.base, marginAsset: rules.marginAsset };

	if (all) {
		card.orders = open;
		const orders = open.filter((o) => o.source === "order").length;
		const algo = open.length - orders;
		if (open.length === 0) card.errors.push(`${p.symbol} 미체결 주문이 없습니다.`);
		if (algo > 0) card.warnings.push(`익절·손절 ${algo}건도 함께 취소됩니다 — 포지션이 보호되지 않게 됩니다.`);
		const action: BinanceFuturesAction | null = open.length > 0 ? { kind: "binance-futures-cancel-all", ...base, orders, algo } : null;
		return finish(card, action, deps, `미체결 ${open.length}건 전체 취소 (일반 ${orders} · 조건부 ${algo})`);
	}

	const o =
		p.algoId !== undefined ? open.find((x) => x.source === "algo" && x.id === p.algoId) : p.orderId !== undefined ? open.find((x) => x.source === "order" && x.id === p.orderId) : undefined;
	if (!o) {
		card.orders = open;
		card.errors.push(
			p.orderId === undefined && p.algoId === undefined
				? `취소할 orderId(일반) 또는 algoId(익절·손절 등 조건부)를 골라 주세요 (${p.symbol} 미체결 ${open.length}건).`
				: `미체결 목록에 없는 주문입니다 (${p.algoId !== undefined ? `algoId ${p.algoId}` : `orderId ${p.orderId}`}) — 이미 체결·취소됐거나 번호가 틀렸습니다.`,
		);
		for (const x of open) card.errors.push(`  ${orderLine(x)}`);
		return finish(card, null, deps, "");
	}
	card.orders = [o];
	if (o.source === "algo" && o.closePosition) card.warnings.push("익절·손절을 취소하면 포지션이 그만큼 보호되지 않습니다.");
	const { symbol: _s, positionSide: _ps, reduceOnly: _r, ...original } = o;
	return finish(card, { kind: "binance-futures-cancel", ...base, original }, deps, `취소 ${orderLine(o).slice(2)}`);
}
