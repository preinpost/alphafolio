/**
 * 감시 프리셋 (PLAN §40) — 자주 쓰는 조건 조합을 **데이터로**. 켤 때 조건 트리로 펼쳐 저장한다 (평가기는 프리셋을 모른다).
 * 같은 \"거래량 급증\" 이 요청마다 다르게 조립되지 않게 하는 게 목적이다. 숫자는 전부 바꿀 수 있는 기본값.
 */
import type { CondNode } from "./types.ts";

export interface PresetParam {
	label: string;
	default: number | null;
	min: number;
	max: number;
	/** 정수만 */
	int?: boolean;
	/** 기본값이 없으면 사용자가 정해야 한다 (예: 손절 기준가) */
	required?: boolean;
}

export interface Preset {
	id: string;
	name: string;
	/** 무엇을 잡는지 한 줄 */
	summary: string;
	params: Readonly<Record<string, PresetParam>>;
	build: (p: Record<string, number>) => { all: CondNode[]; confirmBars: number };
}

const P = (label: string, d: number | null, min: number, max: number, extra: Partial<PresetParam> = {}): PresetParam => ({ label, default: d, min, max, ...extra });

export const PRESETS: readonly Preset[] = [
	{
		id: "volume_surge_breakout",
		name: "거래량 급증 돌파",
		summary: "평소보다 거래가 터지면서 양봉으로 이평을 뚫는 봉",
		params: { volMult: P("거래량 배수 (직전 20봉 평균 대비)", 2, 1.1, 20), ma: P("이평 기간", 20, 2, 200, { int: true }) },
		build: (p) => ({
			all: [
				{ left: { ind: "vol_ratio", period: 20 }, op: ">=", right: p.volMult as number },
				{ left: "close", op: ">", right: "open" },
				{ left: "close", op: "crosses_above", right: { ind: "sma", period: p.ma as number } },
			],
			confirmBars: 1,
		}),
	},
	{
		id: "volume_jump",
		name: "직전 봉 대비 거래량 급증",
		summary: "직전 봉보다 거래량이 크게 늘어난 봉 (일봉·주봉에 알맞다 — 장중 봉은 rvol 프리셋을 권한다)",
		params: { pct: P("증가율 %", 50, 5, 5000), minVolume: P("거래량 하한 (0 = 없음)", 0, 0, 1e12) },
		build: (p) => ({
			all: [
				{ left: "vol_chg_pct", op: ">=", right: p.pct as number },
				...((p.minVolume as number) > 0 ? [{ left: "volume" as const, op: ">=" as const, right: p.minVolume as number }] : []),
			],
			confirmBars: 1,
		}),
	},
	{
		id: "rvol_surge",
		name: "같은 시각 대비 거래량 급증",
		summary: "오늘 이 시각까지의 거래량이 지난 며칠 같은 시각 평균의 몇 배 (TradingView Relative Volume at Time)",
		params: { mult: P("배수", 2, 1.1, 50), days: P("비교 일수", 10, 1, 30, { int: true }) },
		build: (p) => ({ all: [{ left: { ind: "rvol", length: p.days as number, mode: "cumulative" }, op: ">=", right: p.mult as number }], confirmBars: 1 }),
	},
	{
		id: "new_high_breakout",
		name: "신고가 돌파",
		summary: "직전 N봉 최고가를 종가로 넘기고 거래량이 받쳐 주는 봉",
		params: { lookback: P("기간 (봉)", 20, 5, 250, { int: true }), volMult: P("거래량 배수 (직전 20봉 평균 대비)", 1.5, 1, 20) },
		build: (p) => ({
			all: [
				{ left: "close", op: ">", right: { ind: "highest", period: p.lookback as number, of: "high" } },
				{ left: { ind: "vol_ratio", period: 20 }, op: ">=", right: p.volMult as number },
			],
			confirmBars: 1,
		}),
	},
	{
		id: "oversold_rebound",
		name: "과매도 반등",
		summary: "최근 며칠 안에 RSI 가 과매도권을 찍고, 지금 단기 이평을 위로 넘는 봉",
		params: { rsiBelow: P("RSI 기준", 30, 5, 50), within: P("최근 N봉 안에", 5, 1, 50, { int: true }), ma: P("돌파할 이평 기간", 5, 2, 60, { int: true }) },
		build: (p) => ({
			all: [
				{ within: p.within as number, cond: { left: "rsi14", op: "<", right: p.rsiBelow as number } },
				{ left: "close", op: "crosses_above", right: { ind: "sma", period: p.ma as number } },
			],
			confirmBars: 1,
		}),
	},
	{
		id: "golden_cross",
		name: "골든크로스",
		summary: "단기 이평이 장기 이평을 위로 뚫는 봉",
		params: { fast: P("단기 이평", 20, 2, 200, { int: true }), slow: P("장기 이평", 60, 3, 400, { int: true }) },
		build: (p) => ({ all: [{ left: { ind: "sma", period: p.fast as number }, op: "crosses_above", right: { ind: "sma", period: p.slow as number } }], confirmBars: 1 }),
	},
	{
		id: "dead_cross",
		name: "데드크로스",
		summary: "단기 이평이 장기 이평을 아래로 뚫는 봉",
		params: { fast: P("단기 이평", 20, 2, 200, { int: true }), slow: P("장기 이평", 60, 3, 400, { int: true }) },
		build: (p) => ({ all: [{ left: { ind: "sma", period: p.fast as number }, op: "crosses_below", right: { ind: "sma", period: p.slow as number } }], confirmBars: 1 }),
	},
	{
		id: "bb_lower_break",
		name: "볼린저 하단 이탈",
		summary: "종가가 볼린저 하단 아래로 N봉 연속 마감",
		params: { bars: P("연속 봉", 2, 1, 10, { int: true }) },
		build: (p) => ({ all: [{ left: "close", op: "<", right: "bb_lower" }], confirmBars: p.bars as number }),
	},
	{
		id: "close_stop",
		name: "급락 방어 (마감 손절)",
		summary: "종가가 기준가 아래로 N봉 연속 마감 — 순간 꼬리에는 울리지 않는다",
		params: { level: P("기준가", null, 0, 1e12, { required: true }), bars: P("연속 봉", 2, 1, 10, { int: true }) },
		build: (p) => ({ all: [{ left: "close", op: "<", right: p.level as number }], confirmBars: p.bars as number }),
	},
	{
		id: "big_move",
		name: "급등·급락 감지",
		summary: "N봉 사이에 ±X% 넘게 움직인 봉 (방향 1 = 급등, -1 = 급락, 0 = 둘 다)",
		params: { pct: P("변동률 %", 5, 0.1, 100), bars: P("기간 (봉)", 1, 1, 100, { int: true }), direction: P("방향 (1 · -1 · 0)", 0, -1, 1, { int: true }) },
		build: (p) => {
			const ref = { ind: "change_pct" as const, period: p.bars as number };
			const up: CondNode = { left: ref, op: ">=", right: p.pct as number };
			const down: CondNode = { left: ref, op: "<=", right: -(p.pct as number) };
			return { all: [p.direction === 1 ? up : p.direction === -1 ? down : { any: [up, down] }], confirmBars: 1 };
		},
	},
];

