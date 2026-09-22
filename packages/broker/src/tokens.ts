/**
 * 브로커 접근 토큰 캐시 — KIS·토스 공용.
 *
 * 프로세스 밖(서버는 D1)에 보존해야 한다:
 *   - KIS 는 토큰 발급마다 **사용자 휴대폰으로 알림톡/SMS** 를 보낸다
 *   - 토스는 문자를 보내지 않지만, 재시작마다 재발급할 이유가 없다
 */

export interface CachedToken {
	token: string;
	/** epoch ms. 만료 1분 전을 미리 만료로 본다. */
	expiresAt: number;
}

export interface TokenStore {
	get(key: string): Promise<CachedToken | null>;
	set(key: string, value: CachedToken): Promise<void>;
	delete(key: string): Promise<void>;
}

/** 저장소가 없는 환경(테스트 등)용 — 프로세스 메모리에만 둔다. */
export function memoryTokenStore(): TokenStore {
	const map = new Map<string, CachedToken>();
	return {
		get: async (k) => map.get(k) ?? null,
		set: async (k, v) => void map.set(k, v),
		delete: async (k) => void map.delete(k),
	};
}

/**
 * 같은 키에 대한 동시 발급을 막는다 (여러 툴이 한꺼번에 호출될 때 중복 발급 방지).
 * 브로커 공용 — 키에 브로커 접두사가 들어가므로 충돌하지 않는다.
 */
const inFlight = new Map<string, Promise<string>>();

export async function issueOnce(key: string, issue: () => Promise<string>): Promise<string> {
	const running = inFlight.get(key);
	if (running) return running;

	const promise = issue().finally(() => inFlight.delete(key));
	inFlight.set(key, promise);
	return promise;
}
