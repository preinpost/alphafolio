/**
 * 사용자 계정 — 한 컨테이너에서 여러 사람이 각자 로그인한다.
 *
 * 계정 목록은 env에 둔다 (DB가 아니라). 로그인해야 설정 화면에 들어갈 수 있는데
 * 그 로그인 정보를 앱에서 관리하면 닭-달걀이 되기 때문이다.
 *
 *   AF_USERS='[{"name":"ms","passwordHash":"scrypt$..."},{"name":"wife","passwordHash":"scrypt$..."}]'
 *
 * 해시 생성:  node apps/server/scripts/hash-password.mjs '비밀번호'
 *
 * 레거시(단일 사용자) 호환: AF_USERS 가 없으면 AF_AUTH_USER/AF_AUTH_PASSWORD 를 평문으로 받는다.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export interface AppUser {
	name: string;
	/** "scrypt$N$r$p$salt$hash" (base64url). 레거시 평문은 passwordPlain 을 쓴다. */
	passwordHash?: string;
	/** 레거시 단일 사용자 경로 전용 — 평문 비교. */
	passwordPlain?: string;
}

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	const key = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
	return [
		"scrypt",
		SCRYPT_N,
		SCRYPT_R,
		SCRYPT_P,
		salt.toString("base64url"),
		key.toString("base64url"),
	].join("$");
}

export function verifyHash(password: string, stored: string): boolean {
	const parts = stored.split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;

	const [, n, r, p, saltB64, keyB64] = parts;
	try {
		const salt = Buffer.from(saltB64 as string, "base64url");
		const expected = Buffer.from(keyB64 as string, "base64url");
		const actual = scryptSync(password, salt, expected.length, {
			N: Number(n),
			r: Number(r),
			p: Number(p),
		});
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

/** 길이가 달라도 예외 없이 false를 돌려주는 상수시간 비교. */
function safeEqualStr(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) {
		timingSafeEqual(bufA, bufA);
		return false;
	}
	return timingSafeEqual(bufA, bufB);
}

export interface UserDirectory {
	users: AppUser[];
	/** 레거시 평문 경로를 쓰고 있는지 (기동 로그에 경고) */
	legacyPlaintext: boolean;
	/** 비밀번호가 없어 자동 생성된 경우의 평문 (기동 로그 출력용) */
	generatedPassword?: string;
}

export function loadUsers(env: NodeJS.ProcessEnv = process.env): UserDirectory {
	const raw = env.AF_USERS?.trim();

	if (raw) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error("AF_USERS 파싱 실패 — JSON 배열이어야 합니다");
		}
		if (!Array.isArray(parsed) || parsed.length === 0) {
			throw new Error("AF_USERS 는 비어 있지 않은 JSON 배열이어야 합니다");
		}

		const users: AppUser[] = parsed.map((u, i) => {
			const o = u as { name?: unknown; passwordHash?: unknown };
			if (typeof o.name !== "string" || !o.name.trim()) {
				throw new Error(`AF_USERS[${i}].name 이 없습니다`);
			}
			if (typeof o.passwordHash !== "string" || !o.passwordHash.startsWith("scrypt$")) {
				throw new Error(`AF_USERS[${i}].passwordHash 가 없거나 형식이 아닙니다 (hash-password.mjs 로 생성)`);
			}
			return { name: o.name.trim(), passwordHash: o.passwordHash };
		});

		const names = new Set(users.map((u) => u.name));
		if (names.size !== users.length) throw new Error("AF_USERS 에 중복된 name 이 있습니다");

		return { users, legacyPlaintext: false };
	}

	// 레거시: 단일 사용자 평문
	const name = env.AF_AUTH_USER?.trim() || "alpha";
	const plain = env.AF_AUTH_PASSWORD?.trim() ?? "";
	const generated = plain === "" ? randomBytes(9).toString("base64url") : undefined;

	return {
		users: [{ name, passwordPlain: generated ?? plain }],
		legacyPlaintext: true,
		generatedPassword: generated,
	};
}

/** 자격증명 검증. 성공하면 사용자 이름, 실패하면 null. */
export function authenticate(dir: UserDirectory, name: string, password: string): string | null {
	const user = dir.users.find((u) => u.name === name);

	// 존재하지 않는 계정도 같은 비용을 치르게 해서 계정 존재 여부가 타이밍으로 새지 않게 한다
	if (!user) {
		hashPassword(password);
		return null;
	}

	if (user.passwordHash) return verifyHash(password, user.passwordHash) ? user.name : null;
	return safeEqualStr(password, user.passwordPlain ?? "") ? user.name : null;
}

export function hasUser(dir: UserDirectory, name: string): boolean {
	return dir.users.some((u) => u.name === name);
}
