#!/usr/bin/env node
/**
 * KIS 실시간(웹소켓) 카탈로그 생성 — REST 카탈로그(build-kis-catalog.mjs)와 같은 포털 규격에서 WEBSOCKET 만 추린다 (PLAN §37).
 *
 * 실행: node packages/broker/scripts/build-kis-ws-catalog.mjs <apis.json 경로>
 * 결과: packages/broker/src/kis/ws-catalog.json (커밋한다)
 *
 * 필드는 **순서가 곧 규격**이다 — 실시간 프레임은 "값^값^…" 이라 이름이 없고 위치로만 읽는다.
 * 체결통보(내 주문 체결)는 뺀다: HTS ID 로 구독하고 AES 복호화가 필요한 계좌 알림이라 시세 툴의 몫이 아니다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = process.argv[2];
if (!src) {
	console.error("사용법: node build-kis-ws-catalog.mjs <apis.json>");
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

const NOTIFY = /체결통보|주문내역통보|체결내역통보/;

const apis = {};
let skipped = 0;
for (const [key, v] of Object.entries(raw.apis)) {
	if (v.kind === "REST" || v.category === "OAuth인증") continue;
	const name = clean(v.name);
	if (NOTIFY.test(name)) {
		skipped++;
		continue;
	}
	const trId = /\/tryitout\/([A-Z0-9_]+)/.exec(v.api_path ?? "")?.[1];
	if (!trId) throw new Error(`TR ID 없음: ${key}`);
	const fields = Object.entries(v.response ?? {}).map(([code, f]) => {
		const desc = clean(f.desc).replace(/^'각 항목사이에는[\s\S]*$/, "");
		return desc ? [code, clean(f.name_kr), desc.slice(0, 100)] : [code, clean(f.name_kr)];
	});
	if (fields.length === 0) throw new Error(`필드 없음: ${key}`);
	apis[key] = {
		name,
		category: clean(v.category).replace(/\]\s*/, "] "),
		trId,
		keyDesc: clean(v.body?.tr_key?.desc).slice(0, 400),
		fields,
	};
}

const out = { source: raw.source, generated: raw.generated, count: Object.keys(apis).length, apis };
const dest = join(dirname(fileURLToPath(import.meta.url)), "../src/kis/ws-catalog.json");
writeFileSync(dest, JSON.stringify(out));
console.log(`${dest}\n  실시간 ${out.count}개 (체결통보 ${skipped}개 제외) · ${(JSON.stringify(out).length / 1024).toFixed(0)}KB`);
