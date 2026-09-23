/**
 * 계정 — env 슈퍼관리자 + 초대 코드로 가입한 D1 계정 (PLAN §25).
 *
 *   env 계정 (AF_USERS · AF_AUTH_USER)  슈퍼관리자. 비밀번호는 서버 env 로만 바꾼다. 앱에서 비활성화할 수 없다.
 *   D1 계정 (users 테이블)              가입한 사용자. 비밀번호 변경·모든 기기 로그아웃 가능, 관리자가 비활성화.
 *
 * 가입은 관리자가 발급한 **1회용 초대 코드**로만 된다. 서버의 LLM 키·D1 을 쓰게 되므로 아무나 가입하면 안 된다.
 *
 * 인증 경로가 동기(모든 REST 요청·WS 명령)라서 D1 계정은 메모리에 올려두고 쓴다 (가족 규모).
 * 변경은 전부 이 클래스를 거치므로 캐시와 D1 이 어긋나지 않는다 — 컨테이너 한 개 전제.
 */
import { createHash, randomInt } from "node:crypto";
import { d1Query, ensureMigrated, ulid, type D1Config } from "@alphafolio/ledger";
import { authenticate as authenticateEnv, hashPassword, hasUser as hasEnvUser, verifyHash, type UserDirectory } from "./users.ts";

export const NAME_RE = /^[a-z0-9_]{3,20}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
/** 헷갈리는 글자(0·O·1·I)를 뺀 32자 — 12자리 = 60비트 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 12;
export const INVITE_DAYS_DEFAULT = 7;
export const INVITE_DAYS_MAX = 30;
/** 시스템 이름·다른 기능과 헷갈릴 이름 */
const RESERVED = new Set(["admin", "root", "system", "alphafolio", "support", "null", "undefined", "spike"]);

export class AccountError extends Error {
	readonly status: 400 | 403 | 404 | 409;
	constructor(status: 400 | 403 | 404 | 409, message: string) {
		super(message);
		this.name = "AccountError";
		this.status = status;
	}
}

interface DbUser {
	name: string;
	password_hash: string;
	token_version: number;
	invited_by: string | null;
	created_at: string;
	disabled_at: string | null;
}

export interface AccountRow {
	name: string;
	source: "env" | "db";
	admin: boolean;
	invitedBy: string | null;
	createdAt: string | null;
	disabled: boolean;
}

export interface InviteRow {
	id: string;
	note: string | null;
	createdBy: string;
	createdAt: string;
	expiresAt: string;
	usedBy: string | null;
	usedAt: string | null;
	revokedAt: string | null;
	status: "pending" | "used" | "expired" | "revoked";
}

/** 입력한 코드를 비교 가능한 형태로 — 대소문자·공백·하이픈 무시 */
export function normalizeCode(raw: string): string {
	return raw.toUpperCase().replace(/[\s-]/g, "");
}

export function hashCode(raw: string): string {
	return createHash("sha256").update(normalizeCode(raw)).digest("hex");
}

