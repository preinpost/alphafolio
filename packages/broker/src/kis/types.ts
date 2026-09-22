/**
 * KIS 도메인 타입.
 *
 * ⚠️ 이 패키지는 **process.env 를 절대 읽지 않는다.**
 *    자격증명은 전부 인자로 받는다 — 한 프로세스에서 여러 사용자의 증권 계정을
 *    동시에 다루려면 이 규칙이 깨지면 안 된다 (PLAN.md §15).
 *    기존 pi-kis 가 `loadKeys()` 로 전역 env 를 읽는 구조라 그대로 쓸 수 없었다.
 */

export type KisEnv = "real" | "paper";

export interface KisCredentials {
	appKey: string;
	appSecret: string;
	/** 계좌번호 — 잔고·주문에만 필요하다. 시세 조회는 없어도 된다. */
	cano?: string;
	/** 계좌상품코드 (기본 01). */
	prdtCd?: string;
	env: KisEnv;
}

export const REAL_BASE = "https://openapi.koreainvestment.com:9443";
export const PAPER_BASE = "https://openapivts.koreainvestment.com:29443";

export function baseUrl(env: KisEnv): string {
	return env === "paper" ? PAPER_BASE : REAL_BASE;
}

/**
 * 계좌번호를 KIS 포맷(CANO 8자리 + ACNT_PRDT_CD 2자리)으로 분리한다.
 * "12345678-01", "12345678", "1234-5678-01" 모두 허용.
 */
export function parseAccount(raw: string | undefined): { cano?: string; prdtCd?: string } {
	if (!raw) return {};
	const digits = String(raw).replace(/[\s-]/g, "");
	const m = /^(\d{8})(\d{2})?$/.exec(digits);
	if (m) return { cano: m[1], prdtCd: m[2] ?? "01" };
	return { cano: String(raw).trim() };
}

export class KisError extends Error {
	readonly status: number;
	/** KIS 응답 코드 (rt_cd / msg_cd). 인증 만료 판별 등에 쓴다. */
	readonly code: string | undefined;
	readonly api: string;

	constructor(message: string, opts: { status: number; code?: string; api: string }) {
		super(message);
		this.name = "KisError";
		this.status = opts.status;
		this.code = opts.code;
		this.api = opts.api;
	}
}

/** 자격증명이 없을 때 — 사용자에게 설정 화면을 안내한다. */
export class KisCredentialsMissingError extends Error {
	readonly missing: string[];

	constructor(missing: string[]) {
		super(
			`증권 계정 설정이 없습니다 (${missing.join(", ")}). ` +
				`설정 화면의 '증권 (KIS)' 에서 입력하세요. 키는 사용자별로 저장됩니다.`,
		);
		this.name = "KisCredentialsMissingError";
		this.missing = missing;
	}
}