export const PRESET_BY_ID: ReadonlyMap<string, Preset> = new Map(PRESETS.map((p) => [p.id, p]));

/** 매개변수 채우기·검증 — 빠진 값은 기본값, 필수인데 없으면 오류 */
export function resolvePreset(id: string, input: Record<string, unknown> = {}): { preset: Preset; params: Record<string, number>; errors: string[] } | { preset: null; params: {}; errors: string[] } {
	const preset = PRESET_BY_ID.get(id);
	if (!preset) return { preset: null, params: {}, errors: [`모르는 프리셋: ${id} — ${PRESETS.map((p) => p.id).join(", ")}`] };
	const params: Record<string, number> = {};
	const errors: string[] = [];
	for (const k of Object.keys(input)) if (!(k in preset.params)) errors.push(`${preset.name}: 모르는 매개변수 ${k} — ${Object.keys(preset.params).join(", ")}`);
	for (const [k, spec] of Object.entries(preset.params)) {
		const raw = input[k];
		const v = raw === undefined || raw === null || raw === "" ? spec.default : Number(raw);
		if (v === null) {
			errors.push(`${preset.name}: ${spec.label}(${k}) 를 정해 주세요`);
			continue;
		}
		if (!Number.isFinite(v) || v < spec.min || v > spec.max || (spec.int && !Number.isInteger(v))) {
			errors.push(`${preset.name}: ${spec.label}(${k}) 는 ${spec.min}~${spec.max}${spec.int ? " 정수" : ""}`);
			continue;
		}
		params[k] = v;
	}
	if (id === "golden_cross" || id === "dead_cross") {
		if ((params.fast ?? 0) >= (params.slow ?? 0)) errors.push(`${preset.name}: 단기 이평은 장기 이평보다 짧아야 합니다`);
	}
	return { preset, params, errors };
}

/** 툴 설명용 목록 */
export function presetCatalog(): string {
	return PRESETS.map((p) => `${p.id}(${p.name}: ${Object.entries(p.params).map(([k, s]) => `${k}${s.default === null ? " 필수" : `=${s.default}`}`).join(", ")})`).join(" · ");
}
