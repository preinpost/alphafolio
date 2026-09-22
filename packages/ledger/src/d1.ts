/**
 * Cloudflare D1 REST 클라이언트 — 의존성 0 (fetch만 사용).
 *
 * Workers 바인딩도 wrangler도 필요 없다. 어디서든 HTTPS로 호출한다.
 *   POST /client/v4/accounts/{account_id}/d1/database/{database_id}/query
 *   body: { sql, params }   auth: Authorization: Bearer <token>
 *
 * 무료 한도: 5M행 읽기/일, 10만행 쓰기/일, 5GB (가계부에는 과잉).
 * Time Travel 복구는 무료 7일뿐이므로 별도 export가 필요하다 (repo.exportAll).
 */

const API_BASE = "https://api.cloudflare.com/client/v4";

export interface D1Config {
	accountId: string;
	databaseId: string;
	token: string;
}

export interface D1Meta {
	duration?: number;
	rows_read?: number;
	rows_written?: number;
	last_row_id?: number;
	changes?: number;
}

export interface D1Result<T = Record<string, unknown>> {
	results: T[];
	success: boolean;
	meta: D1Meta;
}

export type D1Param = string | number | null;

export class D1Error extends Error {
	readonly status: number;
	readonly errors: Array<{ code?: number; message?: string }>;
	readonly sql: string;

	constructor(message: string, opts: { status: number; errors?: Array<{ code?: number; message?: string }>; sql: string }) {
		super(message);
		this.name = "D1Error";
		this.status = opts.status;
		this.errors = opts.errors ?? [];
		this.sql = opts.sql;
	}
}

/** env에서 D1 설정을 읽는다. 누락 시 무엇을 설정해야 하는지 알려주고 throw. */
export function d1ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): D1Config {
	const accountId = env.AF_D1_ACCOUNT_ID;
	const databaseId = env.AF_D1_DATABASE_ID;
	const token = env.AF_D1_TOKEN;

	const missing: string[] = [];
	if (!accountId) missing.push("AF_D1_ACCOUNT_ID");
	if (!databaseId) missing.push("AF_D1_DATABASE_ID");
	if (!token) missing.push("AF_D1_TOKEN");

	if (missing.length > 0) {
		throw new Error(
			`D1 설정이 없습니다: ${missing.join(", ")}\n` +
				`  1) Cloudflare 대시보드 → Storage & Databases → D1 → 데이터베이스 생성\n` +
				`  2) My Profile → API Tokens → Create Token → D1 Edit 권한\n` +
				`  3) .env 에 위 변수를 채운다 (.env.example 참고)`,
		);
	}
	// missing 검사를 통과했으므로 세 값 모두 존재한다.
	return { accountId: accountId as string, databaseId: databaseId as string, token: token as string };
}

interface CloudflareEnvelope<T> {
	success: boolean;
	errors?: Array<{ code?: number; message?: string }>;
	messages?: unknown[];
	result?: T;
}

async function post<T>(cfg: D1Config, path: string, body: unknown, sqlForError: string): Promise<T> {
	const res = await fetch(`${API_BASE}/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${cfg.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	let envelope: CloudflareEnvelope<T>;
	const text = await res.text();
	try {
		envelope = JSON.parse(text) as CloudflareEnvelope<T>;
	} catch {
		throw new D1Error(`D1 응답을 파싱할 수 없습니다 (HTTP ${res.status}): ${text.slice(0, 200)}`, {
			status: res.status,
			sql: sqlForError,
		});
	}

	if (!res.ok || !envelope.success) {
		const detail = (envelope.errors ?? []).map((e) => `[${e.code ?? "?"}] ${e.message ?? ""}`).join(", ");
		throw new D1Error(`D1 요청 실패 (HTTP ${res.status}): ${detail || text.slice(0, 200)}`, {
			status: res.status,
			errors: envelope.errors,
			sql: sqlForError,
		});
	}

	return envelope.result as T;
}

/**
 * 단일 SQL 실행 (파라미터 바인딩).
 *
 * ⚠️ sql은 반드시 코드에 있는 리터럴이어야 한다. LLM이 만든 SQL을 그대로 넘기지 않는다
 *    (PLAN.md §7.2 — raw SQL 툴 금지). 사용자 입력은 전부 params로 전달한다.
 */
export async function d1Query<T = Record<string, unknown>>(
	cfg: D1Config,
	sql: string,
	params: D1Param[] = [],
): Promise<D1Result<T>> {
	const result = await post<Array<D1Result<T>>>(cfg, "/query", { sql, params }, sql);
	const first = result[0];
	if (!first) {
		throw new D1Error("D1이 빈 결과 배열을 반환했습니다", { status: 200, sql });
	}
	return first;
}

/** 다중 statement 실행 (마이그레이션용 — 파라미터 없음). */
export async function d1Exec(cfg: D1Config, sql: string): Promise<Array<D1Result>> {
	return post<Array<D1Result>>(cfg, "/query", { sql }, sql);
}

/**
 * 연결 확인 — 성공하면 응답 소요시간(ms)을 돌려준다.
 *
 * ⚠️ D1은 `sqlite_version()` 같은 일부 내장 함수를 차단한다
 *    ("not authorized to use function", SQLITE_ERROR 7500).
 *    순수 SQLite가 아니므로 시스템 함수 의존을 피한다.
 */
export async function d1Ping(cfg: D1Config): Promise<number> {
	const r = await d1Query<{ ok: number }>(cfg, "SELECT 1 AS ok");
	if (r.results[0]?.ok !== 1) throw new D1Error("ping 응답이 예상과 다릅니다", { status: 200, sql: "SELECT 1" });
	return r.meta.duration ?? 0;
}
