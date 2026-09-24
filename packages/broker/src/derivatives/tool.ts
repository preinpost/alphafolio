/**
 * derivatives_greeks — 옵션 내재변동성·그릭스·시나리오 손익 (PLAN §37). 계산은 코드가, 해석은 모델이.
 *
 * 두 가지 입력:
 *   - code: 국내 옵션 종목코드 → KIS 선물옵션 시세(FHMIF10000000)에서 가격·행사가·최종거래일·기초지수를 읽는다.
 *           KIS 가 주는 내재변동성·그릭스는 "참고"로 함께 보인다 (계산 기준이 공개되지 않았다).
 *   - 직접 입력: 해외·미국 주식 옵션 등. KIS 해외 선물 시세는 CME 시세 신청 계좌가 필요하고 가격 표기 배율도
 *           공개돼 있지 않아 자동 조회하지 않는다 — 값을 받아서 계산만 한다.
 * 파생 주문은 없다 (조회·계산 전용).
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { kisGet, type KisContext } from "../kis/client.ts";
import type { BrokerAccess } from "../portfolio.ts";
import { greeks, impliedVol, round, scenarioGrid, type Greeks, type OptionInput, type OptionModel, type OptionType } from "./greeks.ts";

export interface DomesticOptionQuote {
	code: string;
	name: string;
	type: OptionType;
	price: number;
	/** 오늘 체결이 없어 기준가를 썼는가 */
	priceIsBase: boolean;
	strike: number;
	/** YYYYMMDD */
	lastTradeDate: string;
	underlyingName: string;
	underlying: number;
	multiplier: number;
	kis: { iv: number; delta: number; gamma: number; theta: number; vega: number; rho: number; remainingDays: number };
}

const n = (v: unknown): number => {
	const x = Number(String(v ?? "").replace(/,/g, "").trim());
	return Number.isFinite(x) ? x : 0;
};

/** KIS 선물옵션 시세 응답 → 옵션 정보 (순수). 옵션이 아니면 null */
export function parseDomesticOptionQuote(code: string, json: Record<string, unknown>, market: "O" | "JO"): DomesticOptionQuote | null {
	const o1 = (json.output1 ?? {}) as Record<string, unknown>;
	const o3 = (json.output3 ?? {}) as Record<string, unknown>;
	const name = String(o1.hts_kor_isnm ?? "").trim();
	const strike = n(o1.acpr);
	if (!name || strike <= 0) return null;
	// 이름이 "C 202610 1,475.0" / "P …" — 코드 첫 글자(구 2·3, 신 B·C)보다 믿을 만하다
	const head = name.replace(/^미니\s*/, "").charAt(0).toUpperCase();
	const type: OptionType | null = head === "C" || /콜/.test(name) ? "call" : head === "P" || /풋/.test(name) ? "put" : null;
	if (!type) return null;
	const last = n(o1.futs_prpr);
	const base = n(o1.futs_sdpr);
	const underlyingName = String(o3.hts_kor_isnm ?? "").trim();
	const multiplier = market === "JO" ? 10 : /미니/.test(name) ? 50_000 : /코스닥|KOSDAQ/i.test(underlyingName) ? 10_000 : 250_000;
	return {
		code,
		name,
		type,
		price: last > 0 ? last : base,
		priceIsBase: !(last > 0),
		strike,
		lastTradeDate: String(o1.futs_last_tr_date ?? "").trim(),
		underlyingName: underlyingName || "기초자산",
		underlying: n(o3.bstp_nmix_prpr),
		multiplier,
		kis: {
			iv: n(o1.hts_ints_vltl),
			delta: n(o1.delta_val),
			gamma: n(o1.gama),
			theta: n(o1.theta),
			vega: n(o1.vega),
			rho: n(o1.rho),
			remainingDays: n(o1.hts_rmnn_dynu),
		},
	};
}

/** 최종거래일(KST 15:20 마감)까지 남은 달력일 — 소수 포함 */
export function daysToExpiry(yyyymmdd: string, now: number = Date.now()): number {
	const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd);
	if (!m) throw new Error(`만기일 형식이 올바르지 않습니다: ${yyyymmdd} (YYYY-MM-DD)`);
	const close = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 15 - 9, 20);
	return (close - now) / 86_400_000;
}

