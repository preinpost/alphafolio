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
	{
		// 일별 포트폴리오 스냅샷 — 월간·주간 수익률의 기준점.
		// 증권 키가 사용자별이라 member 단위로 쌓는다 (가구 합계는 조회 시 합산).
		// 과거 평가금액은 브로커 API 로 되살릴 수 없어서, 안 쌓으면 영영 없다.
		id: "0005_portfolio_snapshots",
		sql: `
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  member        TEXT NOT NULL,
  date          TEXT NOT NULL,
  total_krw     REAL NOT NULL,
  stock_krw     REAL NOT NULL,
  cash_krw      REAL NOT NULL,
  profit_krw    REAL NOT NULL,
  usd_krw       REAL NOT NULL,
  brokers       TEXT NOT NULL,
  holdings_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (member, date)
);
`.trim(),
	},
	{
		// 가계부 단위 분리 (PLAN §23).
		// 이전에는 D1 하나가 곧 "가구 가계부"였다 — 가입을 열면 새 사용자가 남의 가계부를 전부 본다.
		// 이제 거래·예산은 ledger_id 에 속하고, 조회는 항상 멤버십을 거친다.
		// 기존 행(ledger_id NULL)은 어느 가계부에도 속하지 않아 보이지 않는다 — 옮길 때는 수동으로.
		// budgets 는 PK 에 ledger_id 가 들어가야 해서 새로 만들고, 옛 테이블은 budgets_legacy 로 남긴다.
		id: "0006_ledgers",
		sql: `
CREATE TABLE IF NOT EXISTS ledgers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_members (
  ledger_id TEXT NOT NULL,
  member    TEXT NOT NULL,
  role      TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (ledger_id, member)
);
CREATE INDEX IF NOT EXISTS idx_lm_member ON ledger_members(member);

CREATE TABLE IF NOT EXISTS ledger_invites (
  id           TEXT PRIMARY KEY,
  ledger_id    TEXT NOT NULL,
  inviter      TEXT NOT NULL,
  invitee      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  responded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_inv_invitee ON ledger_invites(invitee, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_pending ON ledger_invites(ledger_id, invitee) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS user_prefs (
  member            TEXT PRIMARY KEY,
  default_ledger_id TEXT
);

ALTER TABLE transactions ADD COLUMN ledger_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tx_ledger ON transactions(ledger_id, date);

ALTER TABLE budgets RENAME TO budgets_legacy;
CREATE TABLE budgets (
  ledger_id TEXT NOT NULL,
  month     TEXT NOT NULL,
  category  TEXT NOT NULL,
  limit_amt INTEGER NOT NULL,
  PRIMARY KEY (ledger_id, month, category)
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
