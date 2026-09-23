/**
 * 토스증권 범용 조회 — 공개 OpenAPI 규격(catalog.json)의 **조회(GET) API 전부**를 호출한다 (PLAN §32).
 *
 * KIS 범용 조회(kis/gateway.ts)와 같은 원칙:
 *   - 쓰기(주문·정정·취소·조건주문)는 실행하지 않는다 — 확인 카드 경로로만
 *   - 계좌(X-Tossinvest-Account)는 서버가 넣는다. 계좌번호가 응답에 오면 끝 4자리만 보여준다
 *   - 날짜는 "today" / "today-30" → YYYY-MM-DD (토스 형식)
 *   - 모르는 파라미터·선택지 밖의 값은 거절한다
 * 다른 점: 응답이 중첩 JSON 이라 한글 이름으로 머리를 바꾸면 겹친다(외국인·기관 모두 "순매수 거래량").
 * 그래서 표 머리는 경로(foreigner.netBuyVolume) 그대로 두고, 아래에 한글 설명 범례를 붙인다.
 */
import { readFileSync } from "node:fs";
import { tossGet, type TossContext } from "./client.ts";
import { defaultAccountSeq } from "./api.ts";

interface TossParam {
	in: string;
	required: number;
	desc: string;
	enum?: string[];
	format?: string;
	type?: string;
}

export interface TossApi {
	method: string;
	path: string;
	tag: string;
	summary: string;
	desc: string;
	group: string;
	params: Record<string, TossParam>;
	body?: boolean;
	fields: Record<string, string>;
}

interface TossCatalog {
	source: string;
	version: string;
	count: number;
	tags: Record<string, string>;
	apis: Record<string, TossApi>;
}

export class TossGatewayError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TossGatewayError";
	}
}

let cached: TossCatalog | null = null;
export function tossCatalog(): TossCatalog {
	if (!cached) cached = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8")) as TossCatalog;
	return cached;
}

export const isTossWrite = (api: TossApi): boolean => api.method !== "GET";
const ACCOUNT_HEADER = "X-Tossinvest-Account";

export function resolveTossApi(ref: string): { id: string; api: TossApi } | null {
	const apis = tossCatalog().apis;
	const r = ref.trim();
	if (apis[r]) return { id: r, api: apis[r] };
	const hit = Object.entries(apis).find(([id]) => id.toLowerCase() === r.toLowerCase());
	return hit ? { id: hit[0], api: hit[1] } : null;
}

