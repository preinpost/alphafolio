/**
 * 계정 · 초대 코드 테스트 (PLAN §25).
 *
 * 가입을 여는 순간 모르는 사람이 서버의 LLM 키·D1 을 쓸 수 있게 된다. 초대 코드가 한 번만 쓰이고,
 * 관리자만 발급하며, 끊어야 할 때 기존 토큰이 끊기는지가 핵심이다. 실제 SQL 을 인메모리 SQLite 로 돌린다.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { migrate } from "@alphafolio/ledger";
import { installFakeD1, type FakeD1 } from "../../../packages/ledger/test/fake-d1.ts";
import { AccountError, AccountStore, generateCode, hashCode, normalizeCode } from "../src/accounts.ts";
import { hashPassword, type UserDirectory } from "../src/users.ts";

const ENV: UserDirectory = { users: [{ name: "boss", passwordHash: hashPassword("boss-password-1") }], legacyPlaintext: false };
const PW = "correct-horse-1";

let d1: FakeD1;
let clock: number;
let store: AccountStore;

beforeEach(async () => {
	d1 = installFakeD1();
	await migrate(d1.cfg);
	clock = Date.parse("2026-09-23T00:00:00Z");
	store = new AccountStore(() => d1.cfg, ENV, () => clock);
	await store.load();
});
afterEach(() => d1.restore());

async function rejects(p: Promise<unknown> | (() => unknown), status: number, msg?: RegExp): Promise<void> {
	await assert.rejects(async () => (typeof p === "function" ? p() : p), (err: unknown) => {
		assert.ok(err instanceof AccountError, `AccountError 아님: ${String(err)}`);
		assert.equal(err.status, status, err.message);
		if (msg) assert.match(err.message, msg);
		return true;
	});
}

describe("초대 코드", () => {
	it("형식 XXXX-XXXX-XXXX, 헷갈리는 글자(0·O·1·I) 없음", () => {
		for (let i = 0; i < 200; i++) {
			const c = generateCode();
			assert.match(c, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
			assert.doesNotMatch(c, /[01OI]/);
		}
	});

	it("입력은 대소문자·공백·하이픈을 무시한다", () => {
		assert.equal(normalizeCode(" abcd-efgh jkmn "), "ABCDEFGHJKMN");
		assert.equal(hashCode("abcd-efgh-jkmn"), hashCode("ABCDEFGHJKMN"));
	});

	it("원문은 저장하지 않는다", async () => {
		const { code } = await store.createInvite("boss");
		const dump = JSON.stringify(d1.db.prepare("SELECT * FROM signup_invites").all());
		assert.doesNotMatch(dump, new RegExp(normalizeCode(code)));
		assert.doesNotMatch(dump, new RegExp(code));
	});

	it("관리자(env 계정)만 발급·조회·취소한다", async () => {
		const { code } = await store.createInvite("boss");
		await store.signup({ code, name: "kim", password: PW });
		await rejects(store.createInvite("kim"), 403);
		await rejects(store.listInvites("kim"), 403);
		await rejects(() => store.listAccounts("kim"), 403);
	});
});

describe("가입", () => {
	it("코드 한 개로 한 명만 — 두 번째는 거절", async () => {
		const { code } = await store.createInvite("boss", { note: "동생" });
		assert.equal(await store.signup({ code, name: "kim", password: PW }), "kim");
		await rejects(store.signup({ code, name: "lee", password: PW }), 403);
		const [inv] = await store.listInvites("boss");
		assert.equal(inv?.status, "used");
		assert.equal(inv?.usedBy, "kim");
	});

	it("동시에 같은 코드로 가입해도 한 명만 된다", async () => {
		const { code } = await store.createInvite("boss");
		const results = await Promise.allSettled(
			["aaa", "bbb", "ccc", "ddd"].map((name) => store.signup({ code, name, password: PW })),
		);
		assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
		assert.equal(d1.db.prepare("SELECT COUNT(*) n FROM users").get()?.n, 1);
	});

	it("만료·취소·없는 코드는 같은 문구로 거절한다 (구분 힌트를 주지 않는다)", async () => {
		const expired = await store.createInvite("boss", { days: 1 });
		const revoked = await store.createInvite("boss");
		await store.revokeInvite("boss", revoked.id);
		clock += 2 * 86_400_000;
		const messages = new Set<string>();
		for (const code of [expired.code, revoked.code, "AAAA-BBBB-CCCC"]) {
			await assert.rejects(store.signup({ code, name: "kim", password: PW }), (e: unknown) => {
				assert.ok(e instanceof AccountError && e.status === 403);
				messages.add(e.message);
				return true;
			});
		}
		assert.equal(messages.size, 1);
	});

	it("ID 형식·예약어·중복(env 계정 포함)·비밀번호 길이를 검사하고, 실패해도 코드는 소모되지 않는다", async () => {
		const { code } = await store.createInvite("boss");
		await rejects(store.signup({ code, name: "Kim", password: PW }), 400);
		await rejects(store.signup({ code, name: "ab", password: PW }), 400);
		await rejects(store.signup({ code, name: "admin", password: PW }), 409);
		await rejects(store.signup({ code, name: "boss", password: PW }), 409);
		await rejects(store.signup({ code, name: "kim", password: "short" }), 400);
		await rejects(store.signup({ code, name: "kim", password: "x".repeat(129) }), 400);
		assert.equal(await store.signup({ code, name: "kim", password: PW }), "kim");
	});

	it("가입하면 바로 로그인되고, 누가 초대했는지 남는다", async () => {
		const { code } = await store.createInvite("boss");
		await store.signup({ code, name: "kim", password: PW });
		assert.equal(store.authenticate("kim", PW), "kim");
		assert.equal(store.authenticate("kim", "wrong-password"), null);
		assert.equal(store.listAccounts("boss").find((a) => a.name === "kim")?.invitedBy, "boss");
	});

	it("재시작해도(다시 load) 계정이 남는다", async () => {
		const { code } = await store.createInvite("boss");
		await store.signup({ code, name: "kim", password: PW });
		const fresh = new AccountStore(() => d1.cfg, ENV);
		await fresh.load();
		assert.equal(fresh.authenticate("kim", PW), "kim");
	});

	it("env 계정은 슈퍼관리자, 가입 계정은 일반 사용자", async () => {
		const { code } = await store.createInvite("boss");
		await store.signup({ code, name: "kim", password: PW });
		assert.equal(store.isAdmin("boss"), true);
		assert.equal(store.isAdmin("kim"), false);
		assert.equal(store.authenticate("boss", "boss-password-1"), "boss");
	});
});

describe("토큰 무효화", () => {
	async function member(): Promise<void> {
		const { code } = await store.createInvite("boss");
		await store.signup({ code, name: "kim", password: PW });
	}

	it("비밀번호를 바꾸면 이전 토큰(버전)은 거절된다", async () => {
		await member();
		assert.equal(store.accepts("kim", 0), true);
		const v = await store.changePassword("kim", PW, "new-password-22");
		assert.equal(store.accepts("kim", 0), false);
		assert.equal(store.accepts("kim", v), true);
		assert.equal(store.authenticate("kim", PW), null);
		assert.equal(store.authenticate("kim", "new-password-22"), "kim");
	});

	it("현재 비밀번호가 틀리면 바꾸지 않는다", async () => {
		await member();
		await rejects(store.changePassword("kim", "wrong-pass-00", "new-password-22"), 403);
		assert.equal(store.accepts("kim", 0), true);
	});

	it("모든 기기 로그아웃", async () => {
		await member();
		const v = await store.logoutAll("kim");
		assert.equal(store.accepts("kim", 0), false);
		assert.equal(store.accepts("kim", v), true);
	});

	it("비활성화하면 로그인·기존 토큰 모두 끊기고, 다시 켜도 옛 토큰은 살아나지 않는다", async () => {
		await member();
		await store.setDisabled("boss", "kim", true);
		assert.equal(store.authenticate("kim", PW), null);
		assert.equal(store.accepts("kim", 0), false);
		assert.equal(store.accepts("kim", 1), false);
		await store.setDisabled("boss", "kim", false);
		assert.equal(store.accepts("kim", 0), false, "비활성화 전에 발급된 토큰");
		assert.equal(store.authenticate("kim", PW), "kim");
	});

	it("임시 비밀번호 — 기존 비밀번호·토큰 무효, 새 비밀번호로 로그인", async () => {
		await member();
		const temp = await store.resetPassword("boss", "kim");
		assert.ok(temp.length >= 10);
		assert.equal(store.authenticate("kim", PW), null);
		assert.equal(store.authenticate("kim", temp), "kim");
		assert.equal(store.accepts("kim", 0), false);
	});

	it("env 계정(슈퍼관리자)은 앱에서 비활성화·재설정·비밀번호 변경이 안 된다", async () => {
		await rejects(store.setDisabled("boss", "boss", true), 404);
		await rejects(store.resetPassword("boss", "boss"), 404);
		await rejects(store.changePassword("boss", "boss-password-1", "new-password-22"), 400);
		assert.equal(store.accepts("boss", undefined), true, "버전 없는 옛 토큰도 env 계정은 유효");
	});

	it("일반 사용자는 남을 비활성화·재설정할 수 없다", async () => {
		await member();
		const { code } = await store.createInvite("boss");
		await store.signup({ code, name: "lee", password: PW });
		await rejects(store.setDisabled("kim", "lee", true), 403);
		await rejects(store.resetPassword("kim", "lee"), 403);
	});
});
