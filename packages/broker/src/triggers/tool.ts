/**
 * watch_alert — 자체 감시 트리거를 **준비**하고, 목록을 보고, 일시정지한다 (PLAN §40).
 *
 * 켜기는 사람만 한다: 준비하면 확인 카드(서명 토큰)를 띄우고, 사용자가 [켜기] 를 눌러야 서버가 감시를 시작한다.
 * 에이전트가 할 수 있는 건 위험을 줄이는 쪽(목록·일시정지)뿐이다. 다시 켜기·삭제는 앱·텔레그램에서.
 *
 * 1단계: Binance 코인 · 봉 마감 판정 · 동작은 알림만.
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fetchBinanceBars, MAX_BARS } from "./bars.ts";
import { fireIndices, holdsNow, validateCondition, WARMUP_BARS } from "./condition.ts";
import { conditionText, kstShort, num } from "./describe.ts";
import { INTERVAL_MS, INTERVALS, OPS, SERIES, type Clause, type Condition, type Interval, type TriggerSpec, type TriggerState } from "./types.ts";

export const DEFAULT_EXPIRES_DAYS = 30;
export const MAX_EXPIRES_DAYS = 90;
/** 미리보기 기간 (봉이 모자라면 받은 만큼) */
export const PREVIEW_DAYS = 30;

/** 목록 한 줄 — 서버 저장소가 채운다 */
export interface WatchSummary {
	id: string;
	name: string;
	text: string;
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
	interval: Interval;
	limits: { maxFires: number | null; cooldownSec: number; expiresAt: string };
	lastClose: number | null;
	lastBarAt: number | null;
	/** 지금 이미 참이면 켜도 바로 울리지 않는다 (on_enter) */
	holdsNow: boolean | null;
	preview: { days: number; count: number; recent: Array<{ at: number; close: number }> };
	channels: string[];
	warnings: string[];
}

export interface WatchToolDeps {
	/** 확인 토큰 발급 — 스펙 전체가 서명된다 */
	prepareWatch: (spec: TriggerSpec) => { token: string; expiresAt: number };
	listWatches: () => Promise<WatchSummary[]>;
	/** 이 사용자의 트리거가 아니면 throw */
	pauseWatch: (id: string) => Promise<WatchSummary>;
	/** 켜진 알림 채널 (텔레그램 등) — 없으면 카드에 \"화면에서만\" 안내 */
	channels: () => string[];
	fetchBars?: typeof fetchBinanceBars;
	now?: () => number;
}

const STATE_LABEL: Readonly<Record<TriggerState, string>> = { armed: "켜짐", paused: "일시정지", done: "소진", expired: "만료", off: "꺼짐" };

export function summaryLine(w: WatchSummary): string {
	const bits = [STATE_LABEL[w.state], `발동 ${w.fires}${w.maxFires ? `/${w.maxFires}` : ""}회`, `만료 ${w.expiresAt.slice(0, 10)}`];
	if (w.lastFiredAt) bits.push(`마지막 발동 ${kstShort(w.lastFiredAt)}`);
	if (w.state === "armed" && w.nextEvalAt) bits.push(`다음 평가 ${kstShort(w.nextEvalAt)}`);
	return `- ${w.id} · ${w.name} — ${w.text}\n  ${bits.join(" · ")}`;
}

const ClauseT = Type.Object({
	left: Type.Union(SERIES.map((s) => Type.Literal(s))),
	op: Type.Union(OPS.map((o) => Type.Literal(o))),
	right: Type.Union([Type.Number(), ...SERIES.map((s) => Type.Literal(s))]),
});