async function fetchDomesticOption(ctx: KisContext, code: string, market?: "O" | "JO"): Promise<DomesticOptionQuote> {
	for (const mk of market ? [market] : (["O", "JO"] as const)) {
		const json = await kisGet(ctx, {
			path: "/uapi/domestic-futureoption/v1/quotations/inquire-price",
			trId: "FHMIF10000000",
			query: { FID_COND_MRKT_DIV_CODE: mk, FID_INPUT_ISCD: code },
			label: "선물옵션 시세",
		});
		const q = parseDomesticOptionQuote(code, json as Record<string, unknown>, mk);
		if (q) return q;
	}
	throw new Error(`옵션 시세를 찾지 못했습니다: ${code} — 옵션 종목코드인지 확인하세요 (전광판: kis_call FHPIF05030100).`);
}

const pct = (x: number, d = 2): string => `${(x * 100).toFixed(d)}%`;
const fmt = (x: number, d = 4): string => {
	const r = round(x, d);
	return Math.abs(r) >= 1000 ? r.toLocaleString("en-US", { maximumFractionDigits: Math.min(d, 2) }) : String(r);
};
/** 손익 표시 — 부호를 붙이고, 반올림해서 0 이면 "0" (−0 → "+-0" 방지) */
export const money = (x: number, cur: string): string => {
	const r = Math.round(x) || 0;
	return `${r > 0 ? "+" : ""}${r.toLocaleString("en-US")}${cur === "KRW" ? "원" : ` ${cur}`}`;
};

export interface GreeksReport {
	input: OptionInput;
	iv: number | null;
	ivNote?: string;
	g: Greeks | null;
	lines: string[];
}

