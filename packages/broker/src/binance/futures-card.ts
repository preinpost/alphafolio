/**
 * binance_futures 의 details 계약 — 확인 카드(binance-futures-card)·계좌 조회 결과(binance-futures-account)·손익·체결 내역(binance-futures-history).
 * 카드 모양은 protocol/src/orders.ts 의 BinanceFuturesCard 와 같다 (UI 렌더러가 이 모양에 의존한다).
 */
import type { FuturesMarginType, FuturesOriginal } from "../actions.ts";
import type { FuturesAccount, FuturesOpenOrder, FuturesPosition } from "./futures.ts";
import { DIRECTION_TEXT, summarizeIncome, type FuturesHistory, type FuturesOrderFills, type IncomeReport, type IncomeSummary } from "./futures-history.ts";
import { trim } from "./futures-validate.ts";

export type FuturesCardAction = "open" | "close" | "tpsl" | "cancel" | "cancel_all" | "settings";

export interface BinanceFuturesCard {
	kind: "binance-futures-card";
	ok: boolean;
	token: string | null;
	expiresAt: number | null;
	action: FuturesCardAction;
	symbol: string;
	base: string;
	marginAsset: string;
	/** 포지션 방향 — 진입은 새 방향, 청산·익절손절은 기존 포지션 방향 */
	direction: "LONG" | "SHORT" | null;
	type: "LIMIT" | "MARKET" | null;
	quantity: string | null;
	price: string | null;
	/** 포지션 크기 (증거금 자산) */
	notional: string | null;
	/** 필요한 증거금 */
	margin: string | null;
	leverage: number | null;
	marginType: FuturesMarginType | null;
	/** 격리 진입의 예상 청산가 · 청산·익절손절은 지금 포지션의 청산가 */
	liqPrice: string | null;
	markPrice: string | null;
	/** 주문 가능 증거금 */
	available: string | null;
	takeProfitPrice: string | null;
	stopLossPrice: string | null;
	/** 청산·익절손절 대상 포지션 */
	position: { amt: string; entryPrice: string; unrealized: string; liquidationPrice: string } | null;
	/** 취소 대상 (전체 취소면 목록) */
	orders: FuturesOriginal[];
	/** 설정 변경 등 보조 줄 */
	lines: Array<{ label: string; text: string }>;
	warnings: string[];
	errors: string[];
}

export function emptyCard(action: FuturesCardAction, symbol: string): BinanceFuturesCard {
	return {
		kind: "binance-futures-card", ok: false, token: null, expiresAt: null, action, symbol, base: "", marginAsset: "USDT",
		direction: null, type: null, quantity: null, price: null, notional: null, margin: null, leverage: null, marginType: null,
		liqPrice: null, markPrice: null, available: null, takeProfitPrice: null, stopLossPrice: null, position: null,
		orders: [], lines: [], warnings: [], errors: [],
	};
}

// ── 계좌 조회 ───────────────────────────────────────────────

export interface BinanceFuturesAccountDetails {
	kind: "binance-futures-account";
	account: FuturesAccount | null;
	positions: FuturesPosition[] | null;
	orders: FuturesOpenOrder[] | null;
	hedge: boolean | null;
	multiAssets: boolean | null;
	warnings: string[];
}

const num = (v: string, digits = 4): string => Number(v).toLocaleString("en-US", { maximumFractionDigits: digits });
const signed = (v: string): string => `${Number(v) >= 0 ? "+" : ""}${num(v, 2)}`;

