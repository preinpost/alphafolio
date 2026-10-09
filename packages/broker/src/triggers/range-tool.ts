/** range_trade — 전략 준비만 한다. 실제 시작은 사용자가 확인 카드에서 승인한다. */
import { Type, type Static } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { symbolRules } from "../binance/trade.ts";
import { bStockStatus } from "../binance/bstocks.ts";
import { fetchWatchBars } from "./bars.ts";
import { validateCondition } from "./condition.ts";
import { conditionText, VENUE_LABEL } from "./describe.ts";
import { barCloseAt, FEED_LABEL, isStock } from "./market-time.ts";
import { cryptoAutoProblem, currencyOf, moneyText, planOrder, sizeText, unitOf, validateOrderRule } from "./rule.ts";
import {
	initialRangeState,
	rangeCondition,
	rangeCostText,
	RANGE_FOREVER,
	RANGE_RISK_MS,
	rangeStopText,
	validateRange,
	type RangeTrade,
} from "./range.ts";
import { cryptoGrid } from "./venues/binance.ts";
import type { Grid } from "./venues/types.ts";
import { INTERVALS, VENUES, type Condition, type OrderRule, type OrderSize, type OrderTarget, type TriggerSpec, type Venue } from "./types.ts";
import { chooseFeed, guessVenue, summaryLine } from "./tool-helpers.ts";
import type { WatchConfirmCard, WatchToolDeps } from "./tool.ts";

const DESCRIPTION = [
	"사용자가 정한 봉 주기와 매수·매도 가격으로 현물 박스권 매매를 반복한다.",
	"매수 체결 후 전략 보유분만 매도하고 다시 매수를 기다린다.",
	"로스컷은 고정 가격(stopPrice) 또는 비용 포함 평가손실률(stopPct, 양수) 중 하나다.",
	"로스컷은 봉 마감과 별개로 현재 매수호가를 5초 주기로 조회하며, 손절 후 재매수 없이 정지한다.",
	"거래소에 상주하는 손절 주문이 아니므로 서버·시세·시장 운영 시간에 의존한다.",
	"매수·매도 비용률(%, 세금 포함)은 사용자에게 확인하고 반드시 명시한다.",
	"실제 비용을 확인하면 사용하고 아니면 추정값으로 표시한다.",
	"action=prepare는 확인 카드만 준비한다. 켜기·재개는 사용자가 앱에서 한다.",
	"action=list/pause는 watch_alert와 같은 감시 저장소를 사용한다.",
	"KIS·토스 국장/미장, Binance 현물 USDT 코인을 지원한다. bStock·선물·레버리지는 제외한다.",
	"종목·계좌·봉 주기·가격 범위·규모·로스컷·비용률이 없으면 추측하지 말고 사용자에게 묻는다.",
].join(" ");

const RangeParamsSchema = Type.Object({
	action: Type.Union([Type.Literal("prepare"), Type.Literal("list"), Type.Literal("pause")]),
	id: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	symbol: Type.Optional(Type.String()),
	market: Type.Optional(Type.Union(VENUES.map((venue) => Type.Literal(venue)))),
	broker: Type.Optional(Type.Union([Type.Literal("kis"), Type.Literal("toss"), Type.Literal("binance")])),
	interval: Type.Optional(Type.Union(INTERVALS.map((interval) => Type.Literal(interval)))),
	buyPrice: Type.Optional(Type.Number({ description: "봉 종가 매수 기준가. 실제 주문도 이 가격 이하만 허용" })),
	sellPrice: Type.Optional(Type.Number({ description: "봉 종가 매도 기준가. 정상 매도 주문도 이 가격 이상만 허용" })),
	amount: Type.Optional(Type.Number({ description: "회당 매수 예산 (시장 통화, 설정한 매수 비용률 포함)" })),
	shares: Type.Optional(Type.Integer({ description: "회당 주 수 (주식)" })),
	qty: Type.Optional(Type.Number({ description: "회당 코인 수량" })),
	stopPrice: Type.Optional(Type.Number({ description: "고정 손절 가격. stopPct와 하나만" })),
	stopPct: Type.Optional(Type.Number({ description: "비용 포함 평가손실률, 양수로 입력 (5 = −5%). stopPrice와 하나만" })),
	buyCostPct: Type.Optional(Type.Number({ description: "미확인 매수 비용 추정률(%, 0도 명시적으로 확인). 자동 기본값 없음" })),
	sellCostPct: Type.Optional(Type.Number({ description: "미확인 매도 비용 추정률(%, 수수료·매도세 포함). 자동 기본값 없음" })),
});

type Params = Static<typeof RangeParamsSchema>;

function readRange(params: Params): RangeTrade {
	const { buyPrice, sellPrice, buyCostPct, sellCostPct, stopPrice, stopPct } = params;
	if (buyPrice === undefined || sellPrice === undefined || buyCostPct === undefined || sellCostPct === undefined) {
		throw new Error("매수·매도 기준가와 매수·매도 비용률을 모두 확인해야 합니다 (비용률을 0으로 가정하지 않습니다)");
	}
	if ((stopPrice === undefined) === (stopPct === undefined)) {
		throw new Error("로스컷은 stopPrice 또는 stopPct 중 하나만 정합니다");
	}
	const range: RangeTrade = {
		buyPrice, sellPrice, buyCostPct, sellCostPct,
		stop: stopPrice !== undefined ? { price: stopPrice } : { pct: stopPct! },
		state: initialRangeState(),
	};
	const errors = validateRange(range);
	if (errors.length) throw new Error(errors.join("\n"));
	return range;
}

