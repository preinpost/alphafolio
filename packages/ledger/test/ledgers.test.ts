/**
 * 가계부 분리 · 멤버 · 초대 테스트 (PLAN §23).
 *
 * 핵심은 "남의 가계부에 닿을 수 없다" 이다. 가입을 열면 모르는 사람이 같은 D1 을 쓰게 되므로
 * 여기서 새는 건 곧 가계부 전체 유출이다. 실제 SQL 을 인메모리 SQLite 로 돌린다 (fake-d1.ts).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	addTransaction,
	budgetStatus,
	createLedger,
	deleteLedger,
	deleteTransaction,
	exportAll,
	inviteMember,
	LedgerAccessError,
	ledgerOfTransaction,
	listIncomingInvites,
	listLedgerInvites,
	listMembers,
	listMyLedgers,
	listTransactions,
	migrate,
	removeMember,
	renameLedger,
	resolveLedger,
	respondInvite,
	revokeInvite,
	setBudget,
	setDefaultLedger,
	summary,
	transferOwnership,
	updateTransaction,
	type D1Config,
} from "../src/index.ts";
import { installFakeD1, type FakeD1 } from "./fake-d1.ts";

const USERS = new Set(["ms", "sj", "demo", "eve"]);
const exists = (n: string): boolean => USERS.has(n);

let d1: FakeD1;
let cfg: D1Config;

beforeEach(async () => {
	d1 = installFakeD1();
	cfg = d1.cfg;
	await migrate(cfg);
});
afterEach(() => d1.restore());

/** 기대한 상태 코드의 LedgerAccessError 인지 */
async function rejects(p: Promise<unknown>, status: number, msg?: RegExp): Promise<void> {
	await assert.rejects(p, (err: unknown) => {
		assert.ok(err instanceof LedgerAccessError, `LedgerAccessError 가 아님: ${String(err)}`);
		assert.equal(err.status, status, err.message);
		if (msg) assert.match(err.message, msg);
		return true;
	});
}

const tx = (amount: number, category = "식비", member = "ms") => ({
	date: "2026-09-10",
	amount,
	type: "expense" as const,
	category,
	member,
});

/** ms 의 "우리집" 에 sj 를 초대·수락시킨 상태 */
async function household(): Promise<string> {
	const home = await createLedger(cfg, "ms", "우리집");
	const inv = await inviteMember(cfg, "ms", home.id, "sj", exists);
	await respondInvite(cfg, "sj", inv.id, true);
	return home.id;
}

describe("마이그레이션", () => {
	it("여러 번 돌려도 안전하다", async () => {
		const again = await migrate(cfg);
		assert.deepEqual(again.applied, []);
	});

	it("가계부 분리 이전 데이터(ledger_id 없음)는 어느 가계부에도 보이지 않는다", async () => {
		// 0005 까지만 적용된 DB 에 구 데이터가 있던 상황을 재현한다
		const old = installFakeD1();
		try {
			const { MIGRATIONS } = await import("../src/schema.ts");
			for (const m of MIGRATIONS.filter((m) => m.id < "0006")) old.db.exec(m.sql);
			old.db.exec(
				"CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);" +
					MIGRATIONS.filter((m) => m.id < "0006")
						.map((m) => `INSERT INTO _migrations VALUES ('${m.id}', 'x');`)
						.join(""),
			);
			old.db.exec(
				"INSERT INTO transactions (id, date, amount, currency, source, created_at, member) VALUES ('old1', '2026-09-01', -5000, 'KRW', 'manual', 'x', 'ms');" +
					"INSERT INTO budgets (month, category, limit_amt) VALUES ('2026-09', '식비', 300000);",
			);
			const r = await migrate(old.cfg);
			assert.deepEqual(r.applied, ["0006_ledgers", "0007_accounts", "0008_mcp_servers"]);

			const mine = await createLedger(old.cfg, "ms", "새 가계부");
			assert.equal((await listTransactions(old.cfg, mine.id)).length, 0);
			assert.equal((await budgetStatus(old.cfg, mine.id, "2026-09")).length, 0);
			// 지워지지는 않았다 — 수동으로 옮길 수 있게 남긴다
			assert.equal(old.db.prepare("SELECT COUNT(*) n FROM budgets_legacy").get()?.n, 1);
			assert.equal(old.db.prepare("SELECT COUNT(*) n FROM transactions WHERE ledger_id IS NULL").get()?.n, 1);
		} finally {
			old.restore(); // fetch 를 바깥 테스트의 가짜 D1 로 되돌린다
		}
	});
});