export function positionLine(p: FuturesPosition): string {
	const long = Number(p.amt) > 0;
	const side = p.positionSide === "BOTH" ? (long ? "롱" : "숏") : p.positionSide === "LONG" ? "롱(LONG)" : "숏(SHORT)";
	const roe = Number(p.isolatedMargin) > 0 ? ` (${signed(String((Number(p.unrealized) / Number(p.isolatedMargin)) * 100))}% · 격리)` : "";
	return (
		`- ${p.symbol} ${side} ${trim(p.amt.replace(/^-/, ""))} · 진입 ${num(p.entryPrice)} · 표시 ${num(p.markPrice)} · 미실현 ${signed(p.unrealized)} ${p.marginAsset}${roe}` +
		` · 크기 ${num(p.notional.replace(/^-/, ""), 2)} · 청산가 ${Number(p.liquidationPrice) > 0 ? num(p.liquidationPrice) : "—"}`
	);
}

export function orderLine(o: FuturesOpenOrder): string {
	const what = o.closePosition ? "포지션 전체" : trim(o.quantity);
	const px = Number(o.price) > 0 ? ` @ ${trim(o.price)}` : " 시장가";
	const trig = o.triggerPrice ? ` · 트리거 ${trim(o.triggerPrice)}` : "";
	const flags = [o.reduceOnly ? "reduceOnly" : "", o.positionSide !== "BOTH" ? o.positionSide : ""].filter(Boolean).join(" ");
	return `- ${o.symbol} ${o.side === "BUY" ? "매수" : "매도"} ${o.type} ${what}${px}${trig}${flags ? ` (${flags})` : ""} · ${o.source === "algo" ? "algoId" : "orderId"}=${o.id}`;
}

export function accountText(d: BinanceFuturesAccountDetails): string {
	const lines = ["[Binance USDⓈ-M 선물]"];
	const a = d.account;
	if (a) {
		lines.push(
			`지갑 ${num(a.totalWalletBalance, 2)} · 미실현 ${signed(a.totalUnrealizedProfit)} · 증거금 잔고 ${num(a.totalMarginBalance, 2)} · 주문 가능 ${num(a.availableBalance, 2)} (USD 환산)`,
			`사용 중 증거금 ${num(a.totalInitialMargin, 2)} · 유지증거금 ${num(a.totalMaintMargin, 2)}`,
		);
		const held = a.assets.filter((x) => Number(x.walletBalance) !== 0 || Number(x.marginBalance) !== 0);
		for (const x of held) lines.push(`- ${x.asset}: 지갑 ${trim(x.walletBalance)} · 주문 가능 ${trim(x.availableBalance)} · 옮길 수 있음 ${trim(x.maxWithdrawAmount)}`);
		if (held.length === 0) lines.push("- 선물 지갑이 비어 있습니다 — 거래하려면 binance_wallet 으로 현물·펀딩 → 선물(FUTURES) 이동");
	}
	if (d.hedge !== null || d.multiAssets !== null) {
		lines.push(
			`모드: 포지션 ${d.hedge === null ? "?" : d.hedge ? "양방향(Hedge)" : "단방향(One-way)"} · 멀티에셋 ${d.multiAssets === null ? "?" : d.multiAssets ? "켜짐" : "꺼짐"}`,
		);
	}
	if (d.positions) {
		lines.push("", `열린 포지션 ${d.positions.length}개`);
		for (const p of d.positions) lines.push(positionLine(p));
	}
	if (d.orders) {
		lines.push("", `미체결 ${d.orders.length}건 (익절·손절 등 조건부 포함)`);
		for (const o of d.orders) lines.push(orderLine(o));
	}
	if (d.warnings.length) lines.push("", ...d.warnings.map((w) => `⚠️ ${w}`));
	return lines.join("\n");
}

// ── 손익·체결 내역 ──────────────────────────────────────────

/** 텍스트에 싣는 주문 수 — 나머지는 종목·기간을 좁혀서 */
const HISTORY_PREVIEW = 30;
/** details 에 싣는 주문 수 */
const HISTORY_DETAILS = 200;

export interface BinanceFuturesHistoryDetails {
	kind: "binance-futures-history";
	from: number;
	to: number;
	days: number;
	symbol: string | null;
	income: IncomeReport;
	/** 체결을 훑은 종목 */
	symbols: string[];
	/** 주문 단위 체결, 최근 순 (최대 200) */
	orders: FuturesOrderFills[];
	orderCount: number;
	warnings: string[];
}

