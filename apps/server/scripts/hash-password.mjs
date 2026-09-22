/**
 * 비밀번호 해시 생성 — AF_USERS 에 넣을 값을 만든다.
 *
 *   node apps/server/scripts/hash-password.mjs '비밀번호'
 *   node apps/server/scripts/hash-password.mjs '비번1' '비번2'   # 여러 개
 *
 * 인자로 주면 셸 히스토리에 남으므로, 신경 쓰이면 인자 없이 실행해 입력받는다.
 */
import { createInterface } from "node:readline/promises";
import { hashPassword } from "../src/users.ts";

async function main() {
	let passwords = process.argv.slice(2);

	if (passwords.length === 0) {
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		const one = await rl.question("비밀번호: ");
		rl.close();
		if (!one) {
			console.error("비밀번호가 비어 있습니다.");
			process.exit(1);
		}
		passwords = [one];
	}

	console.log("\nAF_USERS 예시 (name 을 실제 계정명으로 바꾸세요):\n");
	const entries = passwords.map((p, i) => ({
		name: i === 0 ? "user1" : `user${i + 1}`,
		passwordHash: hashPassword(p),
	}));
	console.log(`AF_USERS='${JSON.stringify(entries)}'`);
	console.log("\ncompose.yaml 에 넣을 때는 작은따옴표 안의 JSON만 값으로 사용하세요.\n");
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
