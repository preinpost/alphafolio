/**
 * 가계부 리포지토리 — 서버 REST(/api/ledger)와 에이전트 툴(ledger_*)이
 * 공유하는 단일 진입점. 비즈니스 로직은 전부 여기에만 있다 (PLAN.md §3.2).
 *
 * SQL은 전부 이 파일의 리터럴이고 사용자/LLM 입력은 params로만 들어간다.
 *
 * **모든 함수가 ledgerId 를 받고, 모든 SQL 이 ledger_id 로 거른다** (PLAN §23).
 * ledgerId 가 "이 사용자가 멤버인 가계부" 인지는 호출부가 ledgers.ts(resolveLedger 등)로
 * 먼저 확인한다. 여기서 거르지 않으면 거래 id 만 알면 남의 가계부를 고칠 수 있다.
 */
import { d1Query, type D1Config, type D1Param } from "./d1.ts";
import { ulid } from "./ulid.ts";
import type {
	Budget,
	BudgetStatus,
	SummaryRow,
	Transaction,
	TxFilter,
	TxInput,
	TxPatch,
} from "./types.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function assertDate(value: string, field: string): void {
	if (!DATE_RE.test(value)) throw new Error(`${field}는 YYYY-MM-DD 형식이어야 합니다: ${value}`);
}

function assertMonth(value: string, field: string): void {
	if (!MONTH_RE.test(value)) throw new Error(`${field}는 YYYY-MM 형식이어야 합니다: ${value}`);
}

function assertAmount(value: number): void {
	if (!Number.isInteger(value)) throw new Error(`금액은 정수(원 단위)여야 합니다: ${value}`);
	if (value <= 0) throw new Error(`금액은 양수여야 합니다 (수입/지출은 type으로 구분): ${value}`);
}

/** 입력의 (양수 금액 + type)을 DB의 부호 있는 정수로 변환. */
function signed(amount: number, type: TxInput["type"]): number {
	return type === "expense" ? -amount : amount;
}

// ── 거래 ────────────────────────────────────────────────────────────────

