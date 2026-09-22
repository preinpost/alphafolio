/**
 * D1 자격증명 진단 — 401/403이 났을 때 원인을 좁힌다.
 *
 * 실행: node spike/00-d1-doctor.ts
 *
 * 시크릿은 절대 전체를 출력하지 않는다 (앞 4자·뒤 2자만 마스킹 표시).
 *
 * 해석 가이드:
 *   - /user/tokens/verify 가 active  → 토큰 문자열 자체는 유효
 *   - /accounts 가 빈 목록           → 정상일 수 있음. 계정 목록 조회에는
 *                                      'Account Settings: Read' 권한이 별도로 필요하다.
 *                                      D1 Edit만 가진 토큰은 스코프가 맞아도 0개로 나온다.
 *   - /d1/database 가 성공           → 계정 ID + D1 권한이 모두 정상 (여기가 진짜 판정)
 *   - /d1/database 가 401/403        → 계정 ID 불일치가 가장 흔하다.
 *                                      Zone ID를 Account ID로 잘못 복사한 경우가 대표적.
 *                                      대시보드 URL dash.cloudflare.com/<ACCOUNT_ID>/... 로 확인.
 */
import { loadEnv } from "./env.ts";

loadEnv();

const accountId = process.env.AF_D1_ACCOUNT_ID ?? "";
const databaseId = process.env.AF_D1_DATABASE_ID ?? "";
const token = process.env.AF_D1_TOKEN ?? "";

const mask = (s: string): string => (s ? `len=${s.length} "${s.slice(0, 4)}…${s.slice(-2)}"` : "(빈값)");
const clean = (s: string): boolean => /^[\w-]+$/.test(s);

interface ApiResult {
	status: number;
	body: { success?: boolean; result?: unknown; errors?: Array<{ code?: number; message?: string }> } | null;
}

async function get(url: string): Promise<ApiResult> {
	const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	const text = await res.text();
	let body: ApiResult["body"] = null;
	try {
		body = JSON.parse(text) as ApiResult["body"];
	} catch {
		body = null;
	}
	return { status: res.status, body };
}

const err = (r: ApiResult): string => JSON.stringify(r.body?.errors ?? r.body);

async function main(): Promise<void> {
	console.log("── 값 형식 ───────────────────────────────────────────");
	console.log(`ACCOUNT_ID : ${mask(accountId)} ${clean(accountId) ? "" : "⚠️ 따옴표/공백 의심"}`);
	console.log(`DATABASE_ID: ${mask(databaseId)} ${clean(databaseId) ? "" : "⚠️ 따옴표/공백 의심"}`);
	console.log(`TOKEN      : ${mask(token)} ${clean(token) ? "" : "⚠️ 따옴표/공백 의심"}`);
	console.log("  (계정 ID = 32자 hex, D1 DB ID = 36자 UUID)");

	console.log("\n── 1. 토큰 유효성 ────────────────────────────────────");
	const verify = await get("https://api.cloudflare.com/client/v4/user/tokens/verify");
	const tokenOk = verify.body?.success === true;
	console.log(
		tokenOk
			? `✅ active (HTTP ${verify.status})`
			: `❌ HTTP ${verify.status} ${err(verify)}\n   → 토큰 문자열이 잘못됐거나 폐기됨. 새로 발급.`,
	);

	console.log("\n── 2. D1 권한 + 계정 ID (핵심 판정) ──────────────────");
	const dbs = await get(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`);
	if (dbs.body?.success) {
		const list = (dbs.body.result ?? []) as Array<{ name: string; uuid: string }>;
		console.log(`✅ D1 접근 성공 — 데이터베이스 ${list.length}개`);
		for (const d of list) {
			console.log(`   - ${d.name}  ${d.uuid}${d.uuid === databaseId ? "  ← .env와 일치 ✅" : ""}`);
		}
		if (list.length > 0 && !list.some((d) => d.uuid === databaseId)) {
			console.log("   ⚠️ AF_D1_DATABASE_ID 와 일치하는 DB가 없다 — 위 uuid 중 하나로 교체");
		}
	} else {
		console.log(`❌ HTTP ${dbs.status} ${err(dbs)}`);
		console.log("   가장 흔한 원인 (순서대로 확인):");
		console.log("   1) AF_D1_ACCOUNT_ID 가 실제 계정 ID가 아님 (Zone ID를 복사한 경우가 많다)");
		console.log("      → dash.cloudflare.com 접속 후 URL: dash.cloudflare.com/<ACCOUNT_ID>/...");
		console.log("   2) 토큰 편집 후 'Continue to summary → Update token' 을 누르지 않음");
		console.log("   3) 토큰의 Account Resources 가 다른 계정을 가리킴");
	}

	console.log("\n── 3. 참고: 계정 목록 ────────────────────────────────");
	const accounts = await get("https://api.cloudflare.com/client/v4/accounts");
	const list = (accounts.body?.result ?? []) as Array<{ id: string; name: string }>;
	if (list.length === 0) {
		console.log("(빈 목록 — 정상일 수 있음. 계정 목록 조회에는 'Account Settings: Read' 권한이 별도로 필요하다)");
	} else {
		for (const a of list) console.log(`   - ${a.name}  ${a.id}${a.id === accountId ? "  ← .env와 일치 ✅" : ""}`);
	}
}

main().catch((e: unknown) => {
	console.error("진단 실패:", e instanceof Error ? e.message : e);
	process.exitCode = 1;
});
