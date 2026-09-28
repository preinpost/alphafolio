/**
 * watch_alert — 자체 감시 트리거를 **준비**하고, 목록을 보고, 일시정지한다 (PLAN §40).
 *
 * 켜기는 사람만 한다: 준비하면 확인 카드(서명 토큰)를 띄우고, 사용자가 [켜기] 를 눌러야 서버가 감시를 시작한다.
 * 에이전트가 할 수 있는 건 위험을 줄이는 쪽(목록·일시정지)뿐이다. 다시 켜기·삭제는 앱·텔레그램에서.
 *
 * 시장: Binance 코인 · 국장 · 미장 — 모두 1분봉~주봉 (주식 분·시간봉은 장 기준). 봉 마감 판정.
 * 동작: 알림, 또는 자동 매매(order — 주식만, 자체 체결기. PLAN §40 2단계).
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fetchWatchBars } from "./bars.ts";
import { barsPerDay, fireIndices, holdsNow, maxBarsFor, validateCondition, warmupFor } from "./condition.ts";
import { presetCatalog, resolvePreset } from "./presets.ts";
import { conditionText, kstShort, num, VENUE_LABEL } from "./describe.ts";
import { barCloseAt, CRYPTO_STEP, DAY, FEED_LABEL, isIntraday, isStock } from "./market-time.ts";
import {
	currencyOf,
	ORDER_DEFAULTS,
	planOrder,
	PROTECT_SELL,
	PROTECT_STOP_PCT,
	PROTECT_TAKE_PCT,
	protectCondition,
	protectPrices,
	protectRuleText,
	protectText,
	sizeText,
	validateOrderRule,
	validateProtect,
	WORST_PCT_RANGE,
} from "./rule.ts";
import { INDICATORS, INTERVALS, OPS, SERIES, VENUES, type CondNode, type Condition, type Interval, type OrderRule, type OrderSize, type OrderTarget, type ProtectRule, type TriggerSpec, type TriggerState, type StockFeed, type Venue, type WatchBar } from "./types.ts";

export const DEFAULT_EXPIRES_DAYS = 30;
export const MAX_EXPIRES_DAYS = 90;
/** 미리보기 기간 — 코인 분·시간봉은 30일, 주식 분·시간봉은 5거래일, 일봉은 약 6개월, 주봉은 약 1년 (봉이 모자라면 받은 만큼) */
export const PREVIEW_DAYS = 30;
export const PREVIEW_STOCK_INTRADAY_DAYS = 5;
export function previewBars(c: Pick<Condition, "market" | "interval" | "session">): number {
	if (c.interval === "1w") return 52;
	if (c.interval === "1d") return isStock(c.market.venue) ? 120 : 180;
	if (isStock(c.market.venue)) return barsPerDay(c) * PREVIEW_STOCK_INTRADAY_DAYS;
	return Math.ceil((PREVIEW_DAYS * DAY) / CRYPTO_STEP[c.interval]);
}

/** 시장을 말하지 않았을 때 — 6자리(숫자 위주)는 국장, 코인 호가 자산으로 끝나면 Binance, 그 외 미장 */
/**
 * 주식 출처 고르기 — 켤 때 고정한다 (감시기는 이 출처로만 조회).
 * 국장: basis 를 말하지 않으면 KIS 가 있을 때 KRX 정규장, 없으면 토스 통합. 통합이면 KIS(UN) 우선. 미장: KIS 우선.
 */
export function chooseFeed(venue: "krx" | "us", has: { kis: boolean; toss: boolean }, basis?: "krx" | "integrated"): StockFeed {
	if (!has.kis && !has.toss) throw new Error("주식 감시에는 증권 키가 필요합니다 — 설정 → 연결 → 증권 (한국투자 또는 토스)");
	if (venue === "us") return { provider: has.kis ? "kis" : "toss" };
	const b = basis ?? (has.kis ? "krx" : "integrated");
	if (b === "krx") {
		if (!has.kis) throw new Error("KRX 정규장 기준 시세는 한국투자 키가 필요합니다 — 토스는 KRX+NXT 통합 시세뿐입니다 (basis: 'integrated' 로 준비할 수 있다)");
		return { provider: "kis", basis: "krx" };
	}
	return { provider: has.kis ? "kis" : "toss", basis: "integrated" };
}

export function guessVenue(symbol: string): Venue {
	if (/^\d{6}$|^\d{4}[A-Z0-9]\d$/.test(symbol)) return "krx";
	if (/^[A-Z0-9]{2,}(USDT|USDC|FDUSD|BTC|ETH|BNB|KRW)$/.test(symbol) && symbol.length >= 6) return "binance";
	return "us";
}

/** 목록 한 줄 — 서버 저장소가 채운다 */
export interface WatchSummary {
	id: string;
	name: string;
	text: string;
	/** 주문 트리거면 동작 한 줄 ("매수 500만원어치 · …"), 알림만이면 null */
	order: string | null;
	state: TriggerState;
	fires: number;
	maxFires: number | null;
	expiresAt: string;
	lastFiredAt: number | null;
	lastEvalAt: number | null;
	nextEvalAt: number | null;
}

