/** 공용 repo 입력 검증 — 에이전트·REST 호출 모두 저장·변경 전에 잘못된 입력을 거절한다. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	addTransaction, budgetStatus, createLedger, ensureMigrated, getTransaction,
	LedgerValidationError, listTransactions, setBudget, summary, updateTransaction,
} from "../src/index.ts";
import { installFakeD1, type FakeD1 } from "./fake-d1.ts";

let d1: FakeD1;
let ledgerId: string;
const input = { date: "2026-09-10", amount: 8000, type: "expense" as const, member: "ms" };

async function invalid(p: Promise<unknown>): Promise<void> {
	await assert.rejects(p, (err: unknown) => {
		assert.ok(err instanceof LedgerValidationError);
		return true;
	});
}

beforeEach(async () => {
	d1 = installFakeD1();
	await ensureMigrated(d1.cfg);
	ledgerId = (await createLedger(d1.cfg, "ms", "검증")).id;
});
afterEach(() => {
	d1.restore();
	d1.db.close();
});

describe("거래 입력 검증", () => {
	it("유효한 날짜와 윤년·세기·두 자리 연도를 허용한다", async () => {
		for (const date of ["2026-01-31", "2026-04-30", "2024-02-29", "2000-02-29", "2400-02-29", "0099-02-28", "0001-01-01", "9999-12-31"]) {
			assert.equal((await addTransaction(d1.cfg, ledgerId, { ...input, date })).date, date);
		}
	});

	it("존재하지 않는 날짜와 잘못된 형식은 저장하지 않는다", async () => {
		for (const date of ["2026-02-31", "2026-02-29", "1900-02-29", "2100-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-01-00", "2026-01-32", "0000-01-01", "2026-9-01", "2026-09-01T00:00:00Z", "2026-09-10\n", ""]) {
			await invalid(addTransaction(d1.cfg, ledgerId, { ...input, date }));
		}
		assert.equal(d1.db.prepare("SELECT COUNT(*) n FROM transactions").get()?.n, 0);
	});

	it("문자열이 아닌 날짜를 문자열로 암묵 변환하지 않는다", async () => {
		for (const date of [null, undefined, ["2026-09-10"], { toString: () => "2026-09-10" }]) {
			await invalid(addTransaction(d1.cfg, ledgerId, { ...input, date: date as never }));
		}
	});

	it("expense와 income만 허용하고 각각 음수·양수로 저장한다", async () => {
		assert.equal((await addTransaction(d1.cfg, ledgerId, input)).amount, -8000);
		assert.equal((await addTransaction(d1.cfg, ledgerId, { ...input, type: "income" })).amount, 8000);
	});

	it("잘못된 거래 유형은 수입으로 변환하지 않고 거절한다", async () => {
		for (const type of ["EXPENSE", "refund", "", null, undefined, false, 1]) {
			await invalid(addTransaction(d1.cfg, ledgerId, { ...input, type: type as never }));
		}
		assert.equal(d1.db.prepare("SELECT COUNT(*) n FROM transactions").get()?.n, 0);
	});

	it("잘못된 수정은 다른 필드까지 포함해 기존 거래를 변경하지 않는다", async () => {
		const tx = await addTransaction(d1.cfg, ledgerId, input);
		for (const patch of [
			{ date: "2026-02-31", memo: "변경" },
			{ type: "EXPENSE", amount: 1, date: "2026-09-11" },
			{ type: null, amount: 1 },
			{ date: null },
			{ amount: null },
		]) {
			await invalid(updateTransaction(d1.cfg, ledgerId, tx.id, patch as never));
			assert.deepEqual(await getTransaction(d1.cfg, ledgerId, tx.id), tx);
		}
	});

	it("날짜·금액·거래 유형을 각각 정상적으로 수정할 수 있다", async () => {
		const tx = await addTransaction(d1.cfg, ledgerId, input);
		assert.equal((await updateTransaction(d1.cfg, ledgerId, tx.id, { date: "2024-02-29" })).date, "2024-02-29");
		assert.equal((await updateTransaction(d1.cfg, ledgerId, tx.id, { amount: 1000 })).amount, -1000);
		assert.equal((await updateTransaction(d1.cfg, ledgerId, tx.id, { type: "income" })).amount, 1000);
	});

	it("기존 금액 검증 오류도 입력 오류로 구분한다", async () => {
		for (const amount of [0, -1, 1.5, NaN, Infinity]) {
			await invalid(addTransaction(d1.cfg, ledgerId, { ...input, amount }));
		}
	});
});

describe("조회 입력 검증", () => {
	it("목록 조회의 from·to와 거래 유형을 검증한다 — 빈 값·null도 생략으로 보지 않는다", async () => {
		for (const filter of [
			{ from: "2026-02-31" }, { to: "2026-13-01" }, { from: "" }, { to: null },
			{ type: "EXPENSE" }, { type: "" }, { type: null },
		]) {
			await invalid(listTransactions(d1.cfg, ledgerId, filter as never));
		}
	});

	it("집계의 from·to를 검증한다", async () => {
		await invalid(summary(d1.cfg, ledgerId, { from: "2026-02-31", to: "2026-09-30" }));
		await invalid(summary(d1.cfg, ledgerId, { from: "2026-09-01", to: "2026-09-31" }));
	});
});

describe("예산 월 검증", () => {
	it("유효한 월을 설정하고 조회할 수 있다", async () => {
		for (const month of ["2026-01", "2026-12", "0099-02", "0001-01", "9999-12"]) {
			await setBudget(d1.cfg, ledgerId, { month, category: "식비", limit_amt: 10000 });
			assert.equal((await budgetStatus(d1.cfg, ledgerId, month))[0]?.month, month);
		}
	});

	it("잘못된 월은 저장·조회할 수 없다", async () => {
		for (const month of ["2026-00", "2026-13", "0000-01", "2026-1", "2026-01-01", "2026-01\n", "", null, ["2026-01"]]) {
			await invalid(setBudget(d1.cfg, ledgerId, { month: month as never, category: "식비", limit_amt: 10000 }));
			await invalid(budgetStatus(d1.cfg, ledgerId, month as never));
		}
		assert.equal(d1.db.prepare("SELECT COUNT(*) n FROM budgets").get()?.n, 0);
	});

	it("잘못된 예산 입력은 기존 예산을 변경하지 않는다", async () => {
		await setBudget(d1.cfg, ledgerId, { month: "2026-09", category: "식비", limit_amt: 10000 });
		await invalid(setBudget(d1.cfg, ledgerId, { month: "2026-13", category: "식비", limit_amt: 1 }));
		await invalid(setBudget(d1.cfg, ledgerId, { month: "2026-09", category: "식비", limit_amt: -1 }));
		assert.equal((await budgetStatus(d1.cfg, ledgerId, "2026-09"))[0]?.limit_amt, 10000);
	});
});
