/**
 * 가계부 리포지토리 — 서버 REST(/api/ledger)와 에이전트 툴(ledger_*)이
 * 공유하는 단일 진입점. 비즈니스 로직은 전부 여기에만 있다 (PLAN.md §3.2).
 *
 * SQL은 전부 이 파일의 리터럴이고 사용자/LLM 입력은 params로만 들어간다.
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

export async function addTransaction(cfg: D1Config, input: TxInput): Promise<Transaction> {
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
		dedupe_key: input.dedupeKey ?? null,
		created_at: new Date().toISOString(),
	};

	await d1Query(
		cfg,
		`INSERT INTO transactions (id, date, amount, currency, category, merchant, memo, account, source, member, dedupe_key, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
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

export async function listTransactions(cfg: D1Config, filter: TxFilter = {}): Promise<Transaction[]> {
	const where: string[] = [];
	const params: D1Param[] = [];

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
		`SELECT * FROM transactions` +
		(where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
		` ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`;

	const r = await d1Query<Transaction>(cfg, sql, params);
	return r.results;
}

export async function getTransaction(cfg: D1Config, id: string): Promise<Transaction | null> {
	const r = await d1Query<Transaction>(cfg, "SELECT * FROM transactions WHERE id = ?", [id]);
	return r.results[0] ?? null;
}

export async function updateTransaction(cfg: D1Config, id: string, patch: TxPatch): Promise<Transaction> {
	const current = await getTransaction(cfg, id);
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

	params.push(id);
	await d1Query(cfg, `UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`, params);

	const updated = await getTransaction(cfg, id);
	if (!updated) throw new Error(`수정 후 거래를 다시 읽지 못했습니다: ${id}`);
	return updated;
}

export async function deleteTransaction(cfg: D1Config, id: string): Promise<boolean> {
	const r = await d1Query(cfg, "DELETE FROM transactions WHERE id = ?", [id]);
	return (r.meta.changes ?? 0) > 0;
}

// ── 집계 ────────────────────────────────────────────────────────────────

/**
 * 기간 집계. 원시 내역이 아니라 집계 결과만 돌려주는 것이 기본 경로다
 * (PLAN.md §7.4 — 프라이버시·토큰).
 */
export async function summary(
	cfg: D1Config,
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

	// 가계부는 공유이므로 기본은 가구 전체. member를 주면 그 사람 것만 집계한다.
	const memberFilter = opts.member ? " AND member = ?" : "";

	const r = await d1Query<SummaryRow>(
		cfg,
		`SELECT ${keyExpr} AS key,
		        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
		        SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS expense,
		        SUM(amount) AS net,
		        COUNT(*) AS count
		 FROM transactions
		 WHERE date >= ? AND date <= ?${memberFilter}
		 GROUP BY key
		 ORDER BY expense DESC`,
		opts.member ? [opts.from, opts.to, opts.member] : [opts.from, opts.to],
	);
	return r.results;
}

// ── 예산 ────────────────────────────────────────────────────────────────

export async function setBudget(cfg: D1Config, budget: Budget): Promise<Budget> {
	assertMonth(budget.month, "month");
	assertAmount(budget.limit_amt);
	await d1Query(
		cfg,
		`INSERT INTO budgets (month, category, limit_amt) VALUES (?, ?, ?)
		 ON CONFLICT(month, category) DO UPDATE SET limit_amt = excluded.limit_amt`,
		[budget.month, budget.category, budget.limit_amt],
	);
	return budget;
}

export async function budgetStatus(cfg: D1Config, month: string): Promise<BudgetStatus[]> {
	assertMonth(month, "month");
	const r = await d1Query<Budget & { spent: number }>(
		cfg,
		`SELECT b.month, b.category, b.limit_amt,
		        COALESCE((SELECT SUM(-t.amount) FROM transactions t
		                  WHERE t.category = b.category
		                    AND substr(t.date, 1, 7) = b.month
		                    AND t.amount < 0), 0) AS spent
		 FROM budgets b
		 WHERE b.month = ?
		 ORDER BY b.category`,
		[month],
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
export async function exportAll(cfg: D1Config): Promise<{ transactions: Transaction[]; budgets: Budget[] }> {
	const tx = await d1Query<Transaction>(cfg, "SELECT * FROM transactions ORDER BY date, id");
	const bg = await d1Query<Budget>(cfg, "SELECT * FROM budgets ORDER BY month, category");
	return { transactions: tx.results, budgets: bg.results };
}
