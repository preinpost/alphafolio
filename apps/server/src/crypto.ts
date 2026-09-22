/**
 * 값 단위 암호화 — AES-256-GCM.
 *
 * 키는 `AF_AUTH_SECRET` 에서 HKDF 로 파생한다. env 에 남는 시크릿을 마스터 하나로
 * 유지하려는 설계이며, 용도(info)마다 다른 키를 파생해 한 용도의 암호문을
 * 다른 용도로 복호화할 수 없게 한다.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const HKDF_SALT = "alphafolio-secrets-v1";

export function deriveKey(masterSecret: string, info: string): Buffer {
	return Buffer.from(hkdfSync("sha256", Buffer.from(masterSecret), Buffer.from(HKDF_SALT), Buffer.from(info), 32));
}

export function encryptValue(plain: string, key: Buffer): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
	return [iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function decryptValue(blob: string, key: Buffer): string {
	const [ivB64, bodyB64, tagB64] = blob.split(".");
	if (!ivB64 || !bodyB64 || !tagB64) throw new Error("형식이 올바르지 않습니다");
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
	decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
	return Buffer.concat([decipher.update(Buffer.from(bodyB64, "base64url")), decipher.final()]).toString("utf8");
}
