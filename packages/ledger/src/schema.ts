/**
 * D1 스키마 + 마이그레이션.
 *
 * 마이그레이션은 파일 목록이 아니라 배열로 관리한다 (D1은 wrangler 없이도
 * REST로 실행 가능하므로 별도 도구가 필요 없다). 적용 이력은 _migrations 테이블에 남긴다.
 */
import { d1Exec, d1Query, type D1Config } from "./d1.ts";

export interface Migration {
	id: string;
	sql: string;
}

export const MIGRATIONS: Migration[] = [
	{
		id: "0001_init",
		sql: `
CREATE TABLE IF NOT EXISTS transactions (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'KRW',
  category    TEXT,
  merchant    TEXT,
  memo        TEXT,
  account     TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',
  dedupe_key  TEXT UNIQUE,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category, date);

CREATE TABLE IF NOT EXISTS budgets (
  month     TEXT NOT NULL,
  category  TEXT NOT NULL,
  limit_amt INTEGER NOT NULL,
  PRIMARY KEY (month, category)
);
`.trim(),
	},
	{
		id: "0002_member",
		sql: `
ALTER TABLE transactions ADD COLUMN member TEXT;
CREATE INDEX IF NOT EXISTS idx_tx_member ON transactions(member, date);
`.trim(),
	},
	{
		id: "0003_user_secrets",
		sql: `
CREATE TABLE IF NOT EXISTS user_secrets (
  member     TEXT NOT NULL,
  name       TEXT NOT NULL,
  value_enc  TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (member, name)
);
`.trim(),
	},
	{
		id: "0004_broker_tokens",
		sql: `
CREATE TABLE IF NOT EXISTS broker_tokens (
  cache_key  TEXT PRIMARY KEY,
  token_enc  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`.trim(),
	},
];

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS _migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`.trim();

export interface MigrateResult {
	applied: string[];
	skipped: string[];
}

/** 미적용 마이그레이션만 순서대로 실행한다. 여러 번 호출해도 안전(idempotent). */
export async function migrate(cfg: D1Config): Promise<MigrateResult> {
	await d1Exec(cfg, MIGRATION_TABLE);

	const done = await d1Query<{ id: string }>(cfg, "SELECT id FROM _migrations");
	const applied = new Set(done.results.map((r) => r.id));

	const result: MigrateResult = { applied: [], skipped: [] };
	for (const m of MIGRATIONS) {
		if (applied.has(m.id)) {
			result.skipped.push(m.id);
			continue;
		}
		await d1Exec(cfg, m.sql);
		await d1Query(cfg, "INSERT INTO _migrations (id, applied_at) VALUES (?, ?)", [m.id, new Date().toISOString()]);
		result.applied.push(m.id);
	}
	return result;
}

/**
 * 설정별 마이그레이션 1회 보장.
 *
 * 키를 나중에 입력할 수 있게 되면서 기동 시점에 마이그레이션을 돌릴 수 없다.
 * 첫 사용 시점에 한 번만 실행하고 결과를 캐시한다.
 */
const migrated = new Map<string, Promise<MigrateResult>>();

export function ensureMigrated(cfg: D1Config): Promise<MigrateResult> {
	const key = `${cfg.accountId}:${cfg.databaseId}`;
	let run = migrated.get(key);
	if (!run) {
		run = migrate(cfg).catch((err: unknown) => {
			migrated.delete(key); // 실패는 캐시하지 않는다 — 키를 고치면 다시 시도할 수 있어야 한다
			throw err;
		});
		migrated.set(key, run);
	}
	return run;
}
