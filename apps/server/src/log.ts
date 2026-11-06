/**
 * 대체값으로 넘어가는 실패의 기록.
 *
 * `.catch(() => null)` 로 삼키면 장애를 "값 없음" 과 구분할 수 없다. 흐름은 그대로 두고 남기기만 한다.
 * debug 는 흔하고 예상된 실패 (AF_DEBUG=1 일 때만), warn 은 운영에서 봐야 하는 실패.
 */
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const debugEnabled = (): boolean => process.env.AF_DEBUG === "1";

export function logDebug(tag: string, what: string, err: unknown): void {
	if (debugEnabled()) console.debug(`[${tag}] ${what}: ${errText(err)}`);
}

export function logWarn(tag: string, what: string, err: unknown): void {
	console.warn(`[${tag}] ${what}: ${errText(err)}`);
}

/** 실패하면 기록하고 대체값으로 — `.catch(fallbackOn("tag", "무엇", null))` */
export function fallbackOn<T>(tag: string, what: string, value: T, level: "debug" | "warn" = "warn"): (err: unknown) => T {
	return (err) => {
		(level === "debug" ? logDebug : logWarn)(tag, what, err);
		return value;
	};
}