/** 입력 → 텍스트 보고 (순수 — 시각만 주입) */
export function buildGreeksReport(p: {
	title: string;
	type: OptionType;
	model: OptionModel;
	underlying: number;
	strike: number;
	days: number;
	rate: number;
	dividend: number;
	price?: number;
	vol?: number;
	multiplier: number;
	currency: string;
	quantity?: number;
	kis?: DomesticOptionQuote["kis"];
	notes?: string[];
}): GreeksReport {
	if (!(p.days > 0)) throw new Error(`만기가 지났거나 오늘입니다 (남은 ${round(p.days, 2)}일) — 그릭스를 계산할 수 없습니다.`);
	const base: Omit<OptionInput, "vol"> = { type: p.type, model: p.model, underlying: p.underlying, strike: p.strike, years: p.days / 365, rate: p.rate, dividend: p.dividend };
	let iv: number | null = null;
	let ivNote: string | undefined;
	if (p.vol !== undefined) iv = p.vol;
	else if (p.price !== undefined) {
		const r = impliedVol(base, p.price);
		iv = r.vol;
		ivNote = r.reason;
	} else throw new Error("옵션 가격(price) 또는 변동성(vol) 중 하나가 필요합니다.");

	const lines = [p.title];
	lines.push(
		`모델 ${p.model === "black76" ? "Black-76 (선물 기초)" : "Black-Scholes (현물 기초)"} · 남은 ${round(p.days, 1)}일 · 금리 ${pct(p.rate)}${p.model === "bsm" ? ` · 배당 ${pct(p.dividend)}` : ""} (가정)`,
	);
	if (iv === null) {
		lines.push(`내재변동성을 구할 수 없습니다: ${ivNote ?? "알 수 없음"}`);
		return { input: { ...base, vol: 0 }, iv, ivNote, g: null, lines };
	}
	const input: OptionInput = { ...base, vol: iv };
	const g = greeks(input);
	const moneyness = p.type === "call" ? p.underlying - p.strike : p.strike - p.underlying;
	const intrinsic = Math.max(0, moneyness);
	lines.push(
		(p.price !== undefined ? `가격 ${p.price} → 내재변동성 ${pct(iv)}` : `변동성 ${pct(iv)} 가정 → 이론가 ${fmt(g.price)}`) +
			(p.kis && p.kis.iv > 0 ? ` (KIS 제공 ${p.kis.iv.toFixed(2)}%)` : "") +
			` · 내재가치 ${fmt(intrinsic)} · 시간가치 ${fmt((p.price ?? g.price) - intrinsic)} · ${Math.abs(moneyness) / p.underlying < 0.005 ? "등가(ATM)" : moneyness > 0 ? "내가격(ITM)" : "외가격(OTM)"}`,
	);
	lines.push(`델타 ${fmt(g.delta)} · 감마 ${fmt(g.gamma, 6)} · 세타 ${fmt(g.theta)}/일(달력일) · 베가 ${fmt(g.vega)}/변동성 1%p · 로 ${fmt(g.rho)}/금리 1%p`);
	if (p.kis) lines.push(`  (KIS 제공 참고: 델타 ${p.kis.delta} · 감마 ${p.kis.gamma} · 세타 ${p.kis.theta} · 베가 ${p.kis.vega} · 로 ${p.kis.rho} · 잔존 ${p.kis.remainingDays}일 — 산식·기준 비공개)`);

	const m = p.multiplier;
	const q = p.quantity ?? 1;
	const who = p.quantity !== undefined ? `보유 ${q > 0 ? `매수 ${q}` : `매도 ${-q}`}계약` : "계약 1개";
	lines.push(
		`${who} 기준 (승수 ${m.toLocaleString("en-US")}): 기초자산 1 오르면 ${money(g.delta * m * q, p.currency)} · 하루 지나면 ${money(g.theta * m * q, p.currency)} · ` +
			`변동성 1%p 오르면 ${money(g.vega * m * q, p.currency)} · 금리 1%p 오르면 ${money(g.rho * m * q, p.currency)} · ` +
			`기초자산 노출(델타×기초자산×승수) ${money(g.delta * q * p.underlying * m, p.currency)}`,
	);
	// 만기 손익 — 프리미엄 기준 (중간 청산은 위 시나리오 표)
	const prem = p.price ?? g.price;
	const be = p.type === "call" ? p.strike + prem : p.strike - prem;
	const cap = (p.strike - prem) * m * Math.abs(q); // 풋의 끝 — 기초자산이 0 이 될 때
	const premium = prem * m * Math.abs(q);
	const unlimited = "제한 없음";
	const [maxGain, maxLoss] =
		q > 0 ? [p.type === "call" ? unlimited : money(cap, p.currency), money(-premium, p.currency)] : [money(premium, p.currency), p.type === "call" ? unlimited : money(-cap, p.currency)];
	lines.push(`만기 손익분기점 ${fmt(be, 2)} (지금보다 ${pct((be - p.underlying) / p.underlying)}) · 만기 최대 이익 ${maxGain} · 최대 손실 ${maxLoss}`);

	const moves = [-0.05, -0.03, -0.01, 0, 0.01, 0.03, 0.05];
	const days = [0, 1, 5].filter((d) => d < p.days);
	const cells = scenarioGrid(input, moves, [...days, p.days], m);
	const head = [...days.map((d) => (d === 0 ? "지금" : `${d}일 후`)), "만기 직전"];
	lines.push("", `시나리오 손익 (${who}, 변동성 ${pct(iv, 1)} 고정, ${p.currency === "KRW" ? "원" : p.currency}):`);
	lines.push(`| 기초자산 | ${head.join(" | ")} |`, `|---|${head.map(() => "---").join("|")}|`);
	for (const mv of moves) {
		const row = cells.filter((c) => c.move === mv).map((c) => money(c.change * q, p.currency).replace(/원$/, ""));
		lines.push(`| ${mv === 0 ? "그대로" : `${mv > 0 ? "+" : ""}${mv * 100}%`} (${fmt(p.underlying * (1 + mv), 2)}) | ${row.join(" | ")} |`);
	}
	for (const note of p.notes ?? []) lines.push(`⚠️ ${note}`);
	return { input, iv, ivNote, g, lines };
}