describe("가계부 만들기·고르기", () => {
	it("만든 사람이 소유자이고, 첫 가계부는 기본 가계부가 된다", async () => {
		const a = await createLedger(cfg, "ms", "  우리집  ");
		await createLedger(cfg, "ms", "개인");
		const mine = await listMyLedgers(cfg, "ms");
		assert.deepEqual(
			mine.map((l) => [l.name, l.role, l.isDefault, l.memberCount]),
			[
				["우리집", "owner", true, 1],
				["개인", "owner", false, 1],
			],
		);
		assert.equal((await resolveLedger(cfg, "ms")).id, a.id);
	});

	it("이름은 비울 수 없고 30자를 넘을 수 없다", async () => {
		await rejects(createLedger(cfg, "ms", "   "), 400);
		await rejects(createLedger(cfg, "ms", "가".repeat(31)), 400);
	});

	it("가계부가 하나도 없으면 처음 쓸 때 개인 가계부를 만들어 준다", async () => {
		const l = await resolveLedger(cfg, "demo");
		assert.equal(l.name, "demo의 가계부");
		assert.equal(l.role, "owner");
		assert.equal((await listMyLedgers(cfg, "demo")).length, 1);
		// 두 번째 호출은 새로 만들지 않는다
		assert.equal((await resolveLedger(cfg, "demo")).id, l.id);
	});

	it("처음 화면을 열 때처럼 동시에 불려도 개인 가계부는 하나만 생긴다", async () => {
		const got = await Promise.all([1, 2, 3, 4, 5].map(() => resolveLedger(cfg, "demo")));
		assert.equal(new Set(got.map((l) => l.id)).size, 1);
		assert.equal((await listMyLedgers(cfg, "demo")).length, 1);
	});

	it("개인 가계부를 넘기고 나간 뒤에는 그 가계부로 되돌아가지 않는다", async () => {
		const first = await resolveLedger(cfg, "ms");
		const inv = await inviteMember(cfg, "ms", first.id, "sj", exists);
		await respondInvite(cfg, "sj", inv.id, true);
		await transferOwnership(cfg, "ms", first.id, "sj");
		await removeMember(cfg, "ms", first.id, "ms");

		const next = await resolveLedger(cfg, "ms");
		assert.notEqual(next.id, first.id);
		assert.equal(next.role, "owner");
		await rejects(resolveLedger(cfg, "ms", first.id), 404);
		assert.equal((await resolveLedger(cfg, "sj", first.id)).role, "owner");
	});

	it("이름 또는 id 로 고른다 (대소문자 무시), 없으면 내 가계부 목록을 알려준다", async () => {
		const a = await createLedger(cfg, "ms", "Home");
		assert.equal((await resolveLedger(cfg, "ms", "home")).id, a.id);
		assert.equal((await resolveLedger(cfg, "ms", a.id)).id, a.id);
		await rejects(resolveLedger(cfg, "ms", "회사"), 404, /"Home"/);
	});

	it("이름이 겹치면 추측하지 않는다", async () => {
		await createLedger(cfg, "ms", "생활비");
		const home = await createLedger(cfg, "sj", "생활비");
		const inv = await inviteMember(cfg, "sj", home.id, "ms", exists);
		await respondInvite(cfg, "ms", inv.id, true);
		await rejects(resolveLedger(cfg, "ms", "생활비"), 409);
	});

	it("기본 가계부를 바꿀 수 있고, 멤버가 아닌 가계부는 기본으로 지정할 수 없다", async () => {
		await createLedger(cfg, "ms", "A");
		const b = await createLedger(cfg, "ms", "B");
		await setDefaultLedger(cfg, "ms", b.id);
		assert.equal((await resolveLedger(cfg, "ms")).id, b.id);
		await rejects(setDefaultLedger(cfg, "eve", b.id), 404);
	});

	it("기본이 없고 가계부가 여럿이면 고르라고 한다", async () => {
		const a = await createLedger(cfg, "ms", "A");
		await createLedger(cfg, "ms", "B");
		d1.db.prepare("UPDATE user_prefs SET default_ledger_id = NULL").run();
		await rejects(resolveLedger(cfg, "ms"), 409, /A.*B/);
		assert.ok(a.id);
	});
});