export async function addTransaction(cfg: D1Config, ledgerId: string, input: TxInput): Promise<Transaction> {
	assertDate(input.date, "date");
	assertAmount(input.amount);

	const row: Transaction = {
		id: ulid(),
		date: input.date,
		amount: signed(input.amount, input.type),
		currency: input.currency ?? "KRW",
		category: input.category ?? null,
		merchant: input.merchant ?? null,
		memo: input.memo ?? null,
		account: input.account ?? null,
		source: input.source ?? "manual",
		member: input.member ?? null,
		ledger_id: ledgerId,
		dedupe_key: input.dedupeKey ?? null,
		created_at: new Date().toISOString(),
	};

	await d1Query(
		cfg,
		`INSERT INTO transactions (id, ledger_id, date, amount, currency, category, merchant, memo, account, source, member, dedupe_key, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			ledgerId,
			row.date,
			row.amount,
			row.currency,
			row.category,
			row.merchant,
			row.memo,
			row.account,
			row.source,
			row.member,
			row.dedupe_key,
			row.created_at,
		],
	);

	return row;
}

export async function listTransactions(cfg: D1Config, ledgerId: string, filter: TxFilter = {}): Promise<Transaction[]> {
	const where: string[] = ["ledger_id = ?"];
	const params: D1Param[] = [ledgerId];

	if (filter.from) {
		assertDate(filter.from, "from");
		where.push("date >= ?");
		params.push(filter.from);
	}
	if (filter.to) {
		assertDate(filter.to, "to");
		where.push("date <= ?");
		params.push(filter.to);
	}
	if (filter.category) {
		where.push("category = ?");
		params.push(filter.category);
	}
	if (filter.member) {
		where.push("member = ?");
		params.push(filter.member);
	}
	if (filter.type) {
		where.push(filter.type === "expense" ? "amount < 0" : "amount > 0");
	}

	const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
	const offset = Math.max(filter.offset ?? 0, 0);
	params.push(limit, offset);

	const sql =
		`SELECT * FROM transactions WHERE ${where.join(" AND ")}` +
		` ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`;

	const r = await d1Query<Transaction>(cfg, sql, params);
	return r.results;
}

export async function getTransaction(cfg: D1Config, ledgerId: string, id: string): Promise<Transaction | null> {
	const r = await d1Query<Transaction>(cfg, "SELECT * FROM transactions WHERE id = ? AND ledger_id = ?", [id, ledgerId]);
	return r.results[0] ?? null;
}

/**
 * 거래 id 로 "내가 멤버인 가계부" 를 찾는다 — 수정·삭제는 목록에서 고른 id 만 들고 오므로.
 * 멤버십 조인이라, 남의 가계부 거래면 null (존재 여부도 흘리지 않는다).
 */
export async function ledgerOfTransaction(cfg: D1Config, user: string, id: string): Promise<string | null> {
	const r = await d1Query<{ ledger_id: string }>(
		cfg,
		`SELECT t.ledger_id FROM transactions t
		 JOIN ledger_members m ON m.ledger_id = t.ledger_id AND m.member = ?
		 WHERE t.id = ?`,
		[user, id],
	);
	return r.results[0]?.ledger_id ?? null;
}

export async function updateTransaction(cfg: D1Config, ledgerId: string, id: string, patch: TxPatch): Promise<Transaction> {
	const current = await getTransaction(cfg, ledgerId, id);
	if (!current) throw new Error(`거래를 찾을 수 없습니다: ${id}`);

	const sets: string[] = [];
	const params: D1Param[] = [];

	if (patch.date !== undefined) {
		assertDate(patch.date, "date");
		sets.push("date = ?");
		params.push(patch.date);
	}
	if (patch.amount !== undefined || patch.type !== undefined) {
		const amount = patch.amount ?? Math.abs(current.amount);
		const type = patch.type ?? (current.amount < 0 ? "expense" : "income");
		assertAmount(amount);
		sets.push("amount = ?");
		params.push(signed(amount, type));
	}
	for (const field of ["category", "merchant", "memo", "account"] as const) {
		if (patch[field] !== undefined) {
			sets.push(`${field} = ?`);
			params.push(patch[field]!);
		}
	}

	if (sets.length === 0) return current;

	params.push(id, ledgerId);
	await d1Query(cfg, `UPDATE transactions SET ${sets.join(", ")} WHERE id = ? AND ledger_id = ?`, params);

	const updated = await getTransaction(cfg, ledgerId, id);
	if (!updated) throw new Error(`수정 후 거래를 다시 읽지 못했습니다: ${id}`);
	return updated;
}

export async function deleteTransaction(cfg: D1Config, ledgerId: string, id: string): Promise<boolean> {
	const r = await d1Query(cfg, "DELETE FROM transactions WHERE id = ? AND ledger_id = ?", [id, ledgerId]);
	return (r.meta.changes ?? 0) > 0;
}

// ── 집계 ────────────────────────────────────────────────────────────────

/**
 * 기간 집계. 원시 내역이 아니라 집계 결과만 돌려주는 것이 기본 경로다
 * (PLAN.md §7.4 — 프라이버시·토큰).
 */
export async function summary(
	cfg: D1Config,
	ledgerId: string,
	opts: { from: string; to: string; groupBy?: "category" | "month" | "member"; member?: string },
): Promise<SummaryRow[]> {
	assertDate(opts.from, "from");
	assertDate(opts.to, "to");

	const keyExpr =
		opts.groupBy === "month"
			? "substr(date, 1, 7)"
			: opts.groupBy === "member"
				? "COALESCE(member, '(미지정)')"
				: "COALESCE(category, '(미분류)')";

	// 기본은 가계부 전체. member를 주면 그 사람이 기록한 것만 집계한다.
	const memberFilter = opts.member ? " AND member = ?" : "";

	const r = await d1Query<SummaryRow>(
		cfg,
		`SELECT ${keyExpr} AS key,
		        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
		        SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS expense,
		        SUM(amount) AS net,
		        COUNT(*) AS count
		 FROM transactions
		 WHERE ledger_id = ? AND date >= ? AND date <= ?${memberFilter}
		 GROUP BY key
		 ORDER BY expense DESC`,
		opts.member ? [ledgerId, opts.from, opts.to, opts.member] : [ledgerId, opts.from, opts.to],
	);
	return r.results;
}

// ── 예산 ────────────────────────────────────────────────────────────────

export async function setBudget(cfg: D1Config, ledgerId: string, budget: Budget): Promise<Budget> {
	assertMonth(budget.month, "month");
	assertAmount(budget.limit_amt);
	await d1Query(
		cfg,
		`INSERT INTO budgets (ledger_id, month, category, limit_amt) VALUES (?, ?, ?, ?)
		 ON CONFLICT(ledger_id, month, category) DO UPDATE SET limit_amt = excluded.limit_amt`,
		[ledgerId, budget.month, budget.category, budget.limit_amt],
	);
	return budget;
}

export async function budgetStatus(cfg: D1Config, ledgerId: string, month: string): Promise<BudgetStatus[]> {
	assertMonth(month, "month");
	const r = await d1Query<Budget & { spent: number }>(
		cfg,
		`SELECT b.month, b.category, b.limit_amt,
		        COALESCE((SELECT SUM(-t.amount) FROM transactions t
		                  WHERE t.ledger_id = b.ledger_id
		                    AND t.category = b.category
		                    AND substr(t.date, 1, 7) = b.month
		                    AND t.amount < 0), 0) AS spent
		 FROM budgets b
		 WHERE b.ledger_id = ? AND b.month = ?
		 ORDER BY b.category`,
		[ledgerId, month],
	);

	return r.results.map((row) => ({
		...row,
		remaining: row.limit_amt - row.spent,
		usedPct: row.limit_amt > 0 ? Math.round((row.spent / row.limit_amt) * 1000) / 10 : 0,
	}));
}

// ── 백업 ────────────────────────────────────────────────────────────────

/**
 * 전체 내보내기. D1 무료 플랜의 Time Travel 이 7일뿐이라
 * v0.1 필수 기능이다 (PLAN.md §7.3).
 */
export async function exportAll(cfg: D1Config, ledgerId: string): Promise<{ transactions: Transaction[]; budgets: Budget[] }> {
	const tx = await d1Query<Transaction>(cfg, "SELECT * FROM transactions WHERE ledger_id = ? ORDER BY date, id", [ledgerId]);
	const bg = await d1Query<Budget>(
		cfg,
		"SELECT month, category, limit_amt FROM budgets WHERE ledger_id = ? ORDER BY month, category",
		[ledgerId],
	);
	return { transactions: tx.results, budgets: bg.results };
}
