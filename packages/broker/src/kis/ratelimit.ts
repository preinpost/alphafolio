/**
 * KIS 레이트 리밋.
 *
 * KIS 는 **앱 키 단위**로 초당 호출을 제한한다 (초과 시 EGW00201 등).
 * 전역 스로틀을 쓰면 사용자가 늘수록 서로를 느리게 만들고, 반대로 스로틀이
 * 없으면 한 사용자의 벌크 조회가 자기 키를 막는다. 그래서 **앱 키 해시별로**
 * 직렬화한다.
 */
const DEFAULT_INTERVAL_MS = 300;

interface Lane {
	tail: Promise<void>;
	lastStartAt: number;
}

const lanes = new Map<string, Lane>();

/** 같은 키의 호출을 최소 간격으로 직렬화한다. */
export async function withRateLimit<T>(
	key: string,
	fn: () => Promise<T>,
	intervalMs = DEFAULT_INTERVAL_MS,
): Promise<T> {
	if (intervalMs <= 0) return fn();

	const lane = lanes.get(key) ?? { tail: Promise.resolve(), lastStartAt: 0 };
	lanes.set(key, lane);

	const run = lane.tail.then(async () => {
		const wait = lane.lastStartAt + intervalMs - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		lane.lastStartAt = Date.now();
	});

	// 실패해도 다음 호출의 간격은 유지되도록 tail 은 항상 이어간다
	lane.tail = run.catch(() => {});
	await run;
	return fn();
}