describe("격리 — 남의 가계부에 닿을 수 없다", () => {
	it("멤버가 아니면 id 를 알아도 고를 수 없다 (404 — 존재 여부를 흘리지 않는다)", async () => {
		const home = await createLedger(cfg, "ms", "우리집");
		await rejects(resolveLedger(cfg, "eve", home.id), 404);
		await rejects(listMembers(cfg, "eve", home.id), 404);
		await rejects(listLedgerInvites(cfg, "eve", home.id), 404);
	});

	it("거래 id 만으로는 남의 가계부 거래를 찾지 못한다", async () => {
		const home = await createLedger(cfg, "ms", "우리집");
		const t = await addTransaction(cfg, home.id, tx(5000));
		assert.equal(await ledgerOfTransaction(cfg, "ms", t.id), home.id);
		assert.equal(await ledgerOfTransaction(cfg, "eve", t.id), null);
	});

	it("다른 가계부 id 로는 수정·삭제가 되지 않는다", async () => {
		const home = await createLedger(cfg, "ms", "우리집");
		const evil = await createLedger(cfg, "eve", "내꺼");
		const t = await addTransaction(cfg, home.id, tx(5000));

		await assert.rejects(updateTransaction(cfg, evil.id, t.id, { amount: 1 }), /찾을 수 없습니다/);
		assert.equal(await deleteTransaction(cfg, evil.id, t.id), false);
		assert.equal((await listTransactions(cfg, home.id))[0]?.amount, -5000);
	});

	it("목록·집계·예산·내보내기가 가계부별로 나뉜다", async () => {
		const a = await createLedger(cfg, "ms", "A");
		const b = await createLedger(cfg, "ms", "B");
		await addTransaction(cfg, a.id, tx(10_000));
		await addTransaction(cfg, b.id, tx(99_000));
		await setBudget(cfg, a.id, { month: "2026-09", category: "식비", limit_amt: 50_000 });
		await setBudget(cfg, b.id, { month: "2026-09", category: "식비", limit_amt: 70_000 });

		assert.deepEqual((await listTransactions(cfg, a.id)).map((t) => t.amount), [-10_000]);
		const s = await summary(cfg, a.id, { from: "2026-09-01", to: "2026-09-30" });
		assert.equal(s[0]?.expense, 10_000);

		// 같은 월·카테고리 예산이 가계부마다 따로 있고, 소진액도 자기 가계부 지출만 센다
		const bs = await budgetStatus(cfg, a.id, "2026-09");
		assert.deepEqual(
			bs.map((r) => [r.limit_amt, r.spent]),
			[[50_000, 10_000]],
		);
		const ex = await exportAll(cfg, a.id);
		assert.equal(ex.transactions.length, 1);
		assert.deepEqual(ex.budgets, [{ month: "2026-09", category: "식비", limit_amt: 50_000 }]);
	});
});