/** protocol 의 WatchConfirmCard 와 같은 모양 */
export interface WatchConfirmCard {
	kind: "watch-confirm-card";
	token: string;
	expiresAt: number;
	name: string;
	text: string;
	/** 카드 배지 (Binance · 국장 · 미장) */
	venue: string;
	/** 프리셋으로 만들었으면 이름 */
	preset: string | null;
	/** 주식 시세 출처 (\"KRX 정규장 · 한국투자 (15:30 마감)\") — 켤 때 고정된다 */
	feed: string | null;
	interval: Interval;
	limits: { maxFires: number | null; cooldownSec: number; expiresAt: string };
	lastClose: number | null;
	lastBarAt: number | null;
	/** 지금 이미 참이면 켜도 바로 울리지 않는다 (on_enter) */
	holdsNow: boolean | null;
	preview: { days: number; count: number; recent: Array<{ at: number; close: number }> };
	channels: string[];
	warnings: string[];
	/** 자동 매매 — protocol WatchOrderView 와 같은 모양. 알림만이면 null */
	order: {
		side: "BUY" | "SELL";
		account: string;
		size: string;
		estimate: string | null;
		worst: string;
		how: string;
		dailyLimit: string | null;
		protect: string | null;
	} | null;
}

export interface WatchToolDeps {
	/** 확인 토큰 발급 — 스펙 전체가 서명된다 */
	prepareWatch: (spec: TriggerSpec) => { token: string; expiresAt: number };
	listWatches: () => Promise<WatchSummary[]>;
	/** 이 사용자의 트리거가 아니면 throw */
	pauseWatch: (id: string) => Promise<WatchSummary>;
	/** 켜진 알림 채널 (텔레그램 등) — 없으면 카드에 \"화면에서만\" 안내 */
	channels: () => string[];
	/** 봉 조회 — 서버가 이 사용자의 증권 키를 묶어 준다 (주식). 없으면 코인만 */
	fetchBars?: (c: Condition, limit: number, now: number) => Promise<WatchBar[]>;
	/** 이 사용자에게 있는 증권 키 — 주식 출처 기본값 */
	feeds?: () => { kis: boolean; toss: boolean };
	/** 자동 매매 주문 계좌 (키·계좌가 있는 곳). 없으면 주문 동작을 준비하지 않는다 */
	orderTargets?: () => Promise<OrderTarget[]>;
	/** 하루 매수 한도 (통화별) */
	tradeLimits?: () => Promise<Record<"KRW" | "USD", number | null>>;
	/** 서버에서 자동 매매를 껐으면 이유 */
	autoTradeOff?: () => string | null;
	/** 보유 종목 보호 — 그 계좌의 매도 가능 수량과 평단 (평단을 모르면 null) */
	position?: (symbol: string, target: OrderTarget) => Promise<{ sellable: number; avgPrice: number | null }>;
	now?: () => number;
}

const STATE_LABEL: Readonly<Record<TriggerState, string>> = { armed: "켜짐", paused: "일시정지", done: "소진", expired: "만료", off: "꺼짐" };

export function summaryLine(w: WatchSummary): string {
	const bits = [STATE_LABEL[w.state], `발동 ${w.fires}${w.maxFires ? `/${w.maxFires}` : ""}회`, `만료 ${w.expiresAt.slice(0, 10)}`];
	if (w.lastFiredAt) bits.push(`마지막 발동 ${kstShort(w.lastFiredAt)}`);
	if (w.state === "armed" && w.nextEvalAt) bits.push(`다음 평가 ${kstShort(w.nextEvalAt)}`);
	return `- ${w.id} · ${w.name} — ${w.text}${w.order ? `\n  → 자동 ${w.order}` : ""}\n  ${bits.join(" · ")}`;
}

/** 조건 트리는 재귀라 스키마로는 모양만 알리고 검증은 validateCondition 이 한다 (사람이 읽을 오류로) */
const NodeT = Type.Unknown({
	description:
		"절 { left, op, right } 또는 { any: [...] }(OR) · { all: [...] }(AND) · { within: N, cond: 절 }(최근 N봉 안에 한 번이라도). " +
		`값: 이름(${SERIES.join("·")}) 또는 { ind: ${INDICATORS.join("|")}, period, of, offset, mul, length, mode }. 비교: ${OPS.join(" ")}`,
});

/** 손절·익절 — 매수 order.protect 와 보유 종목 보호(action=protect) 공용 */
const ProtectT = Type.Object(
	{
		stopPct: Type.Optional(Type.Number({ description: `손절 — 평단 대비 −% (${PROTECT_STOP_PCT[0]}~${PROTECT_STOP_PCT[1]})` })),
		stopPrice: Type.Optional(Type.Number({ description: "손절 — 고정가 (종가가 이 아래로 마감하면)" })),
		takePct: Type.Optional(Type.Number({ description: `익절 — 평단 대비 +% (${PROTECT_TAKE_PCT[0]}~${PROTECT_TAKE_PCT[1]})` })),
		takePrice: Type.Optional(Type.Number({ description: "익절 — 고정가 (종가가 이 위로 마감하면)" })),
		interval: Type.Optional(Type.Union(INTERVALS.map((i) => Type.Literal(i)), { description: "판정 봉 (기본 1m — 가장 짧은 봉 마감)" })),
	},
	{ description: "연계주문 손절·익절 — 하나는 있어야 한다. 한 트리거라 하나가 팔면 다른 쪽도 끝난다 (OCO). 판정은 봉 종가, 매도는 즉시(최악 −2%)" },
);