function readCondition(params: Params, range: RangeTrade, deps: WatchToolDeps): Condition {
	if (!params.symbol?.trim() || !params.interval) throw new Error("종목과 봉 주기를 사용자에게 확인해 주세요");
	const raw = params.symbol.trim().toUpperCase();
	const venue = params.market ?? guessVenue(raw.replace(/[^A-Z0-9]/g, ""));
	const symbol = venue === "us" ? raw.replace(/[^A-Z0-9.-]/g, "") : raw.replace(/[^A-Z0-9]/g, "");
	const feed = isStock(venue) ? chooseFeed(venue, deps.feeds?.() ?? { kis: false, toss: false }) : undefined;
	const condition = rangeCondition({
		market: { venue, symbol, ...(feed ? { feed } : {}) },
		interval: params.interval,
	}, range);
	const errors = validateCondition(condition);
	if (errors.length) throw new Error(errors.join("\n"));
	return condition;
}

function readOrder(params: Params, venue: Venue, grid: Grid | null): OrderRule {
	if ([params.amount, params.shares, params.qty].filter((value) => value !== undefined).length !== 1) {
		throw new Error("매수 규모는 amount·shares·qty 중 하나만 정합니다");
	}
	const crypto = venue === "binance";
	if ((crypto && params.shares !== undefined) || (!crypto && params.qty !== undefined)) {
		throw new Error("주식은 shares 또는 amount, 코인은 qty 또는 amount를 사용합니다");
	}
	let size: OrderSize;
	if (params.amount !== undefined) size = { amount: params.amount };
	else if (params.shares !== undefined) size = { shares: params.shares };
	else size = { qty: grid ? grid.floorQty(params.qty!) : params.qty! };

	const order: OrderRule = { side: "BUY", size, worstPct: 1, urgency: "immediate", deadlineSec: 30 };
	const errors = validateOrderRule(order);
	if (errors.length) throw new Error(errors.join("\n"));
	return order;
}

async function requireCryptoGrid(symbol: string, deps: WatchToolDeps): Promise<Grid> {
	const problem = cryptoAutoProblem(symbol);
	if (problem) throw new Error(problem);
	const status = await (deps.bStockStatus ?? bStockStatus)(symbol);
	if (status !== "coin") throw new Error("반복매매는 확인된 현물 코인만 지원합니다 (bStock 제외)");
	if (deps.cryptoRules) {
		const grid = await deps.cryptoRules(symbol);
		if (!grid) throw new Error("코인 종목 규칙을 확인하지 못했습니다");
		return grid;
	}
	const rules = await symbolRules(symbol);
	if (!rules || rules.status !== "TRADING" || !rules.spot || !rules.orderTypes.includes("LIMIT")) {
		throw new Error("지정가 주문이 가능한 현물 코인 종목 규칙을 확인하지 못했습니다");
	}
	return cryptoGrid(rules);
}

async function requireTarget(params: Params, venue: Venue, deps: WatchToolDeps): Promise<OrderTarget> {
	const all = await deps.orderTargets?.() ?? [];
	const targets = all.filter((target) => venue === "binance"
		? target.broker === "binance"
		: target.broker === "kis" || target.broker === "toss");
	const target = params.broker
		? targets.find((candidate) => candidate.broker === params.broker)
		: targets.length === 1 ? targets[0] : undefined;
	if (!target) {
		const choices = targets.map((candidate) => `${candidate.broker} (${candidate.accountLabel})`).join(", ");
		throw new Error(`주문 계좌를 확인해 주세요: ${choices || "연결된 계좌 없음"}`);
	}
	return target;
}

function warnings(range: RangeTrade, crypto: boolean, hasLimit: boolean): string[] {
	const expectedReturn = range.sellPrice * (1 - range.sellCostPct / 100) / (range.buyPrice * (1 + range.buyCostPct / 100)) - 1;
	return [
		"켜면 조건 충족 시 추가 확인 없이 실제 주문이 반복됩니다. 기존 보유분이 아닌 이 전략의 매수분만 매도합니다.",
		`로스컷은 봉 마감과 별개로 ${RANGE_RISK_MS / 1000}초 주기로 호가를 조회합니다. 서버 중단·장외·시세 지연 중에는 손절할 수 없으며 체결 가격을 보장하지 않습니다.`,
		"실제 비용 미확인 시 설정한 비용률로 추정합니다. 매도 전 평가손익은 예상 매도 비용을 사용합니다.",
		"일시정지는 신규 주문과 손절 감시도 중단하며 보유분을 매도하지 않습니다. 로스컷 후에는 자동 재시작하지 않습니다.",
		...(!crypto ? ["주식 매매와 손절 주문은 정규장 거래 가능 시간에만 처리합니다."] : []),
		...(!hasLimit ? ["하루 매수 한도를 먼저 설정해야 켤 수 있습니다."] : []),
		...(expectedReturn <= 0 ? ["설정한 가격 차이보다 왕복 비용이 큽니다. 기준가에 매매해도 순손실이 예상됩니다."] : []),
	];
}

