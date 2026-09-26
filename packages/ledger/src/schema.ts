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
	{
		// 회원가입 (PLAN §25). 슈퍼관리자(AF_ADMIN_USER)는 env 에 두고,
		// 가입한 계정만 여기 저장한다. 가입은 관리자가 발급한 **1회용 초대 코드**로만 된다.
		// 코드는 원문을 저장하지 않는다 (sha256) — 발급 화면에서 한 번만 보여준다.
		// token_version: 비밀번호 변경·모든 기기 로그아웃·비활성화 때 올려 기존 토큰을 한 번에 끊는다.
		id: "0007_accounts",
		sql: `
CREATE TABLE IF NOT EXISTS users (
  name          TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 0,
  invited_by    TEXT,
  created_at    TEXT NOT NULL,
  disabled_at   TEXT
);

CREATE TABLE IF NOT EXISTS signup_invites (
  id          TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL UNIQUE,
  note        TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_by     TEXT,
  used_at     TEXT,
  revoked_at  TEXT
);
`.trim(),
	},
	{
		// 사용자별 원격 MCP 서버 (PLAN §38). 자격증명(고정 헤더·OAuth 토큰)은 행 단위 암호화.
		// auth: oauth | headers | none. preset: 알려진 서버(tradingview)면 이름 — 읽기 허용목록이 여기에 묶인다.
		// mcp_oauth_clients: 동적 등록(DCR)한 client_id — 인가 서버·redirect_uri 마다 서버 전역 1회.
		id: "0008_mcp_servers",
		sql: `
CREATE TABLE IF NOT EXISTS user_mcp_servers (
  member      TEXT NOT NULL,
  id          TEXT NOT NULL,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  auth        TEXT NOT NULL,
  preset      TEXT,
  headers_enc TEXT,
  tokens_enc  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (member, id)
);

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  issuer       TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  client_enc   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (issuer, redirect_uri)
);
`.trim(),
	},
	{
		// 감시 트리거 (PLAN §40). source·action 은 JSON — 소스(자체 감시·웹훅)·동작(알림·주문)이 늘어도 스키마를 안 바꾼다.
		// last_bar_t: 마지막으로 평가한 봉 시작(epoch ms) — 발동 규칙이 봉 배열만으로 정해져서 이것만 기억하면 된다.
		// trigger_events: 발동·만료·오류 기록. 트리거를 지워도 남긴다 (detail 에 이름을 복사해 둔다).
		id: "0009_triggers",
		sql: `
CREATE TABLE IF NOT EXISTS triggers (
  id              TEXT PRIMARY KEY,
  member          TEXT NOT NULL,
  name            TEXT NOT NULL,
  conversation_id TEXT,
  source          TEXT NOT NULL,
  action          TEXT NOT NULL,
  max_fires       INTEGER,
  cooldown_sec    INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT NOT NULL,
  state           TEXT NOT NULL,
  fires           INTEGER NOT NULL DEFAULT 0,
  last_bar_t      INTEGER,
  last_fired_at   INTEGER,
  last_eval_at    INTEGER,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_member ON triggers(member, state);

CREATE TABLE IF NOT EXISTS trigger_events (
  id         TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  member     TEXT NOT NULL,
  at         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  bar_t      INTEGER,
  detail     TEXT,
  notified   TEXT
);
CREATE INDEX IF NOT EXISTS idx_trigger_events_member ON trigger_events(member, at);
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
