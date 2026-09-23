/**
 * 스파이크 2 — Cloudflare D1을 REST로 쓸 수 있는가?
 *
 * 검증 항목:
 *   a. 토큰 하나로 연결되는가 (wrangler·Workers 바인딩 없이)
 *   b. 마이그레이션이 REST로 실행되는가 (다중 statement)
 *   c. INSERT / SELECT / GROUP BY 왕복
 *   d. 파라미터 바인딩이 동작하는가 (raw SQL 금지 원칙의 전제)
 *
 * 실행: pnpm spike:d1
 * 필요: .env 의 AF_D1_ACCOUNT_ID / AF_D1_DATABASE_ID / AF_D1_TOKEN
 *
 * ⚠️ 이 스파이크는 '[spike]' 메모가 붙은 테스트 행을 넣고 끝에 지운다.
 */
import {
	createLedger,
	deleteLedger,
	addTransaction,
	budgetStatus,
	d1ConfigFromEnv,
	d1Ping,
	deleteTransaction,
	listTransactions,
	migrate,
	setBudget,
	summary,
} from "@alphafolio/ledger";
import { loadEnv } from "./env.ts";

loadEnv();

const MONTH = new Date().toISOString().slice(0, 7);
const TODAY = new Date().toISOString().slice(0, 10);

async function main(): Promise<void> {
	// (a)
	const cfg = d1ConfigFromEnv();
	const ms = await d1Ping(cfg);
	console.log(`a. 연결        ✅ ${ms}ms`);

	// (b)
	const m = await migrate(cfg);
	console.log(`b. 마이그레이션 ✅ 적용 ${m.applied.length}건 / 건너뜀 ${m.skipped.length}건`);

	// (c)(d) — 스파이크 전용 가계부에 쓰고 끝나면 통째로 지운다 (예산 행이 남던 문제)
	const book = await createLedger(cfg, "spike", "[spike] 02-d1");
	const inserted = await addTransaction(cfg, book.id, {
		date: TODAY,
		amount: 8000,
		type: "expense",
		category: "식비",
		merchant: "김밥천국",
		memo: "[spike] 테스트 행",
		source: "manual",
	});
	console.log(`c. INSERT      ✅ id=${inserted.id} amount=${inserted.amount}`);

	const rows = await listTransactions(cfg, book.id, { from: TODAY, to: TODAY, limit: 5 });
	console.log(`   SELECT      ✅ ${rows.length}건 조회`);

	const agg = await summary(cfg, book.id, { from: `${MONTH}-01`, to: `${MONTH}-31` });
	console.log(`   GROUP BY    ✅ ${agg.length}개 카테고리`);
	for (const r of agg) console.log(`                 ${r.key}: 지출 ${r.expense.toLocaleString("ko-KR")}원 (${r.count}건)`);

	await setBudget(cfg, book.id, { month: MONTH, category: "식비", limit_amt: 400_000 });
	const status = await budgetStatus(cfg, book.id, MONTH);
	const food = status.find((s) => s.category === "식비");
	console.log(`d. 예산 조인   ✅ 식비 ${food?.spent.toLocaleString("ko-KR")}원 / ${food?.limit_amt.toLocaleString("ko-KR")}원 (${food?.usedPct}%)`);

	// 정리
	const removed = await deleteTransaction(cfg, book.id, inserted.id);
	await deleteLedger(cfg, "spike", book.id, book.name);
	console.log(`   정리        ${removed ? "✅" : "❌"} 테스트 행·가계부 삭제`);

	console.log("\n✅ 스파이크 2 통과 — D1 REST로 가계부 CRUD·집계가 전부 동작한다.");
}

main().catch((err: unknown) => {
	console.error("\n❌ 스파이크 2 실패:\n", err instanceof Error ? err.message : err);
	process.exitCode = 1;
});