export function createWatchTools(deps: WatchToolDeps) {
	const now = () => deps.now?.() ?? Date.now();
	const fetchBars = deps.fetchBars ?? fetchBinanceBars;

	const tool = defineTool({
		name: "watch_alert",
		label: "감시 알림",
		description:
			"AlphaFolio 자체 감시 — **봉 마감가**로 조건을 판정해 알린다 (순간 꼬리에 울리지 않는다). TradingView 와 무관. 1단계: Binance 코인, 알림만 (자동 주문은 아직 없다). " +
			"action=prepare: 조건을 준비하고 확인 카드를 띄운다 — **켜는 건 사용자가 카드에서** [켜기] 를 눌러야 한다. 지난 30일에 몇 번 울렸을지 미리보기가 함께 나온다. " +
			"action=list: 내 감시 목록. action=pause: 일시정지 (다시 켜기·삭제는 사용자가 앱·텔레그램에서). " +
			"조건 값: close·open·high·low·volume·ma5·ma20·ma60·rsi14·bb_upper·bb_lower·atr14·vol_ratio20(직전 20봉 평균 대비 거래량 배수). " +
			"비교: < > <= >= crosses_above crosses_below. 여러 조건은 모두 충족(AND). 조건이 유지되는 동안은 다시 울리지 않고, 거짓이 됐다가 참이 되면 또 울린다.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("prepare"), Type.Literal("list"), Type.Literal("pause")]),
			name: Type.Optional(Type.String({ description: "짧은 한글 이름 (예: 'ETH 1시간봉 2,600 이탈')" })),
			symbol: Type.Optional(Type.String({ description: "Binance 현물 심볼 (예: ETHUSDT, BTCUSDT)" })),
			interval: Type.Optional(Type.Union(INTERVALS.map((i) => Type.Literal(i)), { description: "봉 간격 — 사용자가 말하지 않으면 되묻는다 (1시간봉이 흔하다)" })),
			all: Type.Optional(Type.Array(ClauseT, { description: "모두 충족해야 하는 조건들 (예: [{left:'close',op:'<',right:2600}])" })),
			confirmBars: Type.Optional(Type.Integer({ description: "N봉 연속 충족해야 울림 (기본 1)" })),
			maxFires: Type.Optional(Type.Integer({ description: "최대 발동 횟수 — 비우면 만료까지 계속 (한 번만이면 1)" })),
			cooldownMinutes: Type.Optional(Type.Integer({ description: "발동 후 다시 울리기까지 최소 간격(분), 기본 0" })),
			expiresDays: Type.Optional(Type.Integer({ description: `만료까지 일수 (기본 ${DEFAULT_EXPIRES_DAYS}, 최대 ${MAX_EXPIRES_DAYS})` })),
			id: Type.Optional(Type.String({ description: "pause 대상 id (list 결과)" })),
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

			// ── prepare ──
			const symbol = (params.symbol ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
			if (!params.interval) throw new Error("interval(봉 간격)이 필요합니다 — 사용자에게 몇 분봉·시간봉·일봉 기준인지 물어보세요.");
			const condition: Condition = {
				market: { venue: "binance", symbol },
				interval: params.interval as Interval,
				when: "bar_close",
				all: (params.all ?? []) as Clause[],
				confirmBars: params.confirmBars ?? 1,
				fire: "on_enter",
			};
			const errors = validateCondition(condition);
			const days = params.expiresDays ?? DEFAULT_EXPIRES_DAYS;
			if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRES_DAYS) errors.push(`만료는 1~${MAX_EXPIRES_DAYS}일입니다`);
			if (params.maxFires != null && (!Number.isInteger(params.maxFires) || params.maxFires < 1)) errors.push("maxFires 는 1 이상입니다");
			if (params.cooldownMinutes != null && (params.cooldownMinutes < 0 || params.cooldownMinutes > 7 * 24 * 60)) errors.push("쿨다운은 0분~7일입니다");
			const name = (params.name ?? "").trim() || conditionText(condition).slice(0, 40);
			if ([...name].length > 60) errors.push("이름은 60자까지입니다");
			if (errors.length) throw new Error(`준비하지 못했습니다:\n- ${errors.join("\n- ")}`);

			// 미리보기 — 지난 30일(봉이 모자라면 받은 만큼)에 이 조건이 몇 번 울렸을지. 지표 예열 구간은 세지 않는다
			const step = INTERVAL_MS[condition.interval];
			const want = Math.min(MAX_BARS, Math.ceil((PREVIEW_DAYS * 86_400_000) / step) + WARMUP_BARS);
			const bars = await fetchBars(symbol, condition.interval, want, { now: now() });
			const from = Math.max(WARMUP_BARS, bars.length - Math.ceil((PREVIEW_DAYS * 86_400_000) / step));
			const fires = fireIndices(condition, bars).filter((i) => i >= from);
			const covered = bars.length > from ? ((bars.at(-1) as { t: number }).t - (bars[from] as { t: number }).t + step) / 86_400_000 : 0;
			const last = bars.at(-1);

			const spec: TriggerSpec = {
				name,
				condition,
				action: { kind: "notify" },
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
				...(bars.length < WARMUP_BARS + 1 ? ["봉이 적어 미리보기를 믿기 어렵습니다 (상장 초기 종목?)"] : []),
			];
			const card: WatchConfirmCard = {
				kind: "watch-confirm-card",
				token,
				expiresAt,
				name,
				text: conditionText(condition),
				interval: condition.interval,
				limits: spec.limits,
				lastClose: last?.close ?? null,
				lastBarAt: last?.t ?? null,
				holdsNow: hold,
				preview: { days: Math.round(covered * 10) / 10, count: fires.length, recent: fires.slice(-5).map((i) => ({ at: (bars[i] as { t: number }).t + step, close: (bars[i] as { close: number }).close })) },
				channels,
				warnings,
			};
			const text =
				`[감시 준비] ${name} — ${card.text}\n` +
				`마지막 마감 ${last ? `${num(last.close)} (${kstShort(last.t + step)})` : "없음"} · 지난 ${card.preview.days}일이었다면 ${fires.length}번 울렸다` +
				`${hold ? " · ⚠ 지금 이미 참 (켜도 바로 울리지 않는다)" : ""}.\n` +
				"**아직 켜지지 않았다.** 사용자가 화면의 카드에서 [켜기] 를 눌러야 감시가 시작된다 (10분 안에). \"화면에서 켜기를 눌러 주세요\" 라고 안내한다.";
			return { content: [{ type: "text" as const, text }], details: card };
		},
	});
	return [tool];
}

export const WATCH_TOOL_NAMES = ["watch_alert"] as const;
