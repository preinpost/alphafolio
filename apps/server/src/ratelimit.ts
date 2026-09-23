/**
 * 로그인 시도 제한 — 무차별 대입 방어.
 *
 * 공개 배포에서는 방어가 비밀번호 강도에만 걸려 있으면 안 된다.
 * 서버 상태를 파일에 두지 않고 메모리로만 관리한다 (파드 1개 = 사용자 1명 모델).
 * 재시작하면 카운터가 초기화되지만, 재시작 자체가 공격자가 유발할 수 있는 일이 아니므로 허용한다.
 *
 * 두 축으로 동시에 센다:
 *   - IP  : 한 곳에서 여러 계정을 훑는 경우
 *   - 계정: 여러 곳에서 한 계정을 노리는 경우 (분산 시도)
 * 둘 중 하나라도 한도를 넘으면 잠근다.
 */

export interface RateLimitOptions {
	/** 윈도 안에서 허용할 실패 횟수 (기본 5) */
	maxAttempts: number;
	/** 실패 집계 윈도, 초 (기본 300 = 5분) */
	windowSec: number;
	/** 한도 초과 시 잠금 시간, 초 (기본 900 = 15분) */
	lockoutSec: number;
}

export interface RateLimitVerdict {
	allowed: boolean;
	/** 잠긴 경우 남은 시간(초) — Retry-After 헤더에 쓴다 */
	retryAfterSec: number;
}

interface Bucket {
	failures: number[]; // 실패 시각(ms) 목록
	lockedUntil: number;
}

const PRUNE_INTERVAL_MS = 60_000;

export class LoginRateLimiter {
	private readonly opts: RateLimitOptions;
	private readonly buckets = new Map<string, Bucket>();
	private lastPrune = Date.now();

	constructor(opts: Partial<RateLimitOptions> = {}) {
		this.opts = {
			maxAttempts: opts.maxAttempts ?? 5,
			windowSec: opts.windowSec ?? 300,
			lockoutSec: opts.lockoutSec ?? 900,
		};
	}

	/** 시도 전에 호출한다. 잠겨 있으면 allowed=false. */
	check(keys: string[]): RateLimitVerdict {
		this.prune();
		const now = Date.now();
		let retryAfter = 0;

		for (const key of keys) {
			const bucket = this.buckets.get(key);
			if (bucket && bucket.lockedUntil > now) {
				retryAfter = Math.max(retryAfter, Math.ceil((bucket.lockedUntil - now) / 1000));
			}
		}

		return retryAfter > 0 ? { allowed: false, retryAfterSec: retryAfter } : { allowed: true, retryAfterSec: 0 };
	}

	/** 로그인 실패 기록. 한도를 넘으면 잠근다. */
	recordFailure(keys: string[]): void {
		const now = Date.now();
		const windowStart = now - this.opts.windowSec * 1000;

		for (const key of keys) {
			const bucket = this.buckets.get(key) ?? { failures: [], lockedUntil: 0 };
			bucket.failures = bucket.failures.filter((t) => t > windowStart);
			bucket.failures.push(now);

			if (bucket.failures.length >= this.opts.maxAttempts) {
				bucket.lockedUntil = now + this.opts.lockoutSec * 1000;
				bucket.failures = [];
			}
			this.buckets.set(key, bucket);
		}
	}

	/** 로그인 성공 — 해당 키의 실패 기록을 지운다. */
	recordSuccess(keys: string[]): void {
		for (const key of keys) this.buckets.delete(key);
	}

	/** 만료된 버킷 정리 (메모리 누수 방지). */
	private prune(): void {
		const now = Date.now();
		if (now - this.lastPrune < PRUNE_INTERVAL_MS) return;
		this.lastPrune = now;

		const windowStart = now - this.opts.windowSec * 1000;
		for (const [key, bucket] of this.buckets) {
			const live = bucket.failures.some((t) => t > windowStart);
			if (!live && bucket.lockedUntil <= now) this.buckets.delete(key);
		}
	}
}

/**
 * 클라이언트 IP 추출.
 *
 * ⚠️ X-Forwarded-For 는 클라이언트가 위조할 수 있다. 신뢰할 수 있는 리버스 프록시
 *    뒤에 있을 때만(AF_TRUST_PROXY=1) 참조하고, 기본은 소켓 주소를 쓴다.
 *    프록시 뒤에서 이 설정을 끄면 모든 요청이 프록시 IP 하나로 집계되어
 *    한 사용자의 실패가 다른 사용자를 잠글 수 있다.
 *
 * 프록시는 XFF 에 **덧붙인다** — 클라이언트가 보낸 값이 앞에 남는다. 그래서 맨 앞이 아니라
 * 우리 프록시가 붙인 **맨 끝**을 쓴다. Cloudflare 는 CF-Connecting-IP 를 항상 덮어쓰므로 있으면 그걸 먼저 본다.
 * (맨 앞을 쓰면 요청마다 가짜 IP 를 넣어 IP 기준 시도 제한을 피할 수 있다)
 */
export function clientIp(
	headers: Record<string, string | string[] | undefined>,
	socketAddress: string | undefined,
	trustProxy: boolean,
): string {
	if (trustProxy) {
		const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v.at(-1) : v);
		const cf = first(headers["cf-connecting-ip"])?.trim();
		if (cf) return cf;
		// 헤더가 여러 줄로 오면 합친 뒤 마지막 항목
		const xff = headers["x-forwarded-for"];
		const last = (Array.isArray(xff) ? xff.join(",") : xff)?.split(",").map((x) => x.trim()).filter(Boolean).at(-1);
		if (last) return last;
	}
	return socketAddress ?? "unknown";
}