/** XXXX-XXXX-XXXX */
export function generateCode(): string {
	const chars = Array.from({ length: CODE_LEN }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
	return chars.match(/.{4}/g)?.join("-") ?? chars;
}

export function checkPassword(password: string): void {
	if (password.length < PASSWORD_MIN) throw new AccountError(400, `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다`);
	// scrypt 는 입력 길이에 비례해 느려진다 — 거대한 문자열로 서버를 묶지 못하게
	if (password.length > PASSWORD_MAX) throw new AccountError(400, `비밀번호는 ${PASSWORD_MAX}자 이하여야 합니다`);
}

export class AccountStore {
	private readonly provider: () => D1Config;
	private readonly env: UserDirectory;
	private readonly now: () => number;
	private readonly db = new Map<string, DbUser>();
	private loaded = false;

	constructor(provider: () => D1Config, env: UserDirectory, now: () => number = Date.now) {
		this.provider = provider;
		this.env = env;
		this.now = now;
	}

	private async cfg(): Promise<D1Config> {
		const cfg = this.provider();
		await ensureMigrated(cfg);
		return cfg;
	}

	/** 기동 시 D1 계정을 올린다. D1 이 없으면 env 계정만으로 동작한다 (가입은 꺼진다). */
	async load(): Promise<void> {
		const r = await d1Query<DbUser>(await this.cfg(), "SELECT * FROM users");
		this.db.clear();
		for (const u of r.results) this.db.set(u.name, { ...u, token_version: Number(u.token_version) });
		this.loaded = true;
	}

	get ready(): boolean {
		return this.loaded;
	}

	isAdmin(name: string): boolean {
		return hasEnvUser(this.env, name);
	}

	sourceOf(name: string): "env" | "db" | null {
		if (hasEnvUser(this.env, name)) return "env";
		return this.db.has(name) ? "db" : null;
	}

	/** 로그인 가능한 계정인가 (비활성화 제외) */
	has(name: string): boolean {
		if (hasEnvUser(this.env, name)) return true;
		const u = this.db.get(name);
		return u !== undefined && u.disabled_at === null;
	}

	/** 토큰이 아직 유효한 계정·버전인가. env 계정은 버전이 늘 0 (env 로만 관리). */
	accepts(name: string, version: number | undefined): boolean {
		if (!this.has(name)) return false;
		return this.tokenVersion(name) === (version ?? 0);
	}

	tokenVersion(name: string): number {
		return this.db.get(name)?.token_version ?? 0;
	}

	/** 활성 계정 이름 전부 — 스냅샷 스케줄러 등 */
	names(): string[] {
		return [...this.env.users.map((u) => u.name), ...[...this.db.values()].filter((u) => !u.disabled_at).map((u) => u.name)];
	}

	/** 비밀번호 확인 — 성공하면 이름. 없는 계정도 같은 비용을 치른다 (타이밍으로 존재 여부가 새지 않게). */
	authenticate(name: string, password: string): string | null {
		if (hasEnvUser(this.env, name)) return authenticateEnv(this.env, name, password);
		const u = this.db.get(name);
		if (!u || u.disabled_at) {
			hashPassword(password);
			return null;
		}
		return verifyHash(password, u.password_hash) ? u.name : null;
	}

	// ── 가입 ────────────────────────────────────────────────────────────

	/**
	 * 초대 코드로 가입. 코드는 **먼저 선점**하고 계정을 만든다 — 같은 코드로 둘이 동시에 가입하지 못하게.
	 * 계정 생성이 실패하면(이름이 그 사이 선점됨) 코드를 되돌려 다시 쓸 수 있게 한다.
	 */
	async signup(input: { code: string; name: string; password: string }): Promise<string> {
		const name = input.name.trim();
		if (!NAME_RE.test(name)) throw new AccountError(400, "ID 는 영문 소문자·숫자·_ 3~20자여야 합니다");
		if (RESERVED.has(name)) throw new AccountError(409, "사용할 수 없는 ID 입니다");
		checkPassword(input.password);
		if (this.sourceOf(name)) throw new AccountError(409, "이미 있는 ID 입니다");

		const cfg = await this.cfg();
		const at = new Date(this.now()).toISOString();
		const codeHash = hashCode(input.code);
		const claimed = await d1Query(
			cfg,
			`UPDATE signup_invites SET used_by = ?, used_at = ?
			 WHERE code_hash = ? AND used_by IS NULL AND revoked_at IS NULL AND expires_at > ?`,
			[name, at, codeHash, at],
		);
		// 없음·사용됨·만료·취소를 구분하지 않는다 — 코드를 추측하는 쪽에 힌트를 주지 않게
		if ((claimed.meta.changes ?? 0) !== 1) throw new AccountError(403, "초대 코드가 올바르지 않거나 이미 사용·만료됐습니다");

		const inviter = await d1Query<{ created_by: string }>(cfg, "SELECT created_by FROM signup_invites WHERE code_hash = ?", [
			codeHash,
		]);
		const user: DbUser = {
			name,
			password_hash: hashPassword(input.password),
			token_version: 0,
			invited_by: inviter.results[0]?.created_by ?? null,
			created_at: at,
			disabled_at: null,
		};
		try {
			await d1Query(
				cfg,
				"INSERT INTO users (name, password_hash, token_version, invited_by, created_at) VALUES (?, ?, 0, ?, ?)",
				[user.name, user.password_hash, user.invited_by, user.created_at],
			);
		} catch (err) {
			await d1Query(cfg, "UPDATE signup_invites SET used_by = NULL, used_at = NULL WHERE code_hash = ? AND used_by = ?", [
				codeHash,
				name,
			]);
			if (/UNIQUE/i.test(String((err as Error)?.message))) throw new AccountError(409, "이미 있는 ID 입니다");
			throw err;
		}
		this.db.set(name, user);
		return name;
	}

	// ── 내 계정 ─────────────────────────────────────────────────────────

	/** 비밀번호 변경 — 다른 기기의 로그인은 전부 끊긴다. 새 토큰 버전을 돌려준다. */
	async changePassword(name: string, current: string, next: string): Promise<number> {
		const u = this.db.get(name);
		if (!u) throw new AccountError(400, "서버 설정 계정은 서버 환경변수에서 비밀번호를 바꿉니다");
		if (!verifyHash(current, u.password_hash)) throw new AccountError(403, "현재 비밀번호가 올바르지 않습니다");
		checkPassword(next);
		if (next === current) throw new AccountError(400, "지금과 다른 비밀번호를 입력하세요");
		const hash = hashPassword(next);
		const version = u.token_version + 1;
		await d1Query(await this.cfg(), "UPDATE users SET password_hash = ?, token_version = ? WHERE name = ?", [hash, version, name]);
		u.password_hash = hash;
		u.token_version = version;
		return version;
	}

	/** 모든 기기 로그아웃 — 새 토큰 버전을 돌려준다 (지금 기기는 새 토큰으로 이어간다) */
	async logoutAll(name: string): Promise<number> {
		const u = this.db.get(name);
		if (!u) throw new AccountError(400, "서버 설정 계정은 AF_AUTH_SECRET 을 바꿔야 모든 로그인이 끊깁니다");
		return this.bump(u);
	}

	private async bump(u: DbUser): Promise<number> {
		const version = u.token_version + 1;
		await d1Query(await this.cfg(), "UPDATE users SET token_version = ? WHERE name = ?", [version, u.name]);
		u.token_version = version;
		return version;
	}

	// ── 관리자 ──────────────────────────────────────────────────────────

	private requireAdmin(by: string): void {
		if (!this.isAdmin(by)) throw new AccountError(403, "관리자만 할 수 있습니다");
	}

	/** 초대 코드 발급 — 원문은 이 응답에서만 보인다 */
	async createInvite(by: string, opts: { note?: string; days?: number } = {}): Promise<{ id: string; code: string; expiresAt: string }> {
		this.requireAdmin(by);
		const days = Math.min(Math.max(Math.round(opts.days ?? INVITE_DAYS_DEFAULT), 1), INVITE_DAYS_MAX);
		const note = opts.note?.trim().slice(0, 40) || null;
		const code = generateCode();
		const id = ulid();
		const createdAt = new Date(this.now()).toISOString();
		const expiresAt = new Date(this.now() + days * 86_400_000).toISOString();
		await d1Query(
			await this.cfg(),
			"INSERT INTO signup_invites (id, code_hash, note, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
			[id, hashCode(code), note, by, createdAt, expiresAt],
		);
		return { id, code, expiresAt };
	}

	async listInvites(by: string): Promise<InviteRow[]> {
		this.requireAdmin(by);
		const r = await d1Query<{
			id: string;
			note: string | null;
			created_by: string;
			created_at: string;
			expires_at: string;
			used_by: string | null;
			used_at: string | null;
			revoked_at: string | null;
		}>(await this.cfg(), "SELECT id, note, created_by, created_at, expires_at, used_by, used_at, revoked_at FROM signup_invites ORDER BY created_at DESC LIMIT 100");
		const now = new Date(this.now()).toISOString();
		return r.results.map((i) => ({
			id: i.id,
			note: i.note,
			createdBy: i.created_by,
			createdAt: i.created_at,
			expiresAt: i.expires_at,
			usedBy: i.used_by,
			usedAt: i.used_at,
			revokedAt: i.revoked_at,
			status: i.used_by ? "used" : i.revoked_at ? "revoked" : i.expires_at <= now ? "expired" : "pending",
		}));
	}

	async revokeInvite(by: string, id: string): Promise<void> {
		this.requireAdmin(by);
		const r = await d1Query(
			await this.cfg(),
			"UPDATE signup_invites SET revoked_at = ? WHERE id = ? AND used_by IS NULL AND revoked_at IS NULL",
			[new Date(this.now()).toISOString(), id],
		);
		if ((r.meta.changes ?? 0) !== 1) throw new AccountError(404, "취소할 초대 코드가 없습니다 (이미 사용·취소됨)");
	}

	listAccounts(by: string): AccountRow[] {
		this.requireAdmin(by);
		const env: AccountRow[] = this.env.users.map((u) => ({
			name: u.name,
			source: "env",
			admin: true,
			invitedBy: null,
			createdAt: null,
			disabled: false,
		}));
		const db: AccountRow[] = [...this.db.values()]
			.sort((a, b) => a.created_at.localeCompare(b.created_at))
			.map((u) => ({
				name: u.name,
				source: "db",
				admin: false,
				invitedBy: u.invited_by,
				createdAt: u.created_at,
				disabled: u.disabled_at !== null,
			}));
		return [...env, ...db];
	}

	/**
	 * 임시 비밀번호 발급 — 비밀번호를 잊은 사용자용 (메일이 없으므로 관리자가 전달한다).
	 * 기존 로그인은 전부 끊긴다. 받은 사람은 로그인 후 설정에서 바꾸면 된다.
	 */
	async resetPassword(by: string, name: string): Promise<string> {
		this.requireAdmin(by);
		const u = this.db.get(name);
		if (!u) throw new AccountError(404, hasEnvUser(this.env, name) ? "서버 설정 계정은 여기서 바꿀 수 없습니다" : "없는 계정입니다");
		const temp = generateCode().toLowerCase(); // 14자 — 최소 길이를 넘고 전달하기 쉽다
		const hash = hashPassword(temp);
		const version = u.token_version + 1;
		await d1Query(await this.cfg(), "UPDATE users SET password_hash = ?, token_version = ? WHERE name = ?", [hash, version, name]);
		u.password_hash = hash;
		u.token_version = version;
		return temp;
	}

	/**
	 * 비활성화 — 로그인 불가 + 기존 토큰 무효 (토큰 버전을 올린다). 기록(가계부·대화)은 지우지 않는다.
	 * env 계정은 대상이 아니다 (서버 설정으로 관리).
	 */
	async setDisabled(by: string, name: string, disabled: boolean): Promise<void> {
		this.requireAdmin(by);
		const u = this.db.get(name);
		if (!u) throw new AccountError(404, hasEnvUser(this.env, name) ? "서버 설정 계정은 여기서 바꿀 수 없습니다" : "없는 계정입니다");
		const at = disabled ? new Date(this.now()).toISOString() : null;
		const version = disabled ? u.token_version + 1 : u.token_version;
		await d1Query(await this.cfg(), "UPDATE users SET disabled_at = ?, token_version = ? WHERE name = ?", [at, version, name]);
		u.disabled_at = at;
		u.token_version = version;
	}
}
