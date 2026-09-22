/**
 * 스파이크용 .env 로더 — 저장소 루트의 .env 를 읽어 process.env 에 병합한다.
 * 이미 설정된 process.env 값이 우선 (배포 환경의 compose env 를 덮지 않기 위해).
 *
 * Phase 1에서 apps/server 로 옮길 때 containers/web/server/env.ts 의 구현을
 * 가져와 대체한다 (주석·인코딩 처리가 더 꼼꼼함).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnv(): string | null {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	const file = join(root, ".env");
	if (!existsSync(file)) return null;

	for (const raw of readFileSync(file, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = value;
	}
	return file;
}
