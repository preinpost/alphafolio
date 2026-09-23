/**
 * 루트 package.json 의 version 을 올린다 — Bump & release 워크플로 전용.
 *
 *   node .github/scripts/bump-version.mjs patch|minor|major [package.json 경로]
 *
 * 새 버전(예: 0.2.0)을 stdout 에 한 줄로 찍는다. 버전의 단일 소스는 루트 package.json 이다
 * (이미지 태그·git 태그·Release 가 모두 여기서 나온다).
 */
import { readFileSync, writeFileSync } from "node:fs";

const [kind, path = "package.json"] = process.argv.slice(2);
if (!["patch", "minor", "major"].includes(kind)) {
	console.error(`사용법: bump-version.mjs patch|minor|major — 받은 값: ${kind ?? "(없음)"}`);
	process.exit(2);
}

const raw = readFileSync(path, "utf8");
const pkg = JSON.parse(raw);
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version ?? "");
if (!m) {
	// 프리릴리스(1.0.0-rc.1) 등은 지원하지 않는다 — 조용히 잘못 올리느니 멈춘다
	console.error(`version 이 MAJOR.MINOR.PATCH 형식이 아니다: ${pkg.version}`);
	process.exit(1);
}

let [major, minor, patch] = m.slice(1).map(Number);
if (kind === "major") [major, minor, patch] = [major + 1, 0, 0];
if (kind === "minor") [minor, patch] = [minor + 1, 0];
if (kind === "patch") patch += 1;
const next = `${major}.${minor}.${patch}`;

// version 줄만 바꾼다 — JSON 을 다시 직렬화하면 키 순서·들여쓰기가 흔들려 diff 가 커진다
const updated = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`);
if (updated === raw || JSON.parse(updated).version !== next) {
	console.error("package.json 의 version 을 바꾸지 못했다");
	process.exit(1);
}
writeFileSync(path, updated);
console.log(next);