export function createDerivativesTools(deps: { brokers: BrokerAccess; now?: () => number }) {
	const now = deps.now ?? Date.now;
	const tool = defineTool({
		name: "derivatives_greeks",
		label: "옵션 그릭스",
		description:
			"옵션의 내재변동성·그릭스(델타·감마·세타·베가·로)·시나리오 손익(기초자산 ±1~5% × 경과일)을 **계산**한다. 숫자를 직접 계산하지 말고 이 결과를 인용한다. " +
			"국내 옵션은 code(예: B01610B92 — 코드는 kis_call 옵션전광판 FHPIF05030100 으로 찾는다)만 주면 KIS 시세로 채운다. " +
			"해외·미국 주식 옵션은 type·underlying·strike·expiry·price(또는 vol)를 직접 넣는다 (선물 기초면 model=black76). " +
			"quantity 를 주면 포지션 기준(매도는 음수). 조회·계산 전용 — 파생 주문은 지원하지 않는다.",
		parameters: Type.Object({
			code: Type.Optional(Type.String({ description: "국내 옵션 종목코드 (KOSPI200·미니·위클리·주식옵션)" })),
			type: Type.Optional(Type.Union([Type.Literal("call"), Type.Literal("put")])),
			underlying: Type.Optional(Type.Number({ description: "기초자산 가격 (black76 은 선물가격)" })),
			strike: Type.Optional(Type.Number()),
			expiry: Type.Optional(Type.String({ description: "만기(최종거래일) YYYY-MM-DD" })),
			price: Type.Optional(Type.Number({ description: "옵션 가격 — 내재변동성을 역산한다" })),
			vol: Type.Optional(Type.Number({ description: "변동성 % (가격 대신, 예: 25)" })),
			model: Type.Optional(Type.Union([Type.Literal("bsm"), Type.Literal("black76")], { description: "bsm=현물(주식·지수) 기초(기본) / black76=선물 기초" })),
			rate: Type.Optional(Type.Number({ description: "무위험금리 % (기본: 국내 2.5 · 그 외 4.0, 가정)" })),
			dividend: Type.Optional(Type.Number({ description: "배당수익률 % (bsm 만, 기본 0)" })),
			multiplier: Type.Optional(Type.Number({ description: "계약 승수 (국내는 자동, 미국 주식옵션 100, ES 옵션 50)" })),
			currency: Type.Optional(Type.String({ description: "직접 입력 시 통화 표시 (예: USD) — 환산하지 않는다" })),
			quantity: Type.Optional(Type.Number({ description: "보유 계약 수 (매도는 음수)" })),
			market: Type.Optional(Type.Union([Type.Literal("O"), Type.Literal("JO")], { description: "국내: O=지수옵션, JO=주식옵션 (비우면 자동)" })),
		}),
		execute: async (_id, params) => {
			const pctIn = (v: number | undefined, d: number): number => (v === undefined ? d : v / 100);
			let r: GreeksReport;
			if (params.code) {
				const kis = deps.brokers.kis;
				if (!kis) throw new Error("국내 옵션 조회는 한국투자증권 연결이 필요합니다 — 값을 직접 넣으면 계산만 할 수 있습니다.");
				const q = await fetchDomesticOption(kis(), params.code.trim().toUpperCase(), params.market);
				if (!(q.underlying > 0)) throw new Error(`${q.name}: 기초자산 가격을 받지 못했습니다 — underlying 을 직접 넣어 주세요.`);
				const notes: string[] = [];
				if (q.priceIsBase) notes.push("오늘 체결이 없어 기준가로 계산했습니다 — 호가와 다를 수 있습니다.");
				r = buildGreeksReport({
					title: `[옵션] ${q.name} (${q.code}) · ${q.underlyingName} ${q.underlying.toLocaleString("en-US")} · 최종거래일 ${q.lastTradeDate.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")}`,
					type: q.type,
					model: "bsm",
					underlying: params.underlying ?? q.underlying,
					strike: q.strike,
					days: daysToExpiry(q.lastTradeDate, now()),
					rate: pctIn(params.rate, 0.025),
					dividend: pctIn(params.dividend, 0),
					...(params.vol !== undefined ? { vol: params.vol / 100 } : { price: params.price ?? q.price }),
					multiplier: params.multiplier ?? q.multiplier,
					currency: "KRW",
					...(params.quantity !== undefined ? { quantity: params.quantity } : {}),
					kis: q.kis,
					notes,
				});
			} else {
				const missing = (["type", "underlying", "strike", "expiry"] as const).filter((k) => params[k] === undefined);
				if (missing.length) throw new Error(`직접 계산에는 ${missing.join("·")} 가 필요합니다 (국내 옵션이면 code 만 주면 된다).`);
				r = buildGreeksReport({
					title: `[옵션] ${params.type === "call" ? "콜" : "풋"} 행사가 ${params.strike} · 기초자산 ${params.underlying} · 만기 ${params.expiry}`,
					type: params.type!,
					model: params.model ?? "bsm",
					underlying: params.underlying!,
					strike: params.strike!,
					days: daysToExpiry(params.expiry!, now()),
					rate: pctIn(params.rate, 0.04),
					dividend: pctIn(params.dividend, 0),
					...(params.vol !== undefined ? { vol: params.vol / 100 } : params.price !== undefined ? { price: params.price } : {}),
					multiplier: params.multiplier ?? 1,
					currency: params.currency ?? "USD",
					...(params.quantity !== undefined ? { quantity: params.quantity } : {}),
				});
			}
			return {
				content: [{ type: "text" as const, text: r.lines.join("\n") }],
				details: { kind: "derivatives-greeks", iv: r.iv, greeks: r.g },
			};
		},
	});
	return [tool];
}

export const DERIVATIVES_TOOL_NAMES = ["derivatives_greeks"] as const;
