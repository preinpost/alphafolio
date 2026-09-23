#!/usr/bin/env node
/**
 * 토스증권 API 카탈로그 생성 — 공개 OpenAPI 규격에서 범용 조회 툴(toss_query)에 필요한 것만 추린다 (PLAN §32).
 *
 * 원본: https://openapi.tossinvest.com/openapi-docs/latest/openapi.json
 * 실행: node packages/broker/scripts/build-toss-catalog.mjs [openapi.json 경로 또는 URL]
 * 결과: packages/broker/src/toss/catalog.json (커밋한다)
 *
 * 남기는 것: operationId·메서드·경로·요약·설명·레이트 리밋 그룹·파라미터(위치·필수·설명·선택지·날짜 형식)·
 *           응답 필드 설명(result 기준 경로)·그룹(tag) 설명(지수 심볼 카탈로그 같은 표가 여기 있다)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = "https://openapi.tossinvest.com/openapi-docs/latest/openapi.json";
const src = process.argv[2] ?? DEFAULT_URL;
const spec = /^https?:/.test(src) ? await (await fetch(src)).json() : JSON.parse(readFileSync(src, "utf8"));

const deref = (x) => {
	let cur = x;
	for (let i = 0; i < 20 && cur && typeof cur === "object" && "$ref" in cur; i++) {
		let y = spec;
		for (const p of cur.$ref.replace(/^#\//, "").split("/")) y = y[p];
		cur = y;
	}
	return cur;
};

/** allOf 를 합쳐 properties 하나로 */
const merge = (s) => {
	s = deref(s);
	if (!s || typeof s !== "object") return {};
	if (Array.isArray(s.allOf)) {
		const out = { type: "object", properties: {}, description: s.description };
		for (const part of s.allOf) {
			const m = merge(part);
			Object.assign(out.properties, m.properties ?? {});
			if (!out.description && m.description) out.description = m.description;
			if (m.items) out.items = m.items;
			if (m.type && m.type !== "object") out.type = m.type;
		}
		return out;
	}
	return s;
};

const clean = (t) =>
	String(t ?? "")
		.replace(/\r/g, "")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

/** 응답 필드 설명 — result 를 뿌리로 한 경로 (배열은 []) */
function walkFields(schema, prefix, out, depth) {
	const s = merge(schema);
	if (depth > 6 || !s) return;
	const items = s.items ? merge(s.items) : null;
	if (s.type === "array" || items) {
		walkFields(s.items ?? {}, `${prefix}[]`, out, depth + 1);
		return;
	}
	for (const [k, v] of Object.entries(s.properties ?? {})) {
		const vv = merge(v);
		const path = prefix ? `${prefix}.${k}`.replace(/\.\[\]/g, "[]") : k;
		const desc = clean(deref(v)?.description ?? vv.description);
		const enumv = vv.enum ? ` (${vv.enum.slice(0, 12).join("/")})` : "";
		if (desc || enumv) out[path] = (desc.slice(0, 160) + enumv).trim();
		if (vv.properties || vv.items || vv.allOf || vv.type === "array" || vv.type === "object") walkFields(vv, path, out, depth + 1);
	}
}

const apis = {};
for (const [path, ops] of Object.entries(spec.paths)) {
	const common = (ops.parameters ?? []).map(deref);
	for (const [method, op] of Object.entries(ops)) {
		if (!["get", "post", "put", "delete", "patch"].includes(method)) continue;
		if (path.startsWith("/oauth2")) continue;
		const desc = clean(op.description);
		const group = /Rate Limits Group\*\*:\s*`([A-Z_]+)`/.exec(desc)?.[1] ?? "";
		const params = {};
		for (const p0 of [...(op.parameters ?? []).map(deref), ...common]) {
			const p = deref(p0);
			if (!p?.name) continue;
			const schema = merge(p.schema ?? {});
			const entry = { in: p.in, required: p.required ? 1 : 0, desc: clean(p.description).slice(0, 400) };
			if (schema.enum) entry.enum = schema.enum;
			if (schema.format === "date" || /YYYY-MM-DD/.test(p.description ?? "")) entry.format = "date";
			if (schema.format === "date-time") entry.format = "date-time";
			if (schema.type) entry.type = schema.type;
			params[p.name] = entry;
		}
		const fields = {};
		const ok = op.responses?.["200"] ?? op.responses?.["201"];
		const body = ok ? deref(ok)?.content?.["application/json"]?.schema : null;
		if (body) {
			const root = merge(body);
			const result = root.properties?.result;
			if (result) walkFields(result, "", fields, 0);
		}
		const id = op.operationId ?? `${method}${path}`;
		apis[id] = {
			method: method.toUpperCase(),
			path,
			tag: op.tags?.[0]?.trim() ?? "",
			summary: clean(op.summary),
			desc: desc.replace(/\*\*Rate Limits Group\*\*:\s*`[A-Z_]+`/, "").trim().slice(0, 900),
			group,
			params,
			...(op.requestBody ? { body: true } : {}),
			fields,
		};
	}
}

const tags = {};
for (const t of spec.tags ?? []) tags[t.name.trim()] = clean(t.description).slice(0, 2500);

const out = { source: DEFAULT_URL, version: spec.info?.version ?? "", count: Object.keys(apis).length, tags, apis };
const dest = join(dirname(fileURLToPath(import.meta.url)), "../src/toss/catalog.json");
writeFileSync(dest, JSON.stringify(out));
const reads = Object.values(apis).filter((a) => a.method === "GET").length;
console.log(`${dest}\n  v${out.version} · ${out.count}개 (조회 ${reads} · 쓰기 ${out.count - reads}) · ${(JSON.stringify(out).length / 1024).toFixed(0)}KB`);
