/** 가계부 툴 — 날짜 계약과 공용 입력 검증, 실제 SQL 저장까지 검증. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLedgerTools, type LedgerTxDetails, type LedgerDeleteDetails } from "../src/tools.ts";
import { ensureMigrated } from "../src/schema.ts";
import { LedgerValidationError } from "../src/repo.ts";
import { installFakeD1, type FakeD1 } from "./fake-d1.ts";

const BEFORE_MIDNIGHT = Date.parse("2026-09-30T14:59:59Z"); // KST 09/30 23:59:59
let d1: FakeD1;

type AddParams = {
	date?: string;
	daysAgo?: number;
	amount: number;
	type: "expense" | "income";
};

function addTool() {
	const tool = createLedgerTools(() => d1.cfg, "ms").find((t) => t.name === "ledger_add");
	assert.ok(tool);
	return tool;
}

async function run(tool: ReturnType<typeof addTool>, dateParams: { date?: string; daysAgo?: number } = {}) {
	const params: AddParams = { amount: 8000, type: "expense", ...dateParams };
	const result = await tool.execute("test", params as never, undefined, undefined, undefined as never);
	const { tx } = result.details as LedgerTxDetails;
	const stored = d1.db.prepare("SELECT date, amount, member, source FROM transactions WHERE id = ?").get(tx.id);
	assert.deepEqual({ ...stored }, { date: tx.date, amount: -8000, member: "ms", source: "agent" });
	assert.match(result.content[0]!.text, new RegExp(tx.date));
	return tx;
}

beforeEach(async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: BEFORE_MIDNIGHT });
	d1 = installFakeD1();
	await ensureMigrated(d1.cfg);
});

afterEach(() => {
	d1.restore();
	d1.db.close();
});

describe("가계부 툴 공용 입력 검증", () => {
	async function call(name: string, params: Record<string, unknown>) {
		const tool = createLedgerTools(() => d1.cfg, "ms").find((t) => t.name === name);
		assert.ok(tool);
		return tool.execute("test", params as never, undefined, undefined, undefined as never);
	}

	it("ledger_add: 잘못된 날짜·거래 유형은 저장하지 않는다", async () => {
		for (const patch of [
			{ date: "2026-02-31" }, { date: "" }, { date: null }, { date: ["2026-09-10"] },
			{ type: "EXPENSE" }, { type: null },
		]) {
			await assert.rejects(call("ledger_add", { date: "2026-09-10", amount: 8000, type: "expense", ...patch }), LedgerValidationError);
		}
		assert.equal(d1.db.prepare("SELECT COUNT(*) n FROM transactions").get()?.n, 0);
	});

	it("ledger_update: 잘못된 수정은 기존 거래를 변경하지 않는다", async () => {
		const tx = await run(addTool());
		const before = d1.db.prepare("SELECT * FROM transactions WHERE id = ?").get(tx.id);
		for (const patch of [{ date: "2026-02-31", memo: "변경" }, { type: "EXPENSE", amount: 1 }, { type: null }]) {
			await assert.rejects(call("ledger_update", { id: tx.id, ...patch }), LedgerValidationError);
			assert.deepEqual(d1.db.prepare("SELECT * FROM transactions WHERE id = ?").get(tx.id), before);
		}
	});

	it("ledger_list/summary: 잘못된 날짜·거래 유형과 불완전한 절대 기간을 거절한다", async () => {
		for (const name of ["ledger_list", "ledger_summary"]) {
			for (const params of [{ from: "2026-02-31", to: "2026-09-30" }, { from: "", to: "2026-09-30" }, { from: "2026-09-01" }, { to: "2026-09-30" }]) {
				await assert.rejects(call(name, params), LedgerValidationError);
			}
		}
		await assert.rejects(call("ledger_list", { type: "EXPENSE" }), LedgerValidationError);
	});

	it("ledger_budget: 잘못된 월은 설정·조회할 수 없고 기존 예산은 그대로다", async () => {
		await call("ledger_budget", { action: "set", month: "2026-09", category: "식비", limit: 10000 });
		const before = d1.db.prepare("SELECT * FROM budgets").all();
		for (const month of ["2026-00", "2026-13", "0000-01", "", null]) {
			await assert.rejects(call("ledger_budget", { action: "set", month, category: "식비", limit: 1 }), LedgerValidationError);
			await assert.rejects(call("ledger_budget", { action: "status", month }), LedgerValidationError);
		}
		assert.deepEqual(d1.db.prepare("SELECT * FROM budgets").all(), before);
	});
});

describe("ledger_delete 기존 정책·권한", () => {
	it("현재의 즉시 삭제 계약을 유지하고 내 가계부 거래만 삭제한다", async () => {
		const tx = await run(addTool());
		const tool = createLedgerTools(() => d1.cfg, "ms").find((t) => t.name === "ledger_delete")!;
		const r = await tool.execute("test", { id: tx.id } as never, undefined, undefined, undefined as never);
		assert.deepEqual(r.details as LedgerDeleteDetails, { kind: "ledger-delete", id: tx.id, deleted: true });
		assert.equal(d1.db.prepare("SELECT COUNT(*) n FROM transactions WHERE id = ?").get(tx.id)?.n, 0);
	});

	it("남의 가계부 거래 id를 알아도 삭제하지 않고 존재 여부를 드러내지 않는다", async () => {
		const otherAdd = createLedgerTools(() => d1.cfg, "sj").find((t) => t.name === "ledger_add")!;
		const added = await otherAdd.execute("test", { date: "2026-09-30", amount: 8000, type: "expense" } as never, undefined, undefined, undefined as never);
		const tx = (added.details as LedgerTxDetails).tx;
		const before = d1.db.prepare("SELECT * FROM transactions WHERE id = ?").get(tx.id);
		const tool = createLedgerTools(() => d1.cfg, "ms").find((t) => t.name === "ledger_delete")!;
		const r = await tool.execute("test", { id: tx.id } as never, undefined, undefined, undefined as never);
		assert.equal((r.details as LedgerDeleteDetails).deleted, false);
		assert.match(r.content[0]!.text, /해당 id가 없습니다/);
		assert.deepEqual(d1.db.prepare("SELECT * FROM transactions WHERE id = ?").get(tx.id), before);
	});
});

describe("ledger_add 날짜", () => {
	it("날짜는 선택 항목이고 daysAgo 범위가 스키마에 정의된다", () => {
		const tool = addTool();
		assert.deepEqual(tool.parameters.required, ["amount", "type"]);
		assert.ok("date" in tool.parameters.properties);
		assert.ok("daysAgo" in tool.parameters.properties);
		const daysAgo = tool.parameters.properties.daysAgo;
		assert.equal(daysAgo.type, "integer");
		assert.equal(daysAgo.minimum, 0);
		assert.equal(daysAgo.maximum, 3650);
		assert.doesNotMatch(tool.description, /\d{4}-\d{2}-\d{2}/);
	});

	it("날짜를 생략하면 실행 시점의 KST 오늘로 기록한다", async () => {
		assert.equal((await run(addTool())).date, "2026-09-30");
	});

	it("daysAgo=0 이면 오늘로 기록한다", async () => {
		assert.equal((await run(addTool(), { daysAgo: 0 })).date, "2026-09-30");
	});

	it("daysAgo=1 이면 어제로 기록한다", async () => {
		assert.equal((await run(addTool(), { daysAgo: 1 })).date, "2026-09-29");
	});

	it("명시한 절대 날짜는 그대로 기록한다", async () => {
		assert.equal((await run(addTool(), { date: "2026-08-15" })).date, "2026-08-15");
	});

	it("두 날짜 인자를 함께 보내면 기존 해석 규칙대로 daysAgo 를 우선한다", async () => {
		assert.equal((await run(addTool(), { date: "2026-08-15", daysAgo: 1 })).date, "2026-09-29");
	});

	it("같은 도구를 KST 자정·월 경계 이후 재사용해도 날짜를 다시 계산한다", async (t) => {
		const tool = addTool();
		assert.equal((await run(tool)).date, "2026-09-30");
		t.mock.timers.setTime(BEFORE_MIDNIGHT + 2000);
		assert.equal((await run(tool)).date, "2026-10-01");
		assert.equal((await run(tool, { daysAgo: 1 })).date, "2026-09-30");
	});

	it("연도 경계에서도 어제를 KST 기준으로 계산한다", async (t) => {
		t.mock.timers.setTime(Date.parse("2026-12-31T15:00:00Z"));
		assert.equal((await run(addTool(), { daysAgo: 1 })).date, "2026-12-31");
	});

	it("잘못된 daysAgo 는 저장 전에 거절한다", async () => {
		const tool = addTool();
		for (const daysAgo of [-1, 0.5, 3651]) {
			await assert.rejects(run(tool, { daysAgo }), /daysAgo는 0 이상 3650 이하의 정수/);
		}
		assert.equal(d1.db.prepare("SELECT COUNT(*) n FROM transactions").get()?.n, 0);
	});
});
