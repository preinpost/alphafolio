/**
 * 비밀번호 해시 — 가입 계정(D1 users)용 scrypt.
 *
 * 슈퍼관리자(AF_ADMIN_USER / AF_ADMIN_PASSWORD)는 env 평문이다 (config.ts). 같은 compose 파일에
 * AF_AUTH_SECRET·D1 토큰이 평문으로 있어 관리자 비밀번호만 해시로 감춰도 막아주는 게 없다 (PLAN §25).
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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
export function safeEqualStr(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) {
		timingSafeEqual(bufA, bufA);
		return false;
	}
	return timingSafeEqual(bufA, bufB);
}
