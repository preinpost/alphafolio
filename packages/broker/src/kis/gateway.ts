/**
 * KIS 범용 조회 — 카탈로그(catalog.json)에 있는 **조회(GET) API 전부**를 호출한다 (PLAN §31).
 *
 * 전용 툴(market_price·market_timing 등)이 1순위이고, 여기는 그 밖의 전부(수급·공매도·신용·지수·순위…)를 맡는다.
 * 모델이 원시 API 를 직접 다루면 생기는 문제를 서버가 막는다:
 *   - 쓰기(POST: 주문·정정·취소)는 실행하지 않는다 — 확인 카드 경로로만 (주문 안전 원칙)
 *   - 계좌번호는 서버가 넣는다 — 모델이 넣은 값은 무시한다
 *   - 연속조회 키(CTX_AREA_*)·tr_cont 는 서버가 관리한다
 *   - 날짜는 "today" / "today-30" 으로 받는다 — 모델은 오늘 날짜를 모른다 (페르소나: 추측 금지)
 *   - 응답 필드를 한글 이름으로 바꾼다 — frgn_ntby_qty 를 추측해서 읽지 않게 (외국인 순매수 수량)
 *   - 모르는 파라미터는 거절한다 — 오타가 조용히 무시되어 엉뚱한 조건으로 조회되지 않게
 */
import { readFileSync } from "node:fs";
import { accountParams, kisGetPage, type KisContext, type KisResponse } from "./client.ts";

/** [한글명, 필수(1/0), 입력 안내] */
type ParamSpec = [string, number, string];
/** [한글명, 단위·설명] */
type FieldSpec = [string, string?];

export interface CatalogApi {
	name: string;
	category: string;
	method: string;
	path: string;
	trIds: string[];
	desc: string;
	params: Record<string, ParamSpec>;
	fields: Record<string, FieldSpec>;
}

interface Catalog {
	source: string;
	generated: string;
	count: number;
	apis: Record<string, CatalogApi>;
}

export class KisGatewayError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KisGatewayError";
	}
}

let cached: Catalog | null = null;
let globalFields: Map<string, FieldSpec> | null = null;

export function kisCatalog(): Catalog {
	if (!cached) cached = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8")) as Catalog;
	return cached;
}

/** 모든 API 의 필드 사전 — API 별 규격에 빠진 필드(문서 누락)를 메운다 */
function fieldLabel(api: CatalogApi, code: string): FieldSpec | undefined {
	const own = api.fields[code] ?? api.fields[code.toLowerCase()];
	if (own) return own;
	if (!globalFields) {
		globalFields = new Map();
		for (const a of Object.values(kisCatalog().apis)) {
			for (const [c, f] of Object.entries(a.fields)) if (!globalFields.has(c)) globalFields.set(c, f);
		}
	}
	return globalFields.get(code) ?? globalFields.get(code.toLowerCase());
}

export const isWriteApi = (api: CatalogApi): boolean => api.method !== "GET";

let verified: Set<string> | null = null;
/**
 * 실측으로 데이터가 온 것이 확인된 API (spike/07-kis-sweep.ts). **확인된 것만** 표시한다 —
 * 실패 쪽은 예시값 문제일 수 있어 모델에게 보여주지 않는다.
 */
export function isVerifiedKisApi(key: string): boolean {
	if (!verified) {
		try {
			const s = JSON.parse(readFileSync(new URL("./catalog-status.json", import.meta.url), "utf8")) as { ok?: string[] };
			verified = new Set(s.ok ?? []);
		} catch {
			verified = new Set();
		}
	}
	return verified.has(key);
}

// ── 찾기 ────────────────────────────────────────────────────

