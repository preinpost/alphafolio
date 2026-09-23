/**
 * 테스트용 D1 — Cloudflare D1 REST 를 node:sqlite(인메모리)로 흉내 낸다.
 *
 * 목(mock)으로 repo 를 대체하지 않고 **fetch 만** 바꾼다. 그래야 실제 SQL(권한 조인·조건부
 * UPDATE·부분 유니크 인덱스)이 그대로 실행된다 — 이 패키지에서 틀리기 쉬운 건 SQL 쪽이다.
 * D1 도 SQLite 라 방언 차이는 거의 없다 (D1 이 막는 sqlite_version() 등은 쓰지 않는다).
 */
import { DatabaseSync } from "node:sqlite";
import type { D1Config } from "../src/d1.ts";

export interface FakeD1 {
	cfg: D1Config;
	db: DatabaseSync;
	restore: () => void;
}

const READS = /^\s*(SELECT|WITH|PRAGMA)\b/i;

export function installFakeD1(): FakeD1 {
	const db = new DatabaseSync(":memory:");
	const realFetch = globalThis.fetch;
	const cfg: D1Config = { accountId: "test", databaseId: `db-${Math.random()}`, token: "t" };

	const reply = (status: number, body: unknown): Response =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		const { sql, params } = JSON.parse(String(init?.body)) as { sql: string; params?: Array<string | number | null> };
		try {
			// params 없는 요청 = 다중 statement (마이그레이션)
			if (params === undefined) {
				db.exec(sql);
				return reply(200, { success: true, result: [{ results: [], success: true, meta: { changes: 0 } }] });
			}
			const stmt = db.prepare(sql);
			if (READS.test(sql)) {
				const rows = stmt.all(...params);
				return reply(200, { success: true, result: [{ results: rows, success: true, meta: { changes: 0 } }] });
			}
			const run = stmt.run(...params);
			return reply(200, {
				success: true,
				result: [{ results: [], success: true, meta: { changes: Number(run.changes) } }],
			});
		} catch (err) {
			return reply(400, { success: false, errors: [{ code: 7500, message: (err as Error).message }] });
		}
	}) as typeof fetch;

	return { cfg, db, restore: () => (globalThis.fetch = realFetch) };
}
