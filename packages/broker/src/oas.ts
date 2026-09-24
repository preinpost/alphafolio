/**
 * OpenAPI 규격 기반 범용 조회의 공용 부분 — 토스(toss/gateway.ts)와 데이터 제공자 4곳(data/gateway.ts)이 같이 쓴다 (PLAN §32, §35).
 *
 * 카탈로그(규격에서 추린 JSON)의 한 API 를 받아:
 *   - 모델이 준 파라미터를 규격에 맞춘다 — 모르는 이름·선택지 밖 값 거절, 날짜 토큰, 경로 파라미터 인코딩
 *   - 서버가 채우는 파라미터(계좌·키·서명)는 모델 값을 무시하고 필수 검사에서도 뺀다
 *   - 중첩 JSON 응답을 경로(a.b.c)로 펴서 표로 그리고, 규격의 필드 설명을 범례로 붙인다
 */

export interface OasParam {
	in: string;
	required: number;
	desc: string;
	enum?: string[];
	format?: string;
	type?: string;
}

export interface OasApi {
	method: string;
	path: string;
	tag: string;
	summary: string;
	desc: string;
	/** 레이트 리밋 그룹 (토스) */
	group: string;
	params: Record<string, OasParam>;
	body?: boolean;
	/** 결과 기준 경로 → 설명 (배열은 []) */
	fields: Record<string, string>;
	/** 서명이 필요한 API (Binance USER_DATA 등) */
	signed?: boolean;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "today" / "today-30" → YYYY-MM-DD (한국 시간). 토큰이 아니면 그대로 */
export function oasDateToken(value: string, now: number = Date.now()): string {
	const m = /^today(?:([+-])(\d{1,4}))?$/i.exec(value.trim());
	if (!m) return value;
	const offset = m[2] ? Number(m[2]) * (m[1] === "-" ? -1 : 1) : 0;
	const d = new Date(now + 9 * 3_600_000 + offset * 86_400_000);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export interface OasRequest {
	path: string;
	query: Record<string, string>;
}

/**
 * 모델이 준 파라미터를 규격에 맞춘다.
 * serverParams: 서버가 채우는 이름 (계좌 헤더·API 키·서명·timestamp) — 모델 값을 무시하고 필수 검사에서도 뺀다.
 */
export function buildOasRequest(
	api: OasApi,
	input: Record<string, unknown>,
	opts: { serverParams?: ReadonlySet<string>; now?: number } = {},
): { req: OasRequest; errors: string[] } {
	const server = new Set([...(opts.serverParams ?? [])].map((s) => s.toLowerCase()));
	const isServer = (n: string): boolean => server.has(n.toLowerCase());
	const errors: string[] = [];
	const names = Object.keys(api.params);
	const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
	const given: Record<string, string> = {};
	for (const [k, v] of Object.entries(input)) {
		const name = byLower.get(k.toLowerCase());
		if (!name) {
			errors.push(`모르는 파라미터 "${k}" — 이 API 의 파라미터: ${names.filter((n) => !isServer(n)).join(", ") || "(없음)"}`);
			continue;
		}
		if (isServer(name)) continue;
		const raw = v === null || v === undefined ? "" : String(v);
		given[name] = api.params[name]!.format === "date" ? oasDateToken(raw, opts.now) : raw;
	}

	let path = api.path;
	const query: Record<string, string> = {};
	for (const [name, p] of Object.entries(api.params)) {
		if (isServer(name)) continue;
		const v = given[name];
		if (v === undefined || v === "") {
			if (p.required) errors.push(`필수 파라미터 없음: ${name} — ${p.desc.split("\n")[0]}${p.enum ? ` (선택지: ${p.enum.join(", ")})` : ""}`);
			continue;
		}
		if (p.enum && !p.enum.map(String).includes(v)) {
			errors.push(`${name}="${v}" 는 선택지 밖입니다 — ${p.enum.join(", ")}`);
			continue;
		}
		if (p.in === "path") path = path.replace(`{${name}}`, encodeURIComponent(v));
		else if (p.in === "query") query[name] = v;
	}
	return { req: { path, query }, errors };
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

export const OAS_DEFAULT_ROWS = 30;
export const OAS_MAX_ROWS = 100;

export function renderOasResult(
	api: OasApi,
	data: unknown,
	opts: { limit?: number; fields?: string[] } = {},
): { text: string; rowCount: number; empty: boolean } {
	const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? OAS_DEFAULT_ROWS)), OAS_MAX_ROWS);
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
		else scalars.result = JSON.stringify(data).slice(0, 1500);
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

/** 상세 — 파라미터 설명 전부 (서버가 채우는 것 제외) */
export function describeOasParams(api: OasApi, serverParams: ReadonlySet<string> = new Set()): string[] {
	const server = new Set([...serverParams].map((s) => s.toLowerCase()));
	return Object.entries(api.params)
		.filter(([n]) => !server.has(n.toLowerCase()))
		.map(
			([n, p]) =>
				`  ${n}${p.required ? " (필수)" : ""}${p.format === "date" ? " [YYYY-MM-DD, today-N 가능]" : ""}: ${p.desc.replace(/\n/g, " ").slice(0, 300)}${p.enum ? ` — 선택지: ${p.enum.slice(0, 30).join(", ")}` : ""}`,
		);
}