/** 사용자가 흔히 쓰는 말 → 규격에 쓰인 말 */
const SYNONYMS: Record<string, string[]> = {
	수급: ["투자자", "매매동향", "순매수"],
	외인: ["외국인"],
	외국인: ["외국인", "외인"],
	시총: ["시가총액"],
	신고가: ["신고"],
	신저가: ["신저"],
	지수: ["지수", "업종"],
	섹터: ["업종"],
	배당: ["배당"],
	빚투: ["신용"],
	대차: ["대차"],
	공매도: ["공매도"],
	프로그램: ["프로그램"],
	호가: ["호가"],
	미국: ["해외"],
	해외: ["해외"],
	잔고: ["잔고"],
	체결: ["체결"],
	순위: ["순위", "상위"],
	랭킹: ["순위", "상위"],
	etf: ["etf", "nav"],
};

function expand(query: string): string[] {
	const raw = query
		.toLowerCase()
		.split(/[\s,·/()[\]{}"'?!.]+/)
		.filter((t) => t.length >= 2 || /^[a-z0-9]$/.test(t));
	const out = new Set<string>();
	for (const t of raw) {
		out.add(t);
		// "외국인수급동향" 처럼 붙여 쓴 말도 찾게 — 사전에 있는 말이 들어 있으면 펼친다
		for (const [k, vs] of Object.entries(SYNONYMS)) if (t.includes(k)) for (const v of vs) out.add(v);
		for (const w of ["외국인", "기관", "개인", "투자자", "매매동향", "순매수", "동향", "추이", "일별", "종목별", "시장별"]) {
			if (t.length > w.length && t.includes(w)) out.add(w);
		}
	}
	return [...out];
}

export interface FoundApi {
	key: string;
	api: CatalogApi;
	score: number;
}

export function findKisApis(query: string, limit = 8): FoundApi[] {
	const tokens = expand(query);
	if (tokens.length === 0) return [];
	const found: FoundApi[] = [];
	for (const [key, api] of Object.entries(kisCatalog().apis)) {
		const name = api.name.toLowerCase();
		const cat = api.category.toLowerCase();
		const desc = api.desc.toLowerCase();
		const fields = Object.values(api.fields)
			.map((f) => f[0])
			.join(" ")
			.toLowerCase();
		let score = 0;
		for (const t of tokens) {
			if (api.trIds.some((id) => id.toLowerCase() === t)) score += 20;
			if (name.includes(t)) score += 6;
			if (cat.includes(t)) score += 3;
			if (fields.includes(t)) score += 2;
			if (desc.includes(t)) score += 1;
		}
		if (score > 0) found.push({ key, api, score });
	}
	// 동점이면 조회 API 를 먼저, 그다음 이름이 짧은 것(일반적인 API)을 먼저
	return found
		.sort((a, b) => b.score - a.score || Number(isWriteApi(a.api)) - Number(isWriteApi(b.api)) || a.api.name.length - b.api.name.length)
		.slice(0, limit);
}

/** 키·TR ID·정확한 이름으로 API 를 찾는다 */
export function resolveKisApi(ref: string): { key: string; api: CatalogApi } | null {
	const apis = kisCatalog().apis;
	const r = ref.trim();
	if (apis[r]) return { key: r, api: apis[r] };
	const byTr = Object.entries(apis).filter(([, a]) => a.trIds.some((id) => id.toUpperCase() === r.toUpperCase()));
	if (byTr.length === 1) return { key: byTr[0]![0], api: byTr[0]![1] };
	const byName = Object.entries(apis).filter(([, a]) => a.name === r);
	if (byName.length === 1) return { key: byName[0]![0], api: byName[0]![1] };
	return null;
}

// ── 파라미터 ────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, "0");

/** "today" / "today-30" / "today+1" → YYYYMMDD (한국 시간) */
export function resolveDateToken(value: string, now: number = Date.now()): string {
	const m = /^today(?:([+-])(\d{1,4}))?$/i.exec(value.trim());
	if (!m) return value;
	const offset = m[2] ? Number(m[2]) * (m[1] === "-" ? -1 : 1) : 0;
	const d = new Date(now + 9 * 3_600_000 + offset * 86_400_000);
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** 대소문자 무관 — 규격에 소문자로 적힌 API 가 있다 (32개). 계좌 보호가 표기 차이로 뚫리지 않게 */
const isAccountParam = (code: string): boolean => /^(CANO|ACNT_PRDT_CD)$/i.test(code);
const isContinuationParam = (code: string): boolean => /^CTX_AREA_/i.test(code);
/** 필수지만 "공란 입력" 이라고 적힌 파라미터 — 모델에게 묻지 않고 빈 값으로 */
const blankAllowed = (spec: ParamSpec): boolean => /공란|공백|빈\s*값|null|space/i.test(spec[2]);

/**
 * 규격 안내에 **값이 하나만** 적혀 있으면 그 값 — 모델이 빠뜨려도 서버가 채운다.
 *   "J" · "03 입력" · "\"1\" 입력" · "시장구분코드 (주식 J)" · "W(Unique key)" · "Unique key(11173)"
 * 조건이 붙었거나("…일 경우") 예시("ex 13시")·선택지("J:KRX, NX:NXT")면 채우지 않는다 — 모델이 고른다.
 * 실측: 시장구분 코드를 추측하다 틀린 것이 조회 실패의 가장 큰 원인이었다 (65건, PLAN §31).
 */
export function fixedValue(desc: string): string | undefined {
	const d = desc.trim();
	if (!d || /경우|\bex\b|예시|예\)|예:|또는|[A-Z0-9]\s*[:：]/i.test(d)) return undefined;
	const uk = /Unique\s*key\s*\(\s*([0-9A-Z]{3,6})\s*\)/i.exec(d);
	if (uk) return uk[1];
	const patterns = [
		/^([A-Z0-9]{1,6})$/, // J · 00
		/^["'“]?([A-Z0-9%]{1,6})["'”]?\s*입력$/, // "1" 입력 · 03 입력
		/^[^()]*\((?:[가-힣A-Za-z]+\s)?([A-Z]{1,2})\)$/, // 시장구분코드 (주식 J) · (W)
		/^([A-Z]{1,2})\s*\([^()]*\)$/, // W(Unique key) · J(시장 구분 코드)
	];
	for (const re of patterns) {
		const m = re.exec(d);
		if (m) return m[1];
	}
	return undefined;
}

/** 안내가 비어 있는 시장구분 코드 — API 종류로 정한다 (주식 J · 업종 U · ELW W) */
function marketDivDefault(api: CatalogApi): string | undefined {
	if (!api.category.startsWith("[국내주식]")) return undefined;
	if (/ELW/.test(api.category + api.name)) return "W";
	if (/업종|지수/.test(api.name)) return "U";
	return "J";
}

/**
 * 반드시 그 값이어야 하는 파라미터 — 모델이 다른 값을 줘도 규격 값으로 보낸다.
 * 실측: 모델이 '"1" 입력' 에 0, '공란 입력' 에 0 을 넣었다 (그날은 우연히 결과가 맞았다).
 * "(주식 J)" 같은 기본값 성격은 강제하지 않는다 — NX(넥스트레이드) 처럼 다른 값이 맞을 수 있다.
 */
export function strictValue(desc: string): string | undefined {
	const d = desc.trim();
	if (/^["'“]?공란["'”]?\s*(입력)?$/.test(d)) return "";
	const uk = /^Unique\s*key\s*\(\s*([0-9A-Z]{3,6})\s*\)$/i.exec(d);
	if (uk) return uk[1];
	const put = /^["'“]?([A-Z0-9%]{1,6})["'”]?\s*입력$/.exec(d);
	if (put) return put[1];
	return undefined;
}

export function defaultFor(api: CatalogApi, code: string, spec: ParamSpec): string | undefined {
	return fixedValue(spec[2]) ?? (code === "FID_COND_MRKT_DIV_CODE" && !spec[2].trim() ? marketDivDefault(api) : undefined);
}

/**
 * 모델이 준 파라미터를 규격 코드로 맞추고, 서버가 채울 것을 채운다.
 * 키는 코드(대소문자 무관) 또는 한글명으로 받는다.
 */
export function buildKisQuery(
	api: CatalogApi,
	input: Record<string, unknown>,
	account: { CANO: string; ACNT_PRDT_CD: string } | null,
	now: number = Date.now(),
): { query: Record<string, string>; errors: string[] } {
	const errors: string[] = [];
	const codes = Object.keys(api.params);
	const byUpper = new Map(codes.map((c) => [c.toUpperCase(), c]));
	const byLabel = new Map(codes.map((c) => [api.params[c]![0].replace(/\s+/g, ""), c]));

	const given: Record<string, string> = {};
	for (const [k, v] of Object.entries(input)) {
		const code = byUpper.get(k.toUpperCase()) ?? byLabel.get(k.replace(/\s+/g, ""));
		if (!code) {
			errors.push(`모르는 파라미터 "${k}" — 이 API 의 파라미터: ${codes.filter((c) => !isAccountParam(c) && !isContinuationParam(c)).join(", ")}`);
			continue;
		}
		if (isAccountParam(code) || isContinuationParam(code)) continue; // 서버가 채운다
		given[code] = resolveDateToken(v === null || v === undefined ? "" : String(v), now);
	}

	const query: Record<string, string> = {};
	for (const code of codes) {
		const spec = api.params[code]!;
		if (isAccountParam(code)) {
			if (!account) {
				errors.push("이 API 는 계좌번호가 필요합니다 — 설정 화면에서 '한국투자 계좌번호'를 입력하세요.");
				continue;
			}
			query[code] = code.toUpperCase() === "CANO" ? account.CANO : account.ACNT_PRDT_CD;
			continue;
		}
		if (isContinuationParam(code)) {
			query[code] = "";
			continue;
		}
		const strict = strictValue(spec[2]);
		const v = strict !== undefined ? strict : given[code];
		const fallback = defaultFor(api, code, spec);
		if (v !== undefined) {
			query[code] = v;
		} else if (fallback !== undefined) {
			query[code] = fallback;
		} else if (spec[1] && !blankAllowed(spec)) {
			errors.push(`필수 파라미터 없음: ${code} (${spec[0]}) — ${spec[2] || "안내 없음"}`);
		} else {
			// KIS 는 선택 파라미터도 키가 있어야 하는 경우가 많다 — 빈 값으로 보낸다
			query[code] = "";
		}
	}
	return { query, errors };
}

// ── 호출 ────────────────────────────────────────────────────

export interface KisCallResult {
	key: string;
	api: CatalogApi;
	trId: string;
	pages: KisResponse[];
	/** 뒤에 데이터가 더 있는데 페이지 한도에서 멈췄는가 */
	truncated: boolean;
}

export const MAX_PAGES = 5;

export async function callKisApi(
	ctx: KisContext,
	ref: string,
	input: Record<string, unknown>,
	opts: { trId?: string; pages?: number; now?: number } = {},
): Promise<KisCallResult> {
	const found = resolveKisApi(ref);
	if (!found) throw new KisGatewayError(`없는 API: "${ref}" — kis_find 로 먼저 찾으세요.`);
	const { key, api } = found;
	if (isWriteApi(api)) {
		throw new KisGatewayError(
			`"${api.name}" 은(는) 주문·정정 같은 쓰기 API 라 범용 조회로 실행하지 않습니다. ` +
				"주문은 order_prepare 로 준비하고 사용자가 화면에서 확인해야 나갑니다.",
		);
	}

	let trId = api.trIds[0] ?? "";
	if (api.trIds.length > 1) {
		const want = opts.trId?.toUpperCase();
		const hit = api.trIds.find((t) => t.toUpperCase() === want);
		if (!hit) {
			throw new KisGatewayError(`"${api.name}" 은(는) TR ID 가 여러 개입니다 — tr_id 로 고르세요: ${api.trIds.join(", ")} (설명: ${api.desc.slice(0, 200)})`);
		}
		trId = hit;
	}

	let account: { CANO: string; ACNT_PRDT_CD: string } | null = null;
	if (Object.keys(api.params).some(isAccountParam)) {
		try {
			account = accountParams(ctx.creds);
		} catch {
			account = null;
		}
	}
	const { query, errors } = buildKisQuery(api, input, account, opts.now);
	if (errors.length > 0) throw new KisGatewayError(`${api.name} — 파라미터를 고쳐 다시 호출하세요:\n- ${errors.join("\n- ")}`);

	const maxPages = Math.min(Math.max(1, Math.floor(opts.pages ?? 1)), MAX_PAGES);
	const pages: KisResponse[] = [];
	let q = query;
	let trCont = "";
	let truncated = false;
	for (let i = 0; i < maxPages; i++) {
		const page = await kisGetPage(ctx, { path: api.path, trId, query: q, label: api.name, ...(trCont ? { trCont } : {}) });
		pages.push(page.json);
		const more = page.trCont === "F" || page.trCont === "M";
		if (!more) break;
		if (i === maxPages - 1) {
			truncated = true;
			break;
		}
		// 다음 페이지 — 응답의 연속조회 키(소문자)를 요청 파라미터(대문자)로 옮긴다
		q = { ...q };
		for (const code of Object.keys(q)) {
			if (!isContinuationParam(code)) continue;
			const next = page.json[code.toLowerCase()] ?? page.json[code];
			if (typeof next === "string") q[code] = next.trim();
		}
		trCont = "N";
	}
	return { key, api, trId, pages, truncated };
}

// ── 출력 ────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface Section {
	name: string;
	rows: Row[];
	/** 객체(한 건)인가 목록인가 */
	single: boolean;
}

/** output / output1 / output2 … 를 페이지별로 합친다 (목록은 이어 붙이고, 한 건짜리는 첫 페이지 것) */
export function mergeSections(pages: KisResponse[]): Section[] {
	const order: string[] = [];
	const map = new Map<string, Section>();
	for (const p of pages) {
		for (const [k, v] of Object.entries(p)) {
			if (!/^output\d*$/.test(k) || v === null || v === undefined) continue;
			let sec = map.get(k);
			if (Array.isArray(v)) {
				if (!sec) {
					sec = { name: k, rows: [], single: false };
					map.set(k, sec);
					order.push(k);
				}
				sec.rows.push(...(v as Row[]));
			} else if (typeof v === "object" && !sec) {
				map.set(k, { name: k, rows: [v as Row], single: true });
				order.push(k);
			}
		}
	}
	return order.map((k) => map.get(k)!);
}

const isEmpty = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

function labelOf(api: CatalogApi, code: string): string {
	const f = fieldLabel(api, code);
	if (!f) return code;
	// 단위 안내가 있으면 붙인다 — "누적 거래 대금" 이 원인지 백만원인지 모델이 추측하지 않게
	const unit = f[1] && /단위/.test(f[1]) ? ` [${f[1].replace(/^.*?단위\s*:?\s*/, "").slice(0, 30)}]` : "";
	return `${f[0]}${unit}`;
}

function matchesFilter(api: CatalogApi, code: string, filter: string[] | undefined): boolean {
	if (!filter || filter.length === 0) return true;
	const label = fieldLabel(api, code)?.[0] ?? "";
	const norm = (x: string): string => x.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "").toLowerCase();
	const l = norm(label);
	return filter.some((f) => {
		// 모델은 표 머리에 보이는 이름("외국인 순매수 수량 [주]")을 그대로 넘긴다 — 단위 표시를 떼고 비교한다
		const t = norm(f);
		return t !== "" && (code.toLowerCase() === t || (l !== "" && (l.includes(t) || t.includes(l))));
	});
}

export const DEFAULT_ROWS = 30;
export const MAX_ROWS = 100;

/**
 * 응답을 모델이 읽을 표로. 비어 있는 열은 뺀다 (토큰 절약 — 규격 필드의 절반 이상이 빈 경우가 흔하다).
 * 목록은 탭 구분 표, 한 건은 "한글명: 값" 줄.
 */
export function renderKisResult(
	result: KisCallResult,
	opts: { limit?: number; fields?: string[] } = {},
): { text: string; rowCount: number; empty: boolean } {
	const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_ROWS)), MAX_ROWS);
	const sections = mergeSections(result.pages);
	const lines: string[] = [];
	let rowCount = 0;
	for (const sec of sections) {
		const codes = [...new Set(sec.rows.flatMap((r) => Object.keys(r)))].filter(
			(c) => matchesFilter(result.api, c, opts.fields) && sec.rows.some((r) => !isEmpty(r[c])),
		);
		if (codes.length === 0 || sec.rows.length === 0) continue;
		if (sec.single) {
			lines.push(`[${sec.name}]`);
			const r = sec.rows[0]!;
			for (const c of codes) if (!isEmpty(r[c])) lines.push(`${labelOf(result.api, c)}: ${String(r[c]).trim()}`);
			rowCount += 1;
		} else {
			lines.push(`[${sec.name}] ${sec.rows.length}행${sec.rows.length > limit ? ` (앞 ${limit}행만)` : ""}`);
			lines.push(codes.map((c) => labelOf(result.api, c)).join("\t"));
			const shown = sec.rows.slice(0, limit);
			for (const r of shown) lines.push(codes.map((c) => (isEmpty(r[c]) ? "" : String(r[c]).trim())).join("\t"));
			// 순매수 열의 합계 — 모델이 여러 행을 직접 더하지 않게 (계산은 코드가, PLAN §31). 가격 합은 의미가 없어 순매수·순매도 열만
			const sums = codes.map((c) => {
				if (!/순매수|순매도/.test(fieldLabel(result.api, c)?.[0] ?? "")) return "";
				const nums = shown.map((r) => Number(String(r[c] ?? "").trim()));
				return nums.every((n) => Number.isFinite(n)) ? String(nums.reduce((a, b) => a + b, 0)) : "";
			});
			if (sums.some((x) => x !== "")) {
				const label = `합계(표시된 ${shown.length}행)`;
				// 첫 칸(대개 일자)이 비면 그 자리에 라벨 — 열이 밀리지 않게
				if (sums[0] === "") lines.push([label, ...sums.slice(1)].join("\t"));
				else lines.push(`${label}:\n${sums.join("\t")}`);
			}
			rowCount += sec.rows.length;
		}
		lines.push("");
	}
	if (result.truncated) lines.push(`※ 데이터가 더 있습니다 (${result.pages.length}페이지에서 멈춤, 최대 ${MAX_PAGES}).`);
	const empty = rowCount === 0;
	if (empty) lines.push("(응답에 데이터가 없습니다 — 장 시간·조회일·파라미터 조건을 확인하세요)");
	return { text: lines.join("\n").trim(), rowCount, empty };
}

/** kis_find 상세 — 파라미터(서버가 채우는 것 제외)와 응답 필드 */
export function describeKisApi(key: string, api: CatalogApi): string {
	const params = Object.entries(api.params)
		.filter(([c]) => !isAccountParam(c) && !isContinuationParam(c))
		.map(([c, p]) => {
			const d = defaultFor(api, c, p);
			const need = d !== undefined ? ` 기본값 ${d || '""'}(생략 가능)` : p[1] ? (blankAllowed(p) ? " 필수·공란 가능" : " 필수") : "";
			return `  ${c} (${p[0]})${need}: ${p[2] || "-"}`;
		});
	const auto = Object.keys(api.params).filter((c) => isAccountParam(c) || isContinuationParam(c));
	const fields = Object.entries(api.fields).map(([c, f]) => `${f[0]}(${c})`);
	return [
		`${api.name} — ${api.category} · ${isWriteApi(api) ? "쓰기(범용 조회로 실행 불가)" : "조회"} · TR ${api.trIds.join("/")}`,
		`key: ${key}`,
		api.desc ? `설명: ${api.desc.slice(0, 400)}` : "",
		"파라미터:",
		...(params.length > 0 ? params : ["  (없음)"]),
		auto.length > 0 ? `  (서버가 채움: ${auto.join(", ")})` : "",
		`응답 필드 ${fields.length}개: ${fields.slice(0, 50).join(", ")}${fields.length > 50 ? " …" : ""}`,
	]
		.filter(Boolean)
		.join("\n");
}
