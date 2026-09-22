/**
 * 타점 판정 — 구 kis-timing 스킬을 코드로 옮긴 것. **순수 함수.**
 *
 * 스킬(마크다운 절차서)로 두지 않은 이유: 내용의 대부분이 불리언 규칙과 가격 계산이다.
 * 저비용 모델에게 맡기면 층별 판단을 건너뛰거나 손절가를 틀리게 계산하고, 틀려도
 * 그럴듯해서 발견이 늦다. 여기서 판정·가격까지 만들고 모델은 해석(이벤트 리스크·문장)만 한다.
 *
 * 판정은 "규칙 기반"이지 예측이 아니다 — 카드와 텍스트에 그렇게 표시한다.
 */
import { analyze, rsi, type Bar, type IndicatorSnapshot } from "./indicators.ts";
import { roundToTick, tickSize, type Market } from "./orders.ts";

export type Verdict = "매수" | "매도" | "관망";
export type LayerState = "우호" | "비우호" | "중립";

export interface Layer {
	name: "추세" | "모멘텀" | "밸류" | "리스크";
	state: LayerState;
	/** 근거 — 숫자를 포함한 사실 기술 */
	reasons: string[];
}

export interface Scenario {
	id: "S1" | "S2" | "S3";
	title: string;
	/** 조건부 대응: "가격이 X가 되면 Y" 의 X */
	trigger: string;
	/** 트리거 가격 (호가단위 보정됨). 가격 조건이 아니면 null */
	triggerPrice: number | null;
	action: string;
	/** 비중 % (진입·청산 비율) */
	weightPct: number;
}

export interface Fundamentals {
	/** 전년 동기 대비 영업이익 증감률 % (없으면 null) */
	operatingYoy: number | null;
	/** 최신 누적 영업이익 (억원) — 적자 판정용 */
	operatingProfit: number | null;
	/** 애널리스트 투자의견 (커버 안 되면 null) */
	rating: string | null;
}

export interface TimingInput {
	bars: Bar[];
	market: Market;
	/**
	 * 보유 중이면 — 매도 판정과 청산 시나리오가 열린다.
	 * pnlPct 는 **증권사가 준 수익률**을 넘긴다. 평단·현재가로 다시 계산하면 증권사 값과
	 * 어긋나서(실측에서 1%p 넘게 차이) 한 답변에 수익률이 두 개 나온다.
	 */
	holding?: { quantity: number; avgPrice: number; pnlPct?: number } | null;
	/** 국내 종목만 (market_financials 결과) */
	fundamentals?: Fundamentals | null;
	/** 포지션 크기 산정용 총자산(원) — 없으면 수량 제안을 생략한다 */
	totalAssetsKrw?: number | null;
	/** 해외 종목의 원화 환산용 */
	usdKrw?: number | null;
}

export interface TimingResult {
	verdict: Verdict;
	/** 결론을 한 줄로 (근거 요약) */
	summary: string;
	layers: Layer[];
	scenarios: Scenario[];
	price: number;
	stopLoss: number | null;
	target1: number | null;
	target2: number | null;
	/** 목표1까지 수익 ÷ 손절까지 손실 */
	riskReward: number | null;
	/** 손익분기가 (왕복 비용 반영, 가정치) */
	breakeven: number;
	/** 적용한 왕복 비용률 % (가정) */
	roundTripCostPct: number;
	/** 매수 판정일 때만 — 총자산 1% 리스크 기준 수량 */
	sizing: { riskPct: number; riskBudgetKrw: number; quantity: number } | null;
	holding: { quantity: number; avgPrice: number; pnlPct: number } | null;
	snapshot: IndicatorSnapshot;
}

/**
 * 왕복 거래 비용 가정치 (%). 실제 수수료율을 조회하지 않으므로 **가정**이라고 표시한다.
 *   국내: 매매수수료 왕복 ~0.03% + 매도 시 거래세 ~0.15~0.18% → 0.2%
 *   해외: 매매수수료 왕복 ~0.2% (환전 스프레드 제외)
 */
