#!/usr/bin/env node
/**
 * 데이터 제공자 API 카탈로그 생성 — 공식 OpenAPI/Swagger 규격에서 범용 조회(data_find·data_call)에 필요한 것만 추린다 (PLAN §35).
 *
 * 실행: node packages/broker/scripts/build-oas-catalog.mjs <provider> <규격 JSON 경로 또는 URL>
 *   finnhub    https://finnhub.io/static/swagger.json                       (Swagger 2.0)
 *   twelve     https://api.twelvedata.com/doc/swagger/openapi.json          (OpenAPI 3.1)
 *   coingecko  https://raw.githubusercontent.com/coingecko/coingecko-api-oas/refs/heads/main/demo-api.json
 *   binance    https://raw.githubusercontent.com/binance/binance-api-swagger/master/spot_api.yaml
 *              ↳ YAML 이다 — 먼저 JSON 으로: python3 -c 'import yaml,json,sys;json.dump(yaml.safe_load(open(sys.argv[1])),sys.stdout)' spot_api.yaml > spot.json
 * 결과: packages/broker/src/data/catalogs/<provider>.json (커밋한다)
 *
 * 남기는 것: 메서드·경로·태그·요약·설명(앞부분)·파라미터(위치·필수·설명·선택지·날짜 형식)·응답 필드 설명·인증 종류
 * 인증 종류(auth): none(공개) / key(API 키 헤더만) / signed(키 + HMAC 서명 — Binance USER_DATA)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [provider, src] = process.argv.slice(2);
if (!provider || !src) {
	console.error("사용법: node build-oas-catalog.mjs <finnhub|twelve|coingecko|binance> <spec.json|URL>");
	process.exit(1);
}
const spec = /^https?:/.test(src) ? await (await fetch(src)).json() : JSON.parse(readFileSync(src, "utf8"));

const deref = (x) => {
	let cur = x;
	for (let i = 0; i < 20 && cur && typeof cur === "object" && "$ref" in cur; i++) {
		let y = spec;
		for (const p of String(cur.$ref).replace(/^#\//, "").split("/")) y = y?.[p];
		cur = y;
	}
	return cur;
};

const merge = (s0) => {
	const s = deref(s0);
	if (!s || typeof s !== "object") return {};
	const parts = s.allOf ?? (s.oneOf?.length === 1 ? s.oneOf : null) ?? (s.anyOf?.length === 1 ? s.anyOf : null);
	if (Array.isArray(parts)) {
		const out = { type: "object", properties: {}, description: s.description };
		for (const part of parts) {
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
		.replace(/<[^>]+>/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

function walkFields(schema, prefix, out, depth) {
	const s = merge(schema);
	if (depth > 5 || !s) return;
	if (s.type === "array" || s.items) {
		walkFields(s.items ?? {}, `${prefix}[]`, out, depth + 1);
		return;
	}
	for (const [k, v] of Object.entries(s.properties ?? {})) {
		const vv = merge(v);
		const path = prefix ? `${prefix}.${k}`.replace(/\.\[\]/g, "[]") : k;
		const desc = clean(deref(v)?.description ?? vv.description);
		const enumv = vv.enum ? ` (${vv.enum.slice(0, 12).join("/")})` : "";
		if (desc || enumv) out[path] = (desc.slice(0, 140) + enumv).trim();
		if (Object.keys(out).length > 120) return; // 거대한 응답 스키마(Twelve 지표 등) — 앞부분만
		if (vv.properties || vv.items || vv.allOf || vv.type === "array") walkFields(vv, path, out, depth + 1);
	}
}

/** Swagger 2.0 과 OpenAPI 3 의 200 응답 스키마 */
function okSchema(op) {
	const r = deref(op.responses?.["200"] ?? op.responses?.["201"]);
	if (!r) return null;
	if (r.schema) return r.schema; // Swagger 2.0
	const content = r.content ?? {};
	const json = content["application/json"] ?? Object.values(content)[0];
	return json?.schema ?? null;
}