describe("초대", () => {
	it("수락하면 멤버가 되어 같은 가계부를 읽고 쓴다", async () => {
		const home = await createLedger(cfg, "ms", "우리집");
		await addTransaction(cfg, home.id, tx(5000, "식비", "ms"));
		const inv = await inviteMember(cfg, "ms", home.id, "sj", exists);

		const incoming = await listIncomingInvites(cfg, "sj");
		assert.deepEqual(
			incoming.map((i) => [i.ledger_name, i.inviter, i.status]),
			[["우리집", "ms", "pending"]],
		);

		await respondInvite(cfg, "sj", inv.id, true);
		const l = await resolveLedger(cfg, "sj"); // 첫 가계부 → 기본
		assert.equal(l.id, home.id);
		assert.equal(l.role, "member");
		await addTransaction(cfg, home.id, tx(3000, "교통", "sj"));
		assert.equal((await listTransactions(cfg, home.id)).length, 2);
		assert.deepEqual(
			(await listMembers(cfg, "sj", home.id)).map((m) => [m.member, m.role]),
			[
				["ms", "owner"],
				["sj", "member"],
			],
		);
		assert.equal((await listIncomingInvites(cfg, "sj")).length, 0);
	});

	it("거절하면 멤버가 되지 않는다", async () => {
		const home = await createLedger(cfg, "ms", "우리집");
		const inv = await inviteMember(cfg, "ms", home.id, "sj", exists);
		await respondInvite(cfg, "sj", inv.id, false);
		await rejects(resolveLedger(cfg, "sj", home.id), 404);
	});

	it("소유자만 초대할 수 있다", async () => {
		const id = await household();
		await rejects(inviteMember(cfg, "sj", id, "demo", exists), 403);
		await rejects(inviteMember(cfg, "eve", id, "demo", exists), 404);
	});

	it("없는 사용자·자기 자신·이미 멤버·중복 대기는 막는다", async () => {
		const id = await household();
		await rejects(inviteMember(cfg, "ms", id, "nobody", exists), 404);
		await rejects(inviteMember(cfg, "ms", id, "ms", exists), 400);
		await rejects(inviteMember(cfg, "ms", id, "sj", exists), 409, /이미 멤버/);
		await inviteMember(cfg, "ms", id, "demo", exists);
		await rejects(inviteMember(cfg, "ms", id, "demo", exists), 409, /대기 중/);
	});

	it("다른 사람 앞으로 온 초대는 수락할 수 없다", async () => {
		const home = await createLedger(cfg, "ms", "우리집");
		const inv = await inviteMember(cfg, "ms", home.id, "sj", exists);
		await rejects(respondInvite(cfg, "eve", inv.id, true), 404);
		await rejects(resolveLedger(cfg, "eve", home.id), 404);
	});

	it("한 번 처리한 초대는 다시 쓸 수 없다", async () => {
		const home = await createLedger(cfg, "ms", "우리집");
		const inv = await inviteMember(cfg, "ms", home.id, "sj", exists);
		await respondInvite(cfg, "sj", inv.id, false);
		await rejects(respondInvite(cfg, "sj", inv.id, true), 404);
	});

	it("취소한 초대는 수락할 수 없고, 취소는 소유자만 한다", async () => {
		const id = await household();
		const inv = await inviteMember(cfg, "ms", id, "demo", exists);
		await rejects(revokeInvite(cfg, "sj", inv.id), 404); // 멤버라도 소유자가 아니면
		await revokeInvite(cfg, "ms", inv.id);
		await rejects(respondInvite(cfg, "demo", inv.id, true), 404);
		assert.equal((await listLedgerInvites(cfg, "ms", id)).length, 0);
	});

	it("만료된 초대는 수락할 수 없고, 같은 사람에게 다시 보낼 수 있다", async () => {
		const home = await createLedger(cfg, "ms", "우리집");
		const inv = await inviteMember(cfg, "ms", home.id, "sj", exists);
		d1.db.prepare("UPDATE ledger_invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(inv.id);

		await rejects(respondInvite(cfg, "sj", inv.id, true), 404);
		assert.equal((await listIncomingInvites(cfg, "sj")).length, 0);
		const again = await inviteMember(cfg, "ms", home.id, "sj", exists);
		await respondInvite(cfg, "sj", again.id, true);
		assert.equal((await resolveLedger(cfg, "sj", home.id)).role, "member");
	});

	it("거절당한 뒤 다시 초대할 수 있다", async () => {
		const home = await createLedger(cfg, "ms", "우리집");
		const inv = await inviteMember(cfg, "ms", home.id, "sj", exists);
		await respondInvite(cfg, "sj", inv.id, false);
		await inviteMember(cfg, "ms", home.id, "sj", exists);
		assert.equal((await listIncomingInvites(cfg, "sj")).length, 1);
	});

	it("수락해도 이미 정한 기본 가계부는 바뀌지 않는다", async () => {
		const own = await createLedger(cfg, "sj", "내 가계부");
		const home = await createLedger(cfg, "ms", "우리집");
		const inv = await inviteMember(cfg, "ms", home.id, "sj", exists);
		await respondInvite(cfg, "sj", inv.id, true);
		assert.equal((await resolveLedger(cfg, "sj")).id, own.id);
	});
});

describe("멤버 관리", () => {
	it("내보낸 멤버는 접근을 잃고, 그 사람이 쓴 기록은 남는다", async () => {
		const id = await household();
		const t = await addTransaction(cfg, id, tx(3000, "교통", "sj"));
		await removeMember(cfg, "ms", id, "sj");

		await rejects(resolveLedger(cfg, "sj", id), 404);
		assert.equal(await ledgerOfTransaction(cfg, "sj", t.id), null);
		const rows = await listTransactions(cfg, id);
		assert.equal(rows[0]?.member, "sj");
		// 기본 가계부였다면 풀린다 — 다음 사용 때 개인 가계부가 만들어진다
		assert.equal((await resolveLedger(cfg, "sj")).name, "sj의 가계부");
	});

	it("멤버는 남을 내보낼 수 없고, 스스로 나갈 수는 있다", async () => {
		const id = await household();
		await rejects(removeMember(cfg, "sj", id, "ms"), 403);
		await removeMember(cfg, "sj", id, "sj");
		await rejects(resolveLedger(cfg, "sj", id), 404);
	});

	it("소유자는 나갈 수 없다 (주인 없는 가계부를 만들지 않는다)", async () => {
		const id = await household();
		await rejects(removeMember(cfg, "ms", id, "ms"), 400, /소유권/);
	});

	it("소유권을 넘기면 역할이 바뀐다 — 멤버에게만 넘길 수 있다", async () => {
		const id = await household();
		await rejects(transferOwnership(cfg, "ms", id, "demo"), 400);
		await rejects(transferOwnership(cfg, "sj", id, "sj"), 403);
		await transferOwnership(cfg, "ms", id, "sj");

		assert.equal((await resolveLedger(cfg, "sj", id)).role, "owner");
		assert.equal((await resolveLedger(cfg, "ms", id)).role, "member");
		await rejects(renameLedger(cfg, "ms", id, "x"), 403);
		await removeMember(cfg, "ms", id, "ms"); // 이제 나갈 수 있다
	});

	it("이름 변경은 소유자만", async () => {
		const id = await household();
		await rejects(renameLedger(cfg, "sj", id, "바꿈"), 403);
		assert.equal((await renameLedger(cfg, "ms", id, "바꿈")).name, "바꿈");
	});
});

describe("가계부 삭제", () => {
	it("이름을 정확히 입력해야 하고, 소유자만 할 수 있다", async () => {
		const id = await household();
		await rejects(deleteLedger(cfg, "ms", id, "우리 집"), 400);
		await rejects(deleteLedger(cfg, "sj", id, "우리집"), 403);
	});

	it("거래·예산·초대·멤버를 모두 지우고, 멤버들의 기본 설정도 푼다", async () => {
		const id = await household();
		await addTransaction(cfg, id, tx(1000));
		await setBudget(cfg, id, { month: "2026-09", category: "식비", limit_amt: 1000 });
		await inviteMember(cfg, "ms", id, "demo", exists);
		await deleteLedger(cfg, "ms", id, "우리집");

		for (const t of ["ledgers", "ledger_members", "ledger_invites", "transactions", "budgets"]) {
			assert.equal(d1.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get()?.n, 0, t);
		}
		assert.equal(d1.db.prepare("SELECT COUNT(*) n FROM user_prefs WHERE default_ledger_id IS NOT NULL").get()?.n, 0);
		assert.equal((await listIncomingInvites(cfg, "demo")).length, 0);
	});

	it("삭제된 가계부의 초대는 수락해도 멤버가 되지 않는다", async () => {
		const home = await createLedger(cfg, "ms", "우리집");
		const inv = await inviteMember(cfg, "ms", home.id, "sj", exists);
		// 초대 행은 남기고 가계부만 사라진 경합 상황
		d1.db.prepare("DELETE FROM ledgers WHERE id = ?").run(home.id);
		await rejects(respondInvite(cfg, "sj", inv.id, true), 404);
		assert.equal(d1.db.prepare("SELECT COUNT(*) n FROM ledger_members WHERE member = 'sj'").get()?.n, 0);
	});
});