export const ROUND_TRIP_COST_PCT: Record<Market, number> = { KR: 0.2, US: 0.2 };

/** 손절: 지지선이 ATR×2 이내면 지지선 한 틱 아래, 아니면 현재가 − ATR×2 */
const STOP_ATR_MULT = 2;
/** 포지션 크기: 손절 시 총자산의 1% 만 잃도록 */
const RISK_PCT = 1;

function fmt(v: number, market: Market): string {
	return market === "KR"
		? `${Math.round(v).toLocaleString("ko-KR")}원`
		: `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 틱 위로 올림 — 돌파 트리거는 저항 "위"여야 한다 */
function tickAbove(market: Market, price: number): number {
	const t = tickSize(market, price);
	const up = roundToTick(market, price) + t;
	return market === "US" ? Math.round(up * 100) / 100 : up;
}

function tickBelow(market: Market, price: number): number {
	const t = tickSize(market, price);
	const floored = roundToTick(market, price);
	const down = floored === price ? floored - t : floored;
	return market === "US" ? Math.round(down * 100) / 100 : down;
}

export function evaluateTiming(input: TimingInput): TimingResult | null {
	const snap = analyze(input.bars);
	if (!snap) return null;

	const { market } = input;
	const price = snap.price;
	const f = (v: number): string => fmt(v, market);

	// ── 추세층 ──────────────────────────────────────────────
	const trendReasons: string[] = [];
	let trendState: LayerState = "중립";
	if (snap.trend === "정배열") {
		trendState = "우호";
		trendReasons.push("이동평균 정배열 (5 > 20 > 60)");
	} else if (snap.trend === "역배열") {
		trendState = "비우호";
		trendReasons.push("이동평균 역배열 (5 < 20 < 60)");
	} else {
		trendReasons.push("이동평균 혼조");
	}
	if (snap.ma20 !== null) {
		const above = price >= snap.ma20;
		trendReasons.push(`현재가 ${f(price)} — 20일선 ${f(snap.ma20)} ${above ? "위" : "아래"}`);
		// 혼조라도 20일선 위면 "횡보→상승 전환" 후보로 본다 (구 스킬의 "횡보→상승 전환")
		if (trendState === "중립" && above && snap.ma5 !== null && snap.ma5 > snap.ma20) trendState = "우호";
	}

	// ── 모멘텀층 ────────────────────────────────────────────
	const closes = input.bars.map((b) => b.close);
	const rsiSeries = rsi(closes, 14).filter((v): v is number => v !== null);
	const rsiPrev = rsiSeries[rsiSeries.length - 2] ?? null;
	const rsiNow = snap.rsi;

	const bull: string[] = [];
	const bear: string[] = [];
	for (const s of snap.signals) {
		if (/골든크로스|저항 돌파/.test(s)) bull.push(s);
		if (/데드크로스|지지 이탈/.test(s)) bear.push(s);
	}
	if (rsiNow !== null && rsiPrev !== null) {
		if (rsiPrev < 30 && rsiNow >= 30) bull.push(`RSI 과매도 회복 (${rsiPrev.toFixed(1)} → ${rsiNow})`);
		if (rsiPrev < 50 && rsiNow >= 50) bull.push(`RSI 50 회복 (${rsiNow})`);
	}
	if (rsiNow !== null && rsiNow >= 70) bear.push(`RSI ${rsiNow} 과매수`);
	if (snap.bollingerPct !== null && snap.bollingerPct >= 100) bear.push(`볼린저 상단 돌파 (밴드 내 ${snap.bollingerPct}%)`);

	const momentumState: LayerState =
		bull.length > 0 && bear.length === 0 ? "우호" : bear.length > 0 && bull.length === 0 ? "비우호" : "중립";
	const momentumReasons =
		bull.length + bear.length === 0
			? [`특이 신호 없음 (RSI ${rsiNow ?? "—"})`]
			: [...bull.map((b) => `▲ ${b}`), ...bear.map((b) => `▼ ${b}`)];

	// ── 밸류층 (국내·데이터 있을 때만) ──────────────────────
	let valueState: LayerState = "중립";
	const valueReasons: string[] = [];
	const fund = input.fundamentals;
	if (!fund) {
		valueReasons.push(market === "KR" ? "재무 데이터 없음 — 판단 보류" : "해외 종목 — 재무 미조회");
	} else {
		let good = 0;
		let bad = 0;
		if (fund.operatingProfit !== null && fund.operatingProfit < 0) {
			bad++;
			valueReasons.push("영업 적자");
		} else if (fund.operatingYoy !== null) {
			if (fund.operatingYoy > 0) good++;
			else bad++;
			valueReasons.push(`영업이익 전년 동기 대비 ${fund.operatingYoy >= 0 ? "+" : ""}${fund.operatingYoy}%`);
		}
		if (fund.rating) {
			if (/매수|buy/i.test(fund.rating)) good++;
			else if (/매도|sell|비중축소/i.test(fund.rating)) bad++;
			valueReasons.push(`투자의견 ${fund.rating}`);
		}
		valueState = good > bad ? "우호" : bad > good ? "비우호" : "중립";
		if (valueReasons.length === 0) valueReasons.push("판단할 재무 지표 없음");
	}

	// ── 리스크층: 손절·목표 ─────────────────────────────────
	const atr = snap.atr;
	let stopLoss: number | null = null;
	if (atr !== null) {
		const atrStop = price - atr * STOP_ATR_MULT;
		const support = snap.support;
		const raw = support !== null && support < price && support >= atrStop ? tickBelow(market, support) : atrStop;
		stopLoss = raw > 0 ? roundToTick(market, raw) : null;
	}

	// 목표가는 호가단위로 **내림**하는데, 저항선이 현재가 바로 위면 내림 결과가 현재가와
	// 같아진다 (손익비 0, "목표 도달"이 이미 충족된 시나리오). 그럴 땐 ATR 기준으로 넘긴다.
	const aboveOr = (v: number | null): number | null => (v !== null && v > price ? v : null);
	let target2: number | null = null;
	let target1 =
		snap.resistance !== null && snap.resistance > price ? aboveOr(roundToTick(market, snap.resistance)) : null;
	if (target1 === null && atr !== null) target1 = aboveOr(roundToTick(market, price + atr * STOP_ATR_MULT));
	if (atr !== null && target1 !== null) {
		const cand = Math.max(snap.bollingerUpper ?? 0, price + atr * 3);
		target2 = cand > target1 ? roundToTick(market, cand) : roundToTick(market, target1 + atr);
	}

	const riskReward =
		stopLoss !== null && target1 !== null && price > stopLoss
			? Math.round(((target1 - price) / (price - stopLoss)) * 100) / 100
			: null;

	const riskReasons: string[] = [];
	if (atr !== null) riskReasons.push(`ATR ${f(atr)} (가격의 ${snap.atrPct}%)`);
	if (stopLoss !== null) riskReasons.push(`손절 ${f(stopLoss)} (${(((stopLoss - price) / price) * 100).toFixed(1)}%)`);
	if (riskReward !== null) riskReasons.push(`손익비 1 : ${riskReward}`);
	const riskState: LayerState = riskReward === null ? "중립" : riskReward >= 1.5 ? "우호" : riskReward < 1 ? "비우호" : "중립";
	if (riskReward !== null && riskReward < 1) riskReasons.push("목표까지 여유보다 손절 폭이 크다");

	const layers: Layer[] = [
		{ name: "추세", state: trendState, reasons: trendReasons },
		{ name: "모멘텀", state: momentumState, reasons: momentumReasons },
		{ name: "밸류", state: valueState, reasons: valueReasons },
		{ name: "리스크", state: riskState, reasons: riskReasons },
	];

	// ── 결론 (구 스킬 §4 결론 규칙) ────────────────────────
	const held = input.holding && input.holding.quantity > 0 ? input.holding : null;
	const hasBuyTrigger = bull.some((b) => /골든크로스|과매도 회복/.test(b));
	const sellTrigger = bear.length > 0;

	// 진입 셋업: 추세 우호 + 진입 트리거 + 하락 신호 없음 + 밸류 비우호 아님
	const buySetup = trendState === "우호" && hasBuyTrigger && !sellTrigger && valueState !== "비우호";
	// 구 스킬에는 없던 조건 — 셋업이 좋아도 손익비가 1 미만이면 "지금" 들어가는 건 나쁜 진입이다
	// (저항이 바로 위라 먹을 폭보다 손절 폭이 크다). 판정은 관망으로 내리되 시나리오는 매수용을
	// 그대로 줘서 "되돌림에서 사라 / 돌파를 확인하라"는 실제로 쓸모 있는 답을 준다.
	const poorRiskReward = riskReward !== null && riskReward < 1;
	const triggers = bull.filter((b) => /골든크로스|과매도 회복/.test(b)).join(", ");

	let verdict: Verdict;
	let summary: string;
	if (held && sellTrigger) {
		verdict = "매도";
		summary = `보유 중 매도 신호: ${bear.join(", ")}`;
	} else if (buySetup && !poorRiskReward) {
		verdict = "매수";
		summary = `추세 우호 + ${triggers}`;
	} else {
		verdict = "관망";
		if (buySetup && poorRiskReward) {
			summary = held
				? `보유 유지 — 상승 신호(${triggers})는 있으나 저항 근접(손익비 1:${riskReward}), 추가 매수는 되돌림 확인 후`
				: `진입 신호(${triggers})는 있으나 손익비 1:${riskReward} — 되돌림(S1) 또는 돌파(S2) 확인 후 진입`;
		} else if (bull.length > 0 && bear.length > 0) {
			summary = "신호 상충 — 상승·하락 신호가 동시에 있다";
		} else if (held) {
			// 보유자에게 "진입 신호가 없다"는 엉뚱한 기준이다 — 보유 관점으로 말한다
			summary =
				trendState === "비우호"
					? "매도 신호는 없으나 하락 추세 — 하락 전환(S2) 조건을 주시"
					: "매도 신호 없음 — 보유 유지, S2(하락 전환) 조건을 손절 기준으로";
		} else if (sellTrigger) {
			summary = `과열·약세 신호(${bear.join(", ")}) — 신규 진입 부적합`;
		} else if (trendState === "우호" && !hasBuyTrigger) {
			summary = "추세는 우호적이나 진입 신호(골든크로스·과매도 회복)가 없다";
		} else if (valueState === "비우호" && hasBuyTrigger) {
			summary = "기술적 신호는 있으나 펀더멘털이 비우호적";
		} else if (trendState === "비우호") {
			summary = "하락 추세 — 전환 신호 대기";
		} else {
			summary = "조건 불충분";
		}
	}

	// ── 시나리오 (조건부 대응, 상호배타) ────────────────────
	const support = snap.support;
	const resistance = snap.resistance;
	const breakout = resistance !== null ? tickAbove(market, resistance) : null;
	const breakdown = support !== null ? tickBelow(market, support) : null;
	// 되돌림 매수 지점: 현재가 아래의 20일선, 없으면 지지선
	const pullback =
		snap.ma20 !== null && snap.ma20 < price
			? roundToTick(market, snap.ma20)
			: support !== null && support < price
				? roundToTick(market, support)
				: null;

	let scenarios: Scenario[];
	// 손익비 때문에 관망으로 내린 경우도 매수용 시나리오를 준다
	if (verdict === "매수" || (verdict === "관망" && buySetup && !held)) {
		scenarios = [
			{
				id: "S1",
				title: "되돌림 매수",
				trigger: pullback !== null ? `${f(pullback)} 도달 + RSI 과열 해소` : "현재가 부근 분할 진입",
				triggerPrice: pullback,
				action: "1차 분할 진입",
				weightPct: 40,
			},
			{
				id: "S2",
				title: "돌파 추격",
				trigger: breakout !== null ? `${f(breakout)} 돌파 + 거래량 동반` : "직전 고점 돌파",
				triggerPrice: breakout,
				action: "2차 추격 진입",
				weightPct: 30,
			},
			{
				id: "S3",
				title: "이탈 회피",
				trigger: breakdown !== null ? `${f(breakdown)} 이탈 또는 데드크로스` : "지지 이탈 또는 데드크로스",
				triggerPrice: breakdown,
				action: "진입 보류, 관망 전환",
				weightPct: 0,
			},
		];
	} else if (verdict === "매도") {
		scenarios = [
			{
				id: "S1",
				title: "이익 실현",
				trigger: target1 !== null ? `${f(target1)} 도달` : "1차 목표 도달",
				triggerPrice: target1,
				action: "분할 청산",
				weightPct: 50,
			},
			{
				id: "S2",
				title: "홀드·트레일링",
				trigger: "추세 유지 (20일선 위·고점 갱신)",
				triggerPrice: null,
				action: stopLoss !== null ? `보유 유지, 손절선 ${f(stopLoss)} 에서 상향 조정` : "보유 유지, 손절선 상향",
				weightPct: 0,
			},
			{
				id: "S3",
				title: "손절",
				trigger: breakdown !== null ? `${f(breakdown)} 이탈 또는 데드크로스` : "지지 이탈",
				triggerPrice: breakdown,
				action: "전량 청산",
				weightPct: 100,
			},
		];
	} else {
		scenarios = [
			{
				id: "S1",
				title: "상승 전환",
				trigger: breakout !== null ? `${f(breakout)} 돌파 또는 골든크로스` : "골든크로스",
				triggerPrice: breakout,
				action: held ? "보유 유지·추가 매수 검토" : "매수 전환 — 진입가·비중 재산정",
				weightPct: 0,
			},
			{
				id: "S2",
				title: "하락 전환",
				trigger: breakdown !== null ? `${f(breakdown)} 이탈 또는 데드크로스` : "지지 이탈 또는 데드크로스",
				triggerPrice: breakdown,
				action: held ? "비중 축소·손절 검토" : "진입 회피",
				weightPct: 0,
			},
			{
				id: "S3",
				title: "횡보 유지",
				trigger: "S1·S2 미발동",
				triggerPrice: null,
				action: "관망 유지",
				weightPct: 0,
			},
		];
	}

	// ── 손익분기·포지션 크기 ────────────────────────────────
	const costPct = ROUND_TRIP_COST_PCT[market];
	const basis = held ? held.avgPrice : price;
	const breakevenRaw = basis * (1 + costPct / 100);
	const breakeven = market === "US" ? Math.round(breakevenRaw * 100) / 100 : Math.ceil(breakevenRaw);

	let sizing: TimingResult["sizing"] = null;
	if (verdict === "매수" && input.totalAssetsKrw && input.totalAssetsKrw > 0 && stopLoss !== null && price > stopLoss) {
		const fx = market === "US" ? (input.usdKrw ?? 0) : 1;
		const perShareKrw = (price - stopLoss) * fx;
		if (perShareKrw > 0) {
			const riskBudgetKrw = Math.round(input.totalAssetsKrw * (RISK_PCT / 100));
			sizing = { riskPct: RISK_PCT, riskBudgetKrw, quantity: Math.floor(riskBudgetKrw / perShareKrw) };
		}
	}

	return {
		verdict,
		summary,
		layers,
		scenarios,
		price,
		stopLoss,
		target1,
		target2,
		riskReward,
		breakeven,
		roundTripCostPct: costPct,
		sizing,
		holding: held
			? {
					quantity: held.quantity,
					avgPrice: held.avgPrice,
					pnlPct:
						held.pnlPct ??
						(held.avgPrice > 0 ? Math.round(((price - held.avgPrice) / held.avgPrice) * 1000) / 10 : 0),
				}
			: null,
		snapshot: snap,
	};
}
