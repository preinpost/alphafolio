#!/usr/bin/env node
/**
 * KIS API 카탈로그 생성 — 포털 전체 규격(apis.json, 3.3MB)에서 범용 조회 툴에 필요한 것만 추린다.
 *
 * 원본: apiportal.koreainvestment.com 전체 API 규격 (Excel: API_COLLECTION) → pi-kis 가 JSON 으로 변환한 것.
 * 실행: node packages/broker/scripts/build-kis-catalog.mjs <apis.json 경로>
 * 결과: packages/broker/src/kis/catalog.json (커밋한다 — 런타임에 원본이 필요 없다)
 *
 * 남기는 것: 이름·분류·경로·TR ID·설명(앞부분)·파라미터(한글명·필수·안내)·응답 필드(한글명·단위 안내)
 * 버리는 것: 헤더 규격·응답 헤더·예제·모의투자 TR ID (실전만 쓴다)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = process.argv[2];
if (!src) {
	console.error("사용법: node build-kis-catalog.mjs <apis.json>");
	process.exit(1);
}
const raw = JSON.parse(readFileSync(src, "utf8"));

const clean = (s) =>
	String(s ?? "")
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/\r/g, "")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{2,}/g, "\n")
		.trim();

/** 응답 구조 필드(rt_cd·output 등)는 사전에서 뺀다 — 값이 아니라 봉투다 */
const ENVELOPE = new Set(["rt_cd", "msg_cd", "msg1", "ctx_area_fk100", "ctx_area_nk100", "ctx_area_fk200", "ctx_area_nk200"]);

const apis = {};
for (const [key, v] of Object.entries(raw.apis)) {
	if (v.kind !== "REST") continue; // 웹소켓은 5차
	if (v.category === "OAuth인증") continue;
	const params = {};
	for (const [code, p] of Object.entries({ ...(v.query ?? {}), ...(v.body ?? {}) })) {
		params[code] = [clean(p.name_kr), p.required ? 1 : 0, clean(p.desc).slice(0, 300)];
	}
	const fields = {};
	for (const [code, f] of Object.entries(v.response ?? {})) {
		if (ENVELOPE.has(code)) continue;
		if (/^output\d*$/.test(code)) continue;
		const desc = clean(f.desc);
		fields[code] = desc && desc !== "array" ? [clean(f.name_kr), desc.slice(0, 120)] : [clean(f.name_kr)];
	}
	apis[key] = {
		name: clean(v.name),
		category: clean(v.category),
		method: v.method,
		path: v.api_path,
		trIds: v.tr_id_real ?? [],
		desc: clean(v.description).slice(0, 600),
		params,
		fields,
	};
}

const out = {
	source: raw.source,
	generated: raw.generated,
	count: Object.keys(apis).length,
	apis,
};
const dest = join(dirname(fileURLToPath(import.meta.url)), "../src/kis/catalog.json");
writeFileSync(dest, JSON.stringify(out));
const reads = Object.values(apis).filter((a) => a.method === "GET").length;
console.log(`${dest}\n  REST ${out.count}개 (조회 GET ${reads} · 쓰기 ${out.count - reads}) · ${(JSON.stringify(out).length / 1024).toFixed(0)}KB`);
