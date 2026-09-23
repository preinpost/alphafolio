/**
 * 비밀번호 해시 생성 — AF_USERS 에 넣을 값을 만든다.
 *
 *   node apps/server/scripts/hash-password.mjs                         # 입력받기 (셸 히스토리에 안 남는다)
 *   node apps/server/scripts/hash-password.mjs --name alpha '비밀번호'
 *   node apps/server/scripts/hash-password.mjs --name a --name b '비번1' '비번2'
 *
 * compose.yaml 에 바로 붙일 줄과 .env 용 줄을 둘 다 찍는다.
 * ⚠️ compose.yaml 안에서는 $ 가 변수로 해석되므로 해시의 $ 를 $$ 로 적어야 한다 — 여기서 바꿔서 찍는다.
 */
import { createInterface } from "node:readline/promises";
import { hashPassword } from "../src/users.ts";

async function main() {
	const args = process.argv.slice(2);
	const names = [];
	let passwords = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--name") names.push(args[++i]);
		else passwords.push(args[i]);
	}

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

	const entries = passwords.map((p, i) => ({
		name: names[i] ?? (i === 0 ? "admin" : `admin${i + 1}`),
		passwordHash: hashPassword(p),
	}));
	const json = JSON.stringify(entries);

	console.log("\n# compose.yaml (environment 아래) — $ 를 $$ 로 바꿔 두었다");
	console.log(`      AF_USERS: '${json.replaceAll("$", "$$$$")}'`);
	console.log("\n# .env / 셸 export — 작은따옴표 안이라 $ 그대로");
	console.log(`AF_USERS='${json}'`);
	if (names.length < passwords.length) console.log("\n(name 을 --name 으로 주지 않은 항목은 실제 계정명으로 바꾸세요)");
	console.log("");
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
