/** 가계부 REST 입력 검증 — 잘못된 요청은 400, 기존 거래·예산은 그대로. */
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLedger, ensureMigrated, type Transaction } from "@alphafolio/ledger";
import { installFakeD1, type FakeD1 } from "../../../packages/ledger/test/fake-d1.ts";
import { handleLedger, HttpError, setLedgerConfigProvider } from "../src/ledger-api.ts";

let d1: FakeD1;
const txInput = { date: "2026-09-10", amount: 8000, type: "expense", category: "식비" };

async function request(method: string, rest: string, body?: unknown): Promise<unknown> {
	const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage;
	req.method = method;
	const url = new URL(`/api/ledger${rest}`, "http://localhost");
	return handleLedger(req, url, url.pathname.slice("/api/ledger".length), "ms");
}

async function badRequest(method: string, rest: string, body?: unknown): Promise<void> {
	await assert.rejects(request(method, rest, body), (err: unknown) => {
		assert.ok(err instanceof HttpError, `HttpError가 아님: ${String(err)}`);
		assert.equal(err.status, 400);
		return true;
	});
}

function rows(table: "transactions" | "budgets") {
	return d1.db.prepare(`SELECT * FROM ${table}`).all().map((r) => ({ ...r }));
}

beforeEach(async () => {
	d1 = installFakeD1();
	setLedgerConfigProvider(() => d1.cfg);
	await ensureMigrated(d1.cfg);
	await createLedger(d1.cfg, "ms", "검증");
});
afterEach(() => {
	d1.restore();
	d1.db.close();
});

describe("가계부 REST 입력 검증", () => {
	it("POST: 잘못된 날짜·거래 유형은 400이고 거래가 저장되지 않는다", async () => {
		for (const body of [
			{ ...txInput, date: "2026-02-31" }, { ...txInput, date: "2026-13-01" },
			{ ...txInput, date: ["2026-09-10"] }, { ...txInput, type: "EXPENSE" },
			{ ...txInput, type: "" }, { ...txInput, type: null }, { ...txInput, type: false },
		]) {
			await badRequest("POST", "/transactions", body);
		}
		assert.deepEqual(rows("transactions"), []);
	});

	it("POST: 유효한 윤일·수입과 type 생략 시 기본 지출을 유지한다", async () => {
		const income = await request("POST", "/transactions", { ...txInput, date: "2024-02-29", type: "income" }) as Transaction;
		assert.equal(income.date, "2024-02-29");
		assert.equal(income.amount, 8000);
		const expense = await request("POST", "/transactions", { date: "2026-09-10", amount: 8000 }) as Transaction;
		assert.equal(expense.amount, -8000);
	});

	it("PATCH: 잘못된 날짜·거래 유형은 400이고 다른 필드도 변경하지 않는다", async () => {
		const tx = await request("POST", "/transactions", txInput) as Transaction;
		const before = rows("transactions");
		for (const body of [
			{ date: "2026-02-31", amount: 1 }, { type: "EXPENSE", date: "2026-09-11", memo: "변경" },
			{ type: null }, { date: null }, { type: "" },
		]) {
			await badRequest("PATCH", `/transactions/${tx.id}`, body);
			assert.deepEqual(rows("transactions"), before);
		}
	});

	it("PATCH: 날짜·금액·거래 유형의 정상 수정은 가능하다", async () => {
		const tx = await request("POST", "/transactions", txInput) as Transaction;
		const updated = await request("PATCH", `/transactions/${tx.id}`, { date: "2024-02-29", amount: 1000, type: "income" }) as Transaction;
		assert.equal(updated.date, "2024-02-29");
		assert.equal(updated.amount, 1000);
	});

	it("GET: 목록·집계의 잘못된 날짜와 거래 유형을 400으로 거절한다", async () => {
		for (const rest of [
			"/transactions?from=2026-02-31", "/transactions?to=2026-09-31",
			"/transactions?from=", "/transactions?type=EXPENSE", "/transactions?type=",
			"/summary?from=2026-02-31&to=2026-09-30", "/summary?from=2026-09-01&to=2026-09-31",
		]) {
			await badRequest("GET", rest);
		}
	});

	it("PUT/GET: 잘못된 예산 월은 400이고 기존 예산은 그대로다", async () => {
		await request("PUT", "/budgets", { month: "2026-09", category: "식비", limit_amt: 10000 });
		const before = rows("budgets");
		for (const month of ["2026-00", "2026-13", "0000-01", "2026-1"]) {
			await badRequest("PUT", "/budgets", { month, category: "식비", limit_amt: 1 });
			await badRequest("GET", `/budgets?month=${month}`);
			assert.deepEqual(rows("budgets"), before);
		}
	});

	it("유효한 월의 예산과 거래를 조회할 수 있다", async () => {
		await request("POST", "/transactions", txInput);
		await request("PUT", "/budgets", { month: "2026-09", category: "식비", limit_amt: 10000 });
		const transactions = await request("GET", "/transactions?from=2026-09-01&to=2026-09-30&type=expense") as Transaction[];
		assert.equal(transactions.length, 1);
		const budgets = await request("GET", "/budgets?month=2026-09") as Array<{ spent: number }>;
		assert.equal(budgets[0]?.spent, 8000);
	});

	it("입력 검증 외의 저장소 장애는 400으로 바꾸지 않는다", async () => {
		const outage = new Error("simulated D1 outage");
		setLedgerConfigProvider(() => { throw outage; });
		await assert.rejects(request("GET", "/transactions"), (err: unknown) => err === outage);
	});

	it("기존 금액 입력 오류도 500 대신 400으로 분류한다", async () => {
		await badRequest("POST", "/transactions", { ...txInput, amount: 0 });
		await badRequest("PUT", "/budgets", { month: "2026-09", category: "식비", limit_amt: -1 });
	});
});