async function prepare(params: Params, conversationId: string | null, deps: WatchToolDeps) {
	const range = readRange(params);
	const condition = readCondition(params, range, deps);
	const { venue, symbol, feed } = condition.market;
	const crypto = venue === "binance";
	const off = deps.autoTradeOff?.();
	if (off) throw new Error(off);
	const grid = crypto ? await requireCryptoGrid(symbol, deps) : null;
	const order = readOrder(params, venue, grid);
	const target = await requireTarget(params, venue, deps);
	const name = params.name?.trim() || `${symbol} 박스권 반복매매`;
	if ([...name].length > 60) throw new Error("이름은 60자까지입니다");

	const budgetSize = "amount" in order.size ? { amount: order.size.amount / (1 + range.buyCostPct / 100) } : order.size;
	const estimate = planOrder({ ...order, size: budgetSize }, {
		...(grid ? { grid } : { market: venue === "krx" ? "KR" as const : "US" as const }),
		ref: range.buyPrice,
	});
	if ("error" in estimate) throw new Error(estimate.error);

	const now = deps.now?.() ?? Date.now();
	const fetchBars = deps.fetchBars ?? ((c, count, at) => fetchWatchBars(c, count, { now: at }));
	const bars = await fetchBars(condition, 3, now);
	const last = bars.at(-1);
	const currency = currencyOf(venue);
	const limit = (await deps.tradeLimits?.())?.[currency];
	const spec: TriggerSpec = {
		name, condition,
		action: { kind: "order", target, order, range },
		limits: { maxFires: null, cooldownSec: 0, expiresAt: RANGE_FOREVER },
		conversationId,
	};
	const card: WatchConfirmCard = {
		kind: "watch-confirm-card",
		...deps.prepareWatch(spec),
		name,
		text: `${conditionText(condition)} · 매수→매도→재매수 반복`,
		venue: VENUE_LABEL[venue],
		preset: null,
		feed: feed && (venue === "krx" || venue === "us") ? FEED_LABEL(venue, feed) : null,
		interval: condition.interval,
		limits: spec.limits,
		lastClose: last?.close ?? null,
		lastBarAt: last?.t ?? null,
		lastCloseAt: last ? barCloseAt(condition, last.t) : null,
		holdsNow: null,
		preview: { days: 0, count: 0, recent: [] },
		channels: deps.channels(),
		range: { buyPrice: range.buyPrice, sellPrice: range.sellPrice, stop: rangeStopText(range), fees: rangeCostText(range) },
		warnings: warnings(range, crypto, !!limit),
		order: {
			side: "BUY",
			account: target.accountLabel,
			size: sizeText(order.size, currency, unitOf(venue, symbol)),
			estimate: "amount" in order.size ? "설정한 매수 비용률을 포함한 예산으로 수량을 계산합니다" : null,
			worst: `매수 ≤ ${range.buyPrice} · 정상 매도 ≥ ${range.sellPrice} · 손절은 현재 호가 대비 최악 −2%`,
			how: "봉 마감 조건 → 즉시 체결 시도 (30초 이내, 미체결 잔량 취소)",
			dailyLimit: limit ? moneyText(limit, currency) : "미설정 — 켜기 전 필요",
			protect: rangeStopText(range),
		},
	};
	const text = `${name}을 준비했습니다. ${rangeStopText(range)}. ${rangeCostText(range)}. 아직 켜지지 않았습니다. 사용자가 카드의 [켜기]를 눌러야 정지할 때까지 반복합니다.`;
	return { content: [{ type: "text" as const, text }], details: card };
}

export function createRangeTools(deps: WatchToolDeps) {
	return [defineTool({
		name: "range_trade",
		label: "박스권 반복매매",
		description: DESCRIPTION,
		parameters: RangeParamsSchema,
		execute: async (_id, params, _signal, _update, ctx) => {
			if (params.action === "prepare") return prepare(params, ctx?.sessionManager?.getSessionId?.() ?? null, deps);
			const list = (await deps.listWatches()).filter((watch) => watch.repeat);
			if (params.action === "list") {
				const text = list.length ? list.map(summaryLine).join("\n") : "반복매매 전략이 없습니다.";
				return { content: [{ type: "text" as const, text }], details: { kind: "watch-list", count: list.length } };
			}
			if (!params.id) throw new Error("정지할 전략 id가 필요합니다");
			if (!list.some((watch) => watch.id === params.id)) throw new Error("없는 반복매매 전략입니다");
			const watch = await deps.pauseWatch(params.id);
			const text = `전략을 일시정지했습니다. 보유분은 자동 매도하지 않습니다.\n${summaryLine(watch)}`;
			return { content: [{ type: "text" as const, text }], details: { kind: "watch-paused", id: watch.id } };
		},
	})];
}