/** 조회 API 목록 한 줄씩 — 툴 설명에 싣는다 (29개라 검색 단계 없이 바로 고른다) */
export function tossReadIndex(): string {
	return Object.entries(tossCatalog().apis)
		.filter(([, a]) => !isTossWrite(a))
		.map(([id, a]) => {
			const ps = Object.entries(a.params)
				.filter(([n]) => n !== ACCOUNT_HEADER)
				.map(([n, p]) => `${n}${p.required ? "*" : ""}`);
			return `${id}(${ps.join(", ")}) ${a.summary}`;
		})
		.join("\n");
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "today" / "today-30" → YYYY-MM-DD (한국 시간). 토큰이 아니면 그대로 */
export function tossDateToken(value: string, now: number = Date.now()): string {
	const m = /^today(?:([+-])(\d{1,4}))?$/i.exec(value.trim());
	if (!m) return value;
	const offset = m[2] ? Number(m[2]) * (m[1] === "-" ? -1 : 1) : 0;
	const d = new Date(now + 9 * 3_600_000 + offset * 86_400_000);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export interface TossRequest {
	path: string;
	query: Record<string, string>;
	needsAccount: boolean;
}

/** 모델이 준 파라미터를 규격에 맞춘다. 계좌 헤더는 모델 값을 무시한다 (서버가 넣는다). */
export function buildTossRequest(api: TossApi, input: Record<string, unknown>, now: number = Date.now()): { req: TossRequest; errors: string[] } {
	const errors: string[] = [];
	const names = Object.keys(api.params);
	const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
	const given: Record<string, string> = {};
	for (const [k, v] of Object.entries(input)) {
		const name = byLower.get(k.toLowerCase());
		if (!name) {
			errors.push(`모르는 파라미터 "${k}" — 이 API 의 파라미터: ${names.filter((n) => n !== ACCOUNT_HEADER).join(", ") || "(없음)"}`);
			continue;
		}
		if (name === ACCOUNT_HEADER) continue;
		const raw = v === null || v === undefined ? "" : typeof v === "boolean" ? String(v) : String(v);
		given[name] = api.params[name]!.format === "date" ? tossDateToken(raw, now) : raw;
	}

	let path = api.path;
	const query: Record<string, string> = {};
	for (const [name, p] of Object.entries(api.params)) {
		if (name === ACCOUNT_HEADER) continue;
		const v = given[name];
		if (v === undefined || v === "") {
			if (p.required) errors.push(`필수 파라미터 없음: ${name} — ${p.desc.split("\n")[0]}${p.enum ? ` (선택지: ${p.enum.join(", ")})` : ""}`);
			continue;
		}
		if (p.enum && !p.enum.includes(v)) {
			errors.push(`${name}="${v}" 는 선택지 밖입니다 — ${p.enum.join(", ")}`);
			continue;
		}
		if (p.in === "path") path = path.replace(`{${name}}`, encodeURIComponent(v));
		else if (p.in === "query") query[name] = v;
	}
	return { req: { path, query, needsAccount: ACCOUNT_HEADER in api.params }, errors };
}

export async function callTossApi(
	ctx: TossContext,
	ref: string,
	input: Record<string, unknown>,
	now: number = Date.now(),
): Promise<{ id: string; api: TossApi; data: unknown }> {
	const found = resolveTossApi(ref);
	if (!found) throw new TossGatewayError(`없는 토스 API: "${ref}" — toss_query 설명의 목록에서 고르세요.`);
	const { id, api } = found;
	if (isTossWrite(api)) {
		throw new TossGatewayError(
			`"${api.summary}" 은(는) 주문·정정·취소 같은 쓰기 API 라 범용 조회로 실행하지 않습니다. ` +
				"주문은 order_prepare 로 준비하고 사용자가 화면에서 확인해야 나갑니다.",
		);
	}
	const { req, errors } = buildTossRequest(api, input, now);
	if (errors.length > 0) throw new TossGatewayError(`${api.summary} — 파라미터를 고쳐 다시 호출하세요:\n- ${errors.join("\n- ")}`);
	const accountSeq = req.needsAccount ? await defaultAccountSeq(ctx) : undefined;
	const data = await tossGet<unknown>(ctx, req.path, {
		query: req.query,
		group: api.group || "MARKET_DATA",
		...(accountSeq !== undefined ? { accountSeq } : {}),
	});
	return { id, api, data };
}

// ── 출력 ────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const isEmpty = (v: unknown): boolean => v === null || v === undefined || v === "";

/** 계좌번호는 끝 4자리만 — 모델에게 계좌번호를 넘기지 않는다 */
function mask(key: string, v: unknown): unknown {
	if (/accountNo|accountNumber/i.test(key) && typeof v === "string" && v.length > 4) return `****${v.slice(-4)}`;
	return v;
}

/** 중첩 객체를 a.b.c 로 편다. 객체 배열이 섞이면 따로 모은다 (표로 그린다) */
function flatten(o: Obj, prefix: string, out: Obj, tables: Array<{ path: string; rows: Obj[] }>, depth = 0): void {
	for (const [k, v] of Object.entries(o)) {
		const path = prefix ? `${prefix}.${k}` : k;
		if (Array.isArray(v)) {
			if (v.length > 0 && v.every(isObj) && depth === 0) tables.push({ path, rows: v as Obj[] });
			else out[path] = v.length === 0 ? "" : JSON.stringify(v).slice(0, 300);
		} else if (isObj(v) && depth < 3) {
			flatten(v, path, out, tables, depth + 1);
		} else {
			out[path] = mask(k, v);
		}
	}
}

/** 필드 설명 첫 줄 — 범례용 */
function shortDesc(d: string): string {
	return d.split("\n")[0]!.replace(/`/g, "").slice(0, 70);
}

export const TOSS_DEFAULT_ROWS = 30;
export const TOSS_MAX_ROWS = 100;

export function renderTossResult(
	api: TossApi,
	data: unknown,
	opts: { limit?: number; fields?: string[] } = {},
): { text: string; rowCount: number; empty: boolean } {
	const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? TOSS_DEFAULT_ROWS)), TOSS_MAX_ROWS);
	const wants = (path: string): boolean => {
		if (!opts.fields || opts.fields.length === 0) return true;
		const desc = (api.fields[path] ?? "").replace(/\s+/g, "");
		return opts.fields.some((f) => {
			const t = f.replace(/\s+/g, "").toLowerCase();
			return t !== "" && (path.toLowerCase().includes(t) || desc.toLowerCase().includes(t));
		});
	};

	const scalars: Obj = {};
	const tables: Array<{ path: string; rows: Obj[] }> = [];
	if (Array.isArray(data)) {
		if (data.every(isObj)) tables.push({ path: "", rows: data as Obj[] });
		else scalars.result = JSON.stringify(data).slice(0, 1000);
	} else if (isObj(data)) {
		flatten(data, "", scalars, tables);
	} else if (!isEmpty(data)) {
		scalars.result = data;
	}

	const lines: string[] = [];
	const legend = new Map<string, string>();
	const note = (specPath: string, shown: string): void => {
		const d = api.fields[specPath];
		if (d && !legend.has(shown)) legend.set(shown, shortDesc(d));
	};

	for (const [k, v] of Object.entries(scalars)) {
		if (isEmpty(v) || !wants(k)) continue;
		lines.push(`${k}: ${String(v)}`);
		note(k, k);
	}

	let rowCount = Object.keys(scalars).length > 0 ? 1 : 0;
	for (const t of tables) {
		const flatRows = t.rows.map((r) => {
			const out: Obj = {};
			flatten(r, "", out, [], 1);
			return out;
		});
		const specPrefix = t.path ? `${t.path}[]` : "[]";
		const cols = [...new Set(flatRows.flatMap((r) => Object.keys(r)))].filter(
			(c) => flatRows.some((r) => !isEmpty(r[c])) && wants(`${specPrefix}.${c}`.replace(/^\[\]\./, "[].")),
		);
		if (cols.length === 0) continue;
		rowCount += flatRows.length;
		lines.push("", `[${t.path || "목록"}] ${flatRows.length}행${flatRows.length > limit ? ` (앞 ${limit}행만)` : ""}`);
		lines.push(cols.join("\t"));
		for (const r of flatRows.slice(0, limit)) lines.push(cols.map((c) => (isEmpty(r[c]) ? "" : String(r[c]))).join("\t"));
		for (const c of cols) note(t.path ? `${t.path}[].${c}` : `[].${c}`, c);
	}

	const empty = lines.length === 0;
	if (empty) lines.push("(응답에 데이터가 없습니다)");
	if (legend.size > 0) {
		lines.push("", "필드 설명:");
		for (const [k, d] of legend) lines.push(`- ${k}: ${d}`);
	}
	return { text: lines.join("\n").trim(), rowCount, empty };
}

/** 상세 — 파라미터 설명 전부 + 그룹 설명(지수 심볼 카탈로그 같은 표) */
export function describeTossApi(id: string, api: TossApi): string {
	const params = Object.entries(api.params)
		.filter(([n]) => n !== ACCOUNT_HEADER)
		.map(([n, p]) => `  ${n}${p.required ? " (필수)" : ""}${p.format === "date" ? " [YYYY-MM-DD, today-N 가능]" : ""}: ${p.desc.replace(/\n/g, " ")}${p.enum ? ` — 선택지: ${p.enum.join(", ")}` : ""}`);
	const tag = tossCatalog().tags[api.tag];
	return [
		`${id} — ${api.summary} [${api.tag}]${isTossWrite(api) ? " · 쓰기(범용 조회로 실행 불가)" : ""}`,
		api.desc ? `설명: ${api.desc.slice(0, 700)}` : "",
		"파라미터:",
		...(params.length > 0 ? params : ["  (없음)"]),
		ACCOUNT_HEADER in api.params ? "  (계좌는 서버가 채움)" : "",
		tag && /카탈로그|\|/.test(tag) ? `\n그룹 안내:\n${tag.slice(0, 1500)}` : "",
	]
		.filter(Boolean)
		.join("\n");
}
