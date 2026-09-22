/**
 * ULID — 시간순 정렬 가능한 26자 ID (Crockford Base32).
 * 의존성 없이 node:crypto만 사용. UUID와 달리 생성 순서대로 정렬되어
 * 인덱스 지역성이 좋고, 내역 목록의 tie-break 정렬에도 쓸 수 있다.
 */
import { randomBytes } from "node:crypto";

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
	let time = "";
	let t = now;
	for (let i = 0; i < 10; i++) {
		time = ENC[t % 32]! + time;
		t = Math.floor(t / 32);
	}

	let rand = "";
	let bits = 0;
	let value = 0;
	for (const byte of randomBytes(10)) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			rand += ENC[(value >>> bits) & 31]!;
		}
	}

	return time + rand;
}
