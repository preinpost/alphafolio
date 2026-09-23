/**
 * 대화별 "마지막으로 본 시점" — 사이드바의 새 답 표시용 (PLAN §24).
 *
 * 앱을 끈 사이 서버가 답을 끝내면 그 대화의 수정 시각이 본 시점보다 뒤가 된다 → 점을 찍는다.
 * 이 기기에서 한 번도 안 본 대화(다른 기기에서 만든 것)는 표시하지 않는다 — 전부 새 글처럼 보이면 쓸모가 없다.
 */
const KEY = "af_seen";
/** 저장 시각 오차 — 같은 응답의 파일 기록이 몇 ms 늦게 찍혀도 새 답으로 보지 않게 */
const SLACK_MS = 2000;

function load(): Record<string, string> {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
	} catch {
		return {};
	}
}

export function markSeen(sessionId: string, modified: string): void {
	const all = load();
	if (all[sessionId] && all[sessionId]! >= modified) return;
	all[sessionId] = modified;
	// 오래된 기록은 버린다 (최근 200개)
	const entries = Object.entries(all).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 200);
	try {
		localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
	} catch {
		/* 저장 불가 — 표시만 안 된다 */
	}
}

/** 지운 대화의 기록을 버린다 */
export function forgetSeen(sessionId: string): void {
	const all = load();
	if (!(sessionId in all)) return;
	delete all[sessionId];
	try {
		localStorage.setItem(KEY, JSON.stringify(all));
	} catch {
		/* 무시 */
	}
}

export function isUnread(sessionId: string, modified: string): boolean {
	const seen = load()[sessionId];
	return seen !== undefined && Date.parse(modified) - Date.parse(seen) > SLACK_MS;
}

/** iOS 앱은 다시 켜면 "/" 에서 시작한다 — 마지막으로 보던 대화로 돌려놓는다 */
const LAST = "af_last_session";
export const lastSession = {
	get: (): string | null => {
		try {
			return localStorage.getItem(LAST);
		} catch {
			return null;
		}
	},
	set: (id: string | null): void => {
		try {
			if (id) localStorage.setItem(LAST, id);
			else localStorage.removeItem(LAST);
		} catch {
			/* noop */
		}
	},
};