interface ProtectParams {
	symbol?: string;
	market?: Venue;
	protect?: Parameters<typeof toProtect>[0];
	broker?: "kis" | "toss";
	shares?: number;
	basis?: "krx" | "integrated";
	expiresDays?: number;
	name?: string;
}
type ToolCtx = { sessionManager?: { getSessionId?: () => string } } | undefined;

function toProtect(p: { stopPct?: number; stopPrice?: number; takePct?: number; takePrice?: number; interval?: string }): ProtectRule {
	if (p.stopPct !== undefined && p.stopPrice !== undefined) throw new Error("손절은 stopPct·stopPrice 중 하나만");
	if (p.takePct !== undefined && p.takePrice !== undefined) throw new Error("익절은 takePct·takePrice 중 하나만");
	const r: ProtectRule = {
		...(p.stopPct !== undefined ? { stop: { pct: p.stopPct } } : p.stopPrice !== undefined ? { stop: { price: p.stopPrice } } : {}),
		...(p.takePct !== undefined ? { take: { pct: p.takePct } } : p.takePrice !== undefined ? { take: { price: p.takePrice } } : {}),
		interval: (p.interval as Interval | undefined) ?? "1m",
	};
	const bad = validateProtect(r);
	if (bad.length) throw new Error(`준비하지 못했습니다:\n- ${bad.join("\n- ")}`);
	return r;
}