/** 인증 파라미터는 서버가 넣는다 — 카탈로그 파라미터에서 뺀다 */
const AUTH_PARAMS = new Set(["token", "apikey", "x_cg_demo_api_key", "x-cg-demo-api-key", "x_cg_pro_api_key"]);

const apis = {};
for (const [path, ops] of Object.entries(spec.paths ?? {})) {
	const common = (ops.parameters ?? []).map(deref);
	for (const [method, op] of Object.entries(ops)) {
		if (!["get", "post", "put", "delete", "patch"].includes(method) || typeof op !== "object") continue;
		const params = {};
		for (const p0 of [...(op.parameters ?? []).map(deref), ...common]) {
			const p = deref(p0);
			if (!p?.name || p.in === "header" || p.in === "cookie") continue;
			if (AUTH_PARAMS.has(p.name.toLowerCase())) continue;
			const schema = merge(p.schema ?? p); // Swagger 2.0 은 type/enum 이 파라미터에 바로 있다
			const desc = clean(p.description ?? schema.description);
			const entry = { in: p.in, required: p.required ? 1 : 0, desc: desc.slice(0, 400) };
			const en = schema.enum ?? schema.items?.enum;
			if (en) entry.enum = en.map(String);
			if (schema.format === "date" || /YYYY-MM-DD/i.test(desc)) entry.format = "date";
			if (schema.type) entry.type = schema.type;
			params[p.name] = entry;
		}
		const security = (op.security ?? spec.security ?? []).flatMap((s) => Object.keys(s));
		const signed = "signature" in params;
		const auth = signed ? "signed" : provider === "binance" ? (security.length > 0 ? "key" : "none") : security.length > 0 || spec.securityDefinitions ? "key" : "none";
		const fields = {};
		const body = okSchema(op);
		if (body) walkFields(body, "", fields, 0);
		const id = (op.operationId ?? `${method}${path}`).replace(/[^A-Za-z0-9_.-]/g, "_");
		if (apis[id]) continue;
		apis[id] = {
			method: method.toUpperCase(),
			path,
			tag: String(op.tags?.[0] ?? "").trim(),
			summary: clean(op.summary ?? "").slice(0, 160),
			desc: clean(op.description ?? "").slice(0, 700),
			group: "",
			params,
			...(op.requestBody ? { body: true } : {}),
			fields,
			...(auth !== "none" ? { auth } : {}),
			...(signed ? { signed: true } : {}),
		};
	}
}

// 중복 제거 — 같은 파라미터 설명(isin·cusip·exchange…)이 Twelve Data 에서 150번 넘게 반복된다.
// 같은 파라미터 명세·필드 설명은 한 번만 두고 번호로 가리킨다. 읽는 쪽(data/gateway.ts)이 펼친다.
const paramDefs = [];
const paramIndex = new Map();
const strings = [];
const stringIndex = new Map();
const intern = (table, index, v) => {
	const key = JSON.stringify(v);
	if (!index.has(key)) {
		index.set(key, table.length);
		table.push(v);
	}
	return index.get(key);
};
for (const a of Object.values(apis)) {
	for (const [n, p] of Object.entries(a.params)) a.params[n] = intern(paramDefs, paramIndex, p);
	for (const [k, d] of Object.entries(a.fields)) a.fields[k] = intern(strings, stringIndex, d);
}

const out = {
	provider,
	source: /^https?:/.test(src) ? src : "",
	version: String(spec.info?.version ?? ""),
	count: Object.keys(apis).length,
	paramDefs,
	strings,
	apis,
};
const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/data/catalogs");
mkdirSync(dir, { recursive: true });
const dest = join(dir, `${provider}.json`);
writeFileSync(dest, JSON.stringify(out));
const reads = Object.values(apis).filter((a) => a.method === "GET").length;
console.log(`${dest}\n  v${out.version} · ${out.count}개 (조회 ${reads} · 쓰기 ${out.count - reads}) · ${(JSON.stringify(out).length / 1024).toFixed(0)}KB`);