export function historyDetails(h: FuturesHistory, days: number, symbol: string | null): BinanceFuturesHistoryDetails {
	return {
		kind: "binance-futures-history",
		from: h.from,
		to: h.to,
		days,
		symbol,
		income: summarizeIncome(h.income),
		symbols: h.symbols,
		orders: h.orders.slice(0, HISTORY_DETAILS),
		orderCount: h.orders.length,
		warnings: h.warnings,
	};
}

/** 손익 — 펀딩비처럼 작은 값이 0 으로 보이지 않게 소수 넷째 자리까지 */
const pm = (v: number): string => `${v >= 0 ? "+" : ""}${v.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;

/** KST "10-12 14:03" */
const kstShort = (t: number): string => new Date(t + 9 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");

function incomeLine(s: IncomeSummary): string {
	const parts = [`실현 ${pm(s.realized)}`, `수수료 ${pm(s.commission)}`];
	if (s.funding !== 0) parts.push(`펀딩비 ${pm(s.funding)}`);
	if (s.other !== 0) parts.push(`기타 ${pm(s.other)}`);
	return `- ${s.symbol || "합계"}: ${parts.join(" · ")} → 순손익 ${pm(s.net)} ${s.asset}`;
}

export function historyOrderLine(o: FuturesOrderFills): string {
	const pnl = o.realizedPnl !== 0 ? ` · 실현 ${pm(o.realizedPnl)}` : "";
	const fee = o.commission === null ? " · 수수료 여러 자산" : o.commission > 0 ? ` · 수수료 ${num(String(o.commission), 6)} ${o.commissionAsset}` : "";
	const fills = o.fills > 1 ? ` (${o.fills}회 체결)` : "";
	return `- ${kstShort(o.at)} ${o.symbol} ${DIRECTION_TEXT[o.direction]} (${o.side === "BUY" ? "매수" : "매도"}) ${trim(String(o.qty))} @ ${num(String(o.price))}${fills}${pnl}${fee} · orderId=${o.orderId}`;
}

export function historyText(d: BinanceFuturesHistoryDetails): string {
	const lines = [`[Binance USDⓈ-M 선물 내역 — ${d.symbol ?? "전 종목"} · 최근 ${d.days}일 (${kstShort(d.from)} ~ ${kstShort(d.to)} KST)]`];
	const inc = d.income;
	if (inc.totals.length === 0) lines.push("손익 기록이 없습니다 (이 기간에 체결·펀딩비가 없었다).");
	else {
		lines.push("손익 (Binance 손익 내역 기준 · 펀딩비·수수료는 음수가 낸 것)");
		for (const t of inc.totals) lines.push(incomeLine(t));
		if (inc.bySymbol.length > 1 || d.symbol === null) for (const s of inc.bySymbol) lines.push(incomeLine(s));
	}
	if (inc.moves.length) lines.push(`입출금 (손익 아님): ${inc.moves.map((m) => `${m.asset} ${pm(m.amount)}`).join(" · ")}`);
	lines.push("", `체결 ${d.orderCount}건 (주문 단위 · 최근 순${d.orderCount > HISTORY_PREVIEW ? ` · 앞 ${HISTORY_PREVIEW}건만` : ""})`);
	for (const o of d.orders.slice(0, HISTORY_PREVIEW)) lines.push(historyOrderLine(o));
	if (d.orderCount === 0 && d.symbols.length === 0 && inc.totals.length > 0) lines.push("- 체결을 훑을 종목을 찾지 못했습니다");
	lines.push("", "진입·청산은 양방향 모드면 포지션 기준, 단방향 모드면 실현손익이 있는 체결을 청산으로 본다. Binance 는 최근 3개월까지만 준다.");
	if (d.warnings.length) lines.push(...d.warnings.map((w) => `⚠️ ${w}`));
	return lines.join("\n");
}