export function createWatchTools(deps: WatchToolDeps) {
	const now = () => deps.now?.() ?? Date.now();
	const fetchBars = deps.fetchBars ?? ((c: Condition, limit: number, at: number) => fetchWatchBars(c, limit, { now: at }));

	/**
	 * 보유 종목 보호 (연계주문의 뒷부분만) — 증권사 평단·매도 가능 수량으로 손절·익절을 한 트리거로.
	 * 켜는 건 역시 사람이 카드에서. 켜면 조건이 맞을 때 확인 없이 판다.
	 */
	const prepareProtect = async (params: ProtectParams, ctx: ToolCtx) => {
		const raw = (params.symbol ?? "").trim().toUpperCase();
		const venue = params.market ?? guessVenue(raw.replace(/[^A-Z0-9]/g, ""));
		const symbol = venue === "us" ? raw.replace(/[^A-Z0-9.-]/g, "") : raw.replace(/[^A-Z0-9]/g, "");
		if (!symbol) throw new Error("symbol 이 필요합니다");
		if (!isStock(venue)) throw new Error("코인 자동 매매는 아직 없습니다 — 국장·미장만");
		const off = deps.autoTradeOff?.();
		if (off) throw new Error(off);
		if (!params.protect) throw new Error("protect(손절·익절)가 필요합니다 — stopPct·stopPrice·takePct·takePrice 중 하나 이상");
		const rule = toProtect(params.protect);
		const targets = (await deps.orderTargets?.()) ?? [];
		if (targets.length === 0) throw new Error("주문할 증권 계좌가 없습니다 — 설정 → 연결 → 증권 (한국투자는 계좌번호까지)");
		const target = params.broker ? targets.find((t) => t.broker === params.broker) : targets.length === 1 ? targets[0] : undefined;
		if (!target) throw new Error(params.broker ? `${params.broker} 주문 계좌가 없습니다` : `어느 증권사에 가진 종목인지 사용자에게 물어보세요: ${targets.map((t) => `${t.broker} = ${t.accountLabel}`).join(" · ")}`);
		if (!deps.position) throw new Error("보유 수량을 확인할 수 없습니다 (서버 미지원)");
		const pos = await deps.position(symbol, target);
		if (pos.sellable <= 0) throw new Error(`${target.accountLabel} 에 ${symbol} 매도 가능 수량이 없습니다`);
		const shares = params.shares ?? pos.sellable;
		if (!Number.isInteger(shares) || shares < 1) throw new Error("shares 는 1 이상의 정수입니다");
		if (shares > pos.sellable) throw new Error(`매도 가능 수량(${pos.sellable}주)보다 많습니다`);
		const usesPct = (rule.stop && "pct" in rule.stop) || (rule.take && "pct" in rule.take);
		if (usesPct && !pos.avgPrice) throw new Error("평단을 몰라 % 로 정할 수 없습니다 — stopPrice·takePrice(가격)로 정해 주세요");
		const cur = currencyOf(venue);
		const market = cur === "KRW" ? ("KR" as const) : ("US" as const);
		const prices = protectPrices(rule, pos.avgPrice ?? 0, market);
		if (prices.problems.length) throw new Error(`준비하지 못했습니다:\n- ${prices.problems.join("\n- ")}`);
		const feed = chooseFeed(venue, deps.feeds?.() ?? { kis: true, toss: true }, params.basis);
		const position = { shares, avgPrice: pos.avgPrice ?? 0, stopPrice: prices.stopPrice, takePrice: prices.takePrice, parentId: null };
		const condition = protectCondition({ market: { venue, symbol, feed } }, rule.interval, position);
		const errors = validateCondition(condition);
		const days = params.expiresDays ?? MAX_EXPIRES_DAYS;
		if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRES_DAYS) errors.push(`만료는 1~${MAX_EXPIRES_DAYS}일입니다`);
		if (errors.length) throw new Error(`준비하지 못했습니다:\n- ${errors.join("\n- ")}`);
		const name = (params.name ?? "").trim() || `${symbol} 보호`;

		// 미리보기는 "처음 닿은 봉" 기준 (while_true 는 참인 봉마다라 횟수가 부풀려진다)
		const once: Condition = { ...condition, fire: "on_enter" };
		const warm = warmupFor(once);
		const span = previewBars(once);
		const bars = await fetchBars(once, Math.min(maxBarsFor(once), span + warm), now());
		const from = Math.max(warm, bars.length - span);
		const fires = fireIndices(once, bars).filter((i) => i >= from);
		const closeAt = (i: number) => barCloseAt(once, (bars[i] as WatchBar).t);
		const covered = bars.length > from ? (closeAt(bars.length - 1) - (bars[from] as WatchBar).t) / DAY : 0;
		const last = bars.at(-1);

		const spec: TriggerSpec = {
			name,
			condition,
			action: { kind: "order", target, order: { ...PROTECT_SELL, size: { shares } }, position },
			limits: { maxFires: null, cooldownSec: 0, expiresAt: new Date(now() + days * 86_400_000).toISOString() },
			conversationId: ctx?.sessionManager?.getSessionId?.() ?? null,
		};
		const { token, expiresAt } = deps.prepareWatch(spec);
		const channels = deps.channels();
		const warnings = [
			...(last && position.stopPrice !== null && last.close < position.stopPrice ? ["지금 종가가 이미 손절가 아래입니다 — 켜면 다음 봉 마감에 바로 팝니다."] : []),
			...(last && position.takePrice !== null && last.close > position.takePrice ? ["지금 종가가 이미 익절가 위입니다 — 켜면 다음 봉 마감에 바로 팝니다."] : []),
			...(channels.length ? [] : ["알림 채널이 없어 앱 화면에서만 알립니다 — 설정 → 연결 → 알림 (텔레그램)"]),
			"주문은 정규장에만 냅니다 (국장 종가 단일가 15:20 뒤 신호는 다음 날 첫 봉에서 다시).",
		];
		const pText = protectText({ ...position, avgPrice: pos.avgPrice ?? undefined }, rule.interval);
		const card: WatchConfirmCard = {
			kind: "watch-confirm-card",
			token,
			expiresAt,
			name,
			text: conditionText(condition),
			preset: null,
			feed: FEED_LABEL(venue, feed),
			venue: VENUE_LABEL[venue],
			interval: condition.interval,
			limits: spec.limits,
			lastClose: last?.close ?? null,
			lastBarAt: last?.t ?? null,
			holdsNow: holdsNow(once, bars),
			preview: { days: Math.round(covered * 10) / 10, count: fires.length, recent: fires.slice(-5).map((i) => ({ at: closeAt(i), close: (bars[i] as WatchBar).close })) },
			channels,
			warnings,
			order: {
				side: "SELL",
				account: target.accountLabel,
				size: `${shares}주 (매도 가능 ${pos.sellable}주)`,
				estimate: pos.avgPrice ? `평단 ${pos.avgPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : null,
				worst: `신호 때 중간가 −${PROTECT_SELL.worstPct}% 까지`,
				how: `반대편 호가에 바로 (최대 ${PROTECT_SELL.deadlineSec}초) — 못 판 잔량은 다음 봉에도 조건이 맞으면 다시`,
				dailyLimit: null,
				protect: pText,
			},
		};
		const text =
			`[보호 준비] ${name} — ${shares}주 · ${target.accountLabel}\n${pText}\n` +
			`마지막 마감 ${last ? `${num(last.close)} (${kstShort(barCloseAt(condition, last.t))})` : "없음"} · 지난 ${card.preview.days}일이었다면 ${fires.length}번 닿았다.\n` +
			"**아직 켜지지 않았다.** 사용자가 화면의 카드에서 [켜기] 를 눌러야 시작된다 (10분 안에). 켜면 조건이 맞을 때 **확인 없이 판다** — 그 점을 분명히 말한다.";
		return { content: [{ type: "text" as const, text }], details: card };
	};

	const tool = defineTool({
		name: "watch_alert",
		label: "감시 알림",
		description:
			"프리셋(preset + presetParams, 숫자는 바꿀 수 있는 기본값): " + presetCatalog() + ". 프리셋이 맞으면 프리셋을 쓴다 (조건이 매번 달라지지 않게). " +
			"AlphaFolio 자체 감시 — **봉 마감가**로 조건을 판정해 알린다 (순간 꼬리에 울리지 않는다). TradingView 와 무관. " +
			"order 를 넣으면 **자동 매매**: 조건이 맞을 때 자체 체결기가 최악 허용가 안의 지정가로 주문한다 (국장·미장 정규장만, 증권사 조건주문은 쓰지 않는다). " +
			"자동 매매·손절·익절·OCO·OTO·\"조건주문\" 요청은 모두 이 툴로 준비한다. 주문 계좌가 둘이면 사용자에게 묻는다. 매수는 사용자가 하루 매수 한도를 정해 둬야 켜진다. " +
			"연계주문: 매수 order 에 protect({ stopPct·stopPrice, takePct·takePrice, interval })를 넣으면 체결 뒤 체결 수량·평단으로 손절·익절을 자동으로 건다 (한 트리거 — 하나가 팔면 끝, OCO). " +
			"action=protect: 이미 가진 종목에 손절·익절 (symbol · protect · broker · shares — 비우면 매도 가능 수량 전부, 평단은 증권사 값). " +
			"시장: binance(코인) · krx(국장) · us(미장) — 모두 1분봉~주봉. 주식은 사용자의 증권 키로 조회한다. " +
			"주식 분·시간봉은 장 기준으로 자른다 (국장 09:00, 미장 09:30 시작 — 1시간봉 마지막 봉은 마감에서 잘린다). session: 'extended' = 미장 프리·애프터 · 국장 NXT(통합 기준). " +
			"action=prepare: 조건을 준비하고 확인 카드를 띄운다 — **켜는 건 사용자가 카드에서** [켜기] 를 눌러야 한다. 지난 기간(코인 분봉 30일 · 주식 분봉 5거래일 · 일봉 약 6개월)에 몇 번 울렸을지 미리보기가 함께 나온다. " +
			"action=list: 내 감시 목록. action=pause: 일시정지 (다시 켜기·삭제는 사용자가 앱·텔레그램에서). " +
			"직접 조건(all): 이름 값 close·open·high·low·volume·vol_chg_pct(직전 봉 대비 거래량 %)·ma5·ma20·ma60·rsi14·bb_upper·bb_lower·atr14·vol_ratio20, " +
			"또는 매개변수 값 { ind: 'sma'|'ema', period, of?, mul? } · { ind: 'rsi', period } · { ind: 'highest'|'lowest', period, of?, offset?(기본 1 = 지금 봉 제외) } · " +
			"{ ind: 'change_pct', period }(N봉 전 대비 %) · { ind: 'vol_ratio', period } · { ind: 'rvol', length?(기본 10일), mode?: 'cumulative'|'regular' }(같은 시각 대비 거래량 배수) · " +
			"{ ind: 'value', of: 이름, offset }(N봉 전 값). mul 은 배수 (\"20봉 이평보다 2% 위\" = right: { ind: 'sma', period: 20, mul: 1.02 }). " +
			"묶음: { any: [...] } = 또는, { within: N, cond: 절 } = 최근 N봉 안에 한 번이라도. 최상위 목록은 모두 충족(AND). " +
			"비교: < > <= >= crosses_above crosses_below. 조건이 유지되는 동안은 다시 울리지 않고, 거짓이 됐다가 참이 되면 또 울린다.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("prepare"), Type.Literal("protect"), Type.Literal("list"), Type.Literal("pause")]),
			name: Type.Optional(Type.String({ description: "짧은 한글 이름 (예: 'ETH 1시간봉 2,600 이탈')" })),
			market: Type.Optional(Type.Union(VENUES.map((v) => Type.Literal(v)), { description: "binance=코인 · krx=국장 · us=미장. 비우면 심볼로 추정 (6자리=국장)" })),
			symbol: Type.Optional(Type.String({ description: "코인 ETHUSDT · 국장 005930 · 미장 AAPL" })),
			interval: Type.Optional(Type.Union(INTERVALS.map((i) => Type.Literal(i)), { description: "봉 간격 — 사용자가 말하지 않으면 되묻는다" })),
			session: Type.Optional(
				Type.Union([Type.Literal("regular"), Type.Literal("extended")], {
					description: "주식 분·시간봉만: extended = 미장 프리·애프터(뉴욕 04:00–20:00) · 국장 NXT 포함(08:00–20:00, 통합 기준으로 준비된다). 기본 정규장. 일봉·주봉은 정규장",
				}),
			),
			basis: Type.Optional(
				Type.Union([Type.Literal("krx"), Type.Literal("integrated")], {
					description: "국장만: krx = KRX 정규장 시세(기본, 한국투자 키 필요, 15:30 마감) · integrated = KRX+NXT 통합 시세(거래량·종가에 NXT 포함, 20:00 마감)",
				}),
			),
			preset: Type.Optional(Type.String({ description: "프리셋 id (목록은 툴 설명). all 을 함께 주면 추가 조건으로 AND" })),
			presetParams: Type.Optional(Type.Record(Type.String(), Type.Number(), { description: "프리셋 매개변수 — 빠진 값은 기본값" })),
			all: Type.Optional(Type.Array(NodeT, { description: "모두 충족해야 하는 조건들 (예: [{left:'close',op:'<',right:2600}])" })),
			confirmBars: Type.Optional(Type.Integer({ description: "N봉 연속 충족해야 울림 (기본 1)" })),
			maxFires: Type.Optional(Type.Integer({ description: "최대 발동 횟수 — 비우면 만료까지 계속 (한 번만이면 1)" })),
			cooldownMinutes: Type.Optional(Type.Integer({ description: "발동 후 다시 울리기까지 최소 간격(분), 기본 0" })),
			expiresDays: Type.Optional(Type.Integer({ description: `만료까지 일수 (기본 ${DEFAULT_EXPIRES_DAYS}, 최대 ${MAX_EXPIRES_DAYS})` })),
			id: Type.Optional(Type.String({ description: "pause 대상 id (list 결과)" })),
			protect: Type.Optional(ProtectT),
			broker: Type.Optional(Type.Union([Type.Literal("kis"), Type.Literal("toss")], { description: "action=protect — 보유한 증권사 (두 곳 다 있으면 묻는다)" })),
			shares: Type.Optional(Type.Integer({ description: "action=protect — 보호할 수량 (비우면 매도 가능 수량 전부)" })),
			order: Type.Optional(
				Type.Object(
					{
						side: Type.Union([Type.Literal("BUY"), Type.Literal("SELL")]),
						broker: Type.Optional(Type.Union([Type.Literal("kis"), Type.Literal("toss")], { description: "주문 계좌 — 두 곳 다 있으면 사용자에게 묻는다" })),
						shares: Type.Optional(Type.Integer({ description: "주 수" })),
						amount: Type.Optional(Type.Number({ description: "금액 (국장 원, 미장 달러) — 최악 허용가로 나눠 내림하므로 이 금액을 넘지 않는다" })),
						holdingPct: Type.Optional(Type.Number({ description: "매도만 — 매도 가능 수량의 % (전량 = 100)" })),
						worstPct: Type.Optional(Type.Number({ description: `신호 때 중간가 대비 최악 허용가 % (기본 매수 ${ORDER_DEFAULTS.BUY.worstPct} · 매도 ${ORDER_DEFAULTS.SELL.worstPct}, ${WORST_PCT_RANGE[0]}~${WORST_PCT_RANGE[1]})` })),
						urgency: Type.Optional(Type.Union([Type.Literal("immediate"), Type.Literal("patient")], { description: "immediate = 반대편 호가를 바로 (매도 기본) · patient = 우리 쪽 호가에 걸고 한 호가씩 (매수 기본)" })),
						deadlineSec: Type.Optional(Type.Integer({ description: `체결 제한 시간 초 (기본 매수 ${ORDER_DEFAULTS.BUY.deadlineSec} · 매도 ${ORDER_DEFAULTS.SELL.deadlineSec})` })),
						protect: Type.Optional(ProtectT),
					},
					{ description: "자동 매매 — 넣으면 조건이 맞을 때 자체 체결기가 주문한다 (국장·미장 정규장만). 수량은 shares·amount·holdingPct 중 하나" },
				),
			),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			if (params.action === "list") {
				const list = await deps.listWatches();
				const text = list.length ? list.map(summaryLine).join("\n") : "감시가 없습니다.";
				return { content: [{ type: "text" as const, text }], details: { kind: "watch-list", count: list.length } };
			}
			if (params.action === "pause") {
				if (!params.id) throw new Error("pause 에는 id 가 필요합니다 — action=list 로 확인하세요.");
				const w = await deps.pauseWatch(params.id.trim());
				return {
					content: [{ type: "text" as const, text: `일시정지했습니다. 다시 켜기는 사용자가 앱(설정 → 감시)에서 합니다.\n${summaryLine(w)}` }],
					details: { kind: "watch-paused", id: w.id },
				};
			}

			if (params.action === "protect") return prepareProtect(params, ctx as ToolCtx);

			// ── prepare ──
			const raw = (params.symbol ?? "").trim().toUpperCase();
			const venue = (params.market as Venue | undefined) ?? guessVenue(raw.replace(/[^A-Z0-9]/g, ""));
			// 미장 티커는 점·하이픈이 있을 수 있다 (BRK.B), 코인·국장은 영숫자만
			const symbol = venue === "us" ? raw.replace(/[^A-Z0-9.-]/g, "") : raw.replace(/[^A-Z0-9]/g, "");
			if (!params.interval) throw new Error("interval(봉 간격)이 필요합니다 — 사용자에게 몇 분봉·시간봉·일봉·주봉 기준인지 물어보세요.");
			// 프리셋이면 펼친다 — 저장되는 건 펼친 조건 (평가기는 프리셋을 모른다)
			let presetName: string | null = null;
			let presetMeta: Condition["preset"];
			let nodes = (params.all ?? []) as CondNode[];
			let confirmBars = params.confirmBars ?? 1;
			if (params.preset) {
				const r = resolvePreset(params.preset, params.presetParams ?? {});
				if (!r.preset) throw new Error(`준비하지 못했습니다:\n- ${r.errors.join("\n- ")}`);
				if (r.errors.length) throw new Error(`준비하지 못했습니다:\n- ${r.errors.join("\n- ")}`);
				const built = r.preset.build(r.params);
				nodes = [...built.all, ...nodes];
				confirmBars = params.confirmBars ?? built.confirmBars;
				presetName = r.preset.name;
				presetMeta = { id: r.preset.id, params: r.params };
			}
			// 국장 확장 세션(NXT)은 통합 시세로만 볼 수 있다 — basis 를 말하지 않았으면 통합으로
			const basis = params.basis ?? (venue === "krx" && params.session === "extended" && isIntraday(params.interval as Interval) ? "integrated" : undefined);
			const feed = isStock(venue) ? chooseFeed(venue, deps.feeds?.() ?? { kis: true, toss: true }, basis) : undefined;
			if (params.basis && venue !== "krx") throw new Error("basis 는 국장만 고릅니다");
			const condition: Condition = {
				market: { venue, symbol, ...(feed ? { feed } : {}) },
				...(params.session ? { session: params.session } : {}),
				interval: params.interval as Interval,
				when: "bar_close",
				all: nodes,
				confirmBars,
				fire: "on_enter",
				...(presetMeta ? { preset: presetMeta } : {}),
			};
			const errors = validateCondition(condition);
			const days = params.expiresDays ?? DEFAULT_EXPIRES_DAYS;
			if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRES_DAYS) errors.push(`만료는 1~${MAX_EXPIRES_DAYS}일입니다`);
			if (params.maxFires != null && (!Number.isInteger(params.maxFires) || params.maxFires < 1)) errors.push("maxFires 는 1 이상입니다");
			if (params.cooldownMinutes != null && (params.cooldownMinutes < 0 || params.cooldownMinutes > 7 * 24 * 60)) errors.push("쿨다운은 0분~7일입니다");
			const name = (params.name ?? "").trim() || (presetName ? `${symbol} ${presetName}` : conditionText(condition).slice(0, 40));
			if ([...name].length > 60) errors.push("이름은 60자까지입니다");
			if (errors.length) throw new Error(`준비하지 못했습니다:\n- ${errors.join("\n- ")}`);

			// 미리보기 — 지난 기간(봉이 모자라면 받은 만큼)에 이 조건이 몇 번 울렸을지. 지표 예열 구간은 세지 않는다
			const warm = warmupFor(condition);
			const span = previewBars(condition);
			const bars = await fetchBars(condition, Math.min(maxBarsFor(condition), span + warm), now());
			const from = Math.max(warm, bars.length - span);
			const fires = fireIndices(condition, bars).filter((i) => i >= from);
			const closeAt = (i: number) => barCloseAt(condition, (bars[i] as WatchBar).t);
			const covered = bars.length > from ? (closeAt(bars.length - 1) - (bars[from] as WatchBar).t) / DAY : 0;
			const last = bars.at(-1);

			// 자동 매매 — 계좌·규칙·한도 (켜기 때 서버가 한 번 더, 신호 때 실행기가 또 본다)
			let action: TriggerSpec["action"] = { kind: "notify" };
			let orderView: WatchConfirmCard["order"] = null;
			const orderWarnings: string[] = [];
			let protectLineText: string | null = null;
			if (params.order) {
				const o = params.order;
				if (!isStock(venue)) throw new Error("코인 자동 매매는 아직 없습니다 — 국장·미장만 (코인은 알림만)");
				const off = deps.autoTradeOff?.();
				if (off) throw new Error(off);
				const targets = (await deps.orderTargets?.()) ?? [];
				if (targets.length === 0) throw new Error("주문할 증권 계좌가 없습니다 — 설정 → 연결 → 증권 (한국투자는 계좌번호까지)");
				const target = o.broker ? targets.find((t) => t.broker === o.broker) : targets.length === 1 ? targets[0] : undefined;
				if (!target) {
					throw new Error(
						o.broker
							? `${o.broker} 주문 계좌가 없습니다 — 있는 곳: ${targets.map((t) => `${t.broker}(${t.accountLabel})`).join(", ")}`
							: `주문 계좌를 사용자에게 물어보세요: ${targets.map((t) => `${t.broker} = ${t.accountLabel}`).join(" · ")}`,
					);
				}
				const d = ORDER_DEFAULTS[o.side];
				const size: OrderSize | null = o.shares !== undefined ? { shares: o.shares } : o.amount !== undefined ? { amount: o.amount } : o.holdingPct !== undefined ? { holdingPct: o.holdingPct } : null;
				if (!size) throw new Error("수량이 필요합니다 — shares(주)·amount(금액)·holdingPct(매도 가능 수량 %) 중 하나");
				if ([o.shares, o.amount, o.holdingPct].filter((x) => x !== undefined).length > 1) throw new Error("수량은 shares·amount·holdingPct 중 하나만");
				const rule: OrderRule = { side: o.side, size, worstPct: o.worstPct ?? d.worstPct, urgency: o.urgency ?? d.urgency, deadlineSec: o.deadlineSec ?? d.deadlineSec };
				const bad = validateOrderRule(rule);
				if (bad.length) throw new Error(`준비하지 못했습니다:\n- ${bad.join("\n- ")}`);
				if (o.protect && o.side !== "BUY") throw new Error("체결 후 보호(protect)는 매수에만 — 가진 종목에 손절·익절을 걸려면 action: 'protect'");
				const protect = o.protect ? toProtect(o.protect) : undefined;
				action = { kind: "order", target, order: rule, ...(protect ? { protect } : {}) };
				protectLineText = protect ? `체결 후 자동: ${protectRuleText(protect)} — 체결 수량·평단으로 손절·익절을 한 트리거로 겁니다` : null;
				const cur = currencyOf(venue);
				const money = (v: number) => (cur === "KRW" ? `${Math.round(v).toLocaleString("en-US")}원` : `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
				let estimate: string | null = null;
				if (last && "amount" in size) {
					const p = planOrder(rule, { market: cur === "KRW" ? "KR" : "US", ref: last.close });
					estimate = "error" in p ? p.error : `마지막 종가 ${money(last.close)} 기준 약 ${p.quantity}주 (최악 허용가 ${money(p.worstPrice)})`;
				} else if (last && "shares" in size) estimate = `마지막 종가 기준 약 ${money(last.close * size.shares)}`;
				let dailyLimit: string | null = null;
				if (o.side === "BUY") {
					const lim = (await deps.tradeLimits?.())?.[cur] ?? null;
					dailyLimit = lim ? money(lim) : null;
					if (!lim) orderWarnings.push(`하루 매수 한도(${cur})가 없어 지금은 켤 수 없습니다 — 설정 → 감시 → 자동 매매 한도를 정한 뒤 이 카드에서 켜 주세요.`);
					else if ("amount" in size && size.amount > lim) orderWarnings.push(`주문 금액 ${money(size.amount)} 이 하루 한도 ${money(lim)} 보다 커서 신호가 와도 주문하지 않습니다.`);
				}
				if (params.session === "extended") orderWarnings.push("확장 세션 봉이라도 주문은 정규장에만 냅니다 — 장 밖 신호는 알림만.");
				orderView = {
					side: o.side,
					account: target.accountLabel,
					size: sizeText(size, cur),
					estimate,
					worst: `신호 때 중간가 ${o.side === "BUY" ? "+" : "−"}${rule.worstPct}% 까지`,
					how: rule.urgency === "patient" ? `${rule.deadlineSec}초 동안 우리 쪽 호가에 걸고 한 호가씩, 남으면 취소` : `반대편 호가에 바로 (최대 ${rule.deadlineSec}초), 남으면 취소`,
					dailyLimit,
					protect: protectLineText,
				};
			}
			if (params.order && params.maxFires == null) params.maxFires = 1; // 자동 매매는 횟수가 필수 — 기본 한 번

			const spec: TriggerSpec = {
				name,
				condition,
				action,
				limits: {
					maxFires: params.maxFires ?? null,
					cooldownSec: (params.cooldownMinutes ?? 0) * 60,
					expiresAt: new Date(now() + days * 86_400_000).toISOString(),
				},
				conversationId: ctx?.sessionManager?.getSessionId?.() ?? null,
			};
			const { token, expiresAt } = deps.prepareWatch(spec);
			const channels = deps.channels();
			const hold = holdsNow(condition, bars);
			const warnings = [
				...(hold ? ["지금 이미 조건이 참입니다 — 켜도 바로 울리지 않고, 거짓이 됐다가 다시 참이 될 때 울립니다."] : []),
				...(channels.length ? [] : ["알림 채널이 없어 앱 화면에서만 알립니다 — 설정 → 연결 → 알림 (텔레그램)"]),
				...(bars.length < warm + 10 ? ["봉이 적어 미리보기를 믿기 어렵습니다 (상장 초기 종목?)"] : []),
				...orderWarnings,
			];
			const card: WatchConfirmCard = {
				kind: "watch-confirm-card",
				token,
				expiresAt,
				name,
				text: conditionText(condition),
				preset: presetName,
				feed: feed && isStock(venue) ? FEED_LABEL(venue, feed) : null,
				venue: VENUE_LABEL[condition.market.venue],
				interval: condition.interval,
				limits: spec.limits,
				lastClose: last?.close ?? null,
				lastBarAt: last?.t ?? null,
				holdsNow: hold,
				preview: { days: Math.round(covered * 10) / 10, count: fires.length, recent: fires.slice(-5).map((i) => ({ at: closeAt(i), close: (bars[i] as WatchBar).close })) },
				channels,
				warnings,
				order: orderView,
			};
			const text =
				`[감시 준비] ${name} — ${card.text}\n` +
				(orderView ? `→ 자동 ${orderView.side === "BUY" ? "매수" : "매도"} ${orderView.size} · ${orderView.account} · ${orderView.worst} · ${orderView.how}\n` : "") +
				(orderWarnings.length ? `⚠ ${orderWarnings.join(" / ")}\n` : "") +
				`마지막 마감 ${last ? `${num(last.close)} (${kstShort(barCloseAt(condition, last.t))})` : "없음"} · 지난 ${card.preview.days}일이었다면 ${fires.length}번 울렸다` +
				`${hold ? " · ⚠ 지금 이미 참 (켜도 바로 울리지 않는다)" : ""}.\n` +
				"**아직 켜지지 않았다.** 사용자가 화면의 카드에서 [켜기] 를 눌러야 감시가 시작된다 (10분 안에). \"화면에서 켜기를 눌러 주세요\" 라고 안내한다." +
				(orderView ? " 켜면 조건이 맞을 때 **확인 없이 주문이 나간다** — 사용자에게 그 점을 분명히 말한다." : "");
			return { content: [{ type: "text" as const, text }], details: card };
		},
	});
	return [tool];
}

export const WATCH_TOOL_NAMES = ["watch_alert"] as const;
