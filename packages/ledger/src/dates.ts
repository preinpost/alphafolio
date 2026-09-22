/**
 * 날짜 해석 — **서버 시계(KST)가 유일한 기준**이다.
 *
 * 왜 이 파일이 있는가:
 *   "오늘은 YYYY-MM-DD" 를 시스템 프롬프트나 툴 설명에 문자열로 박으면 세션 생성 시점에
 *   고정되어, 24시간 도는 서버에서는 하루만 지나도 모든 "오늘/어제"가 틀어진다
 *   (실제로 자정 넘어가며 발견된 버그).
 *
 *   그래서 모델에게 절대 날짜를 만들게 하지 않는다. 모델은 `daysAgo`(0=오늘, 1=어제)나
 *   `period`("this_month" 등) 같은 **상대 표현**만 넘기고, 실제 날짜는 툴 실행 시점에
 *   여기서 계산한다.
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** KST 기준 오늘 (YYYY-MM-DD). */
export function todayKST(now: number = Date.now()): string {
	return new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** KST 기준 N일 전 (0=오늘, 1=어제). */
export function dateFromDaysAgo(daysAgo: number, now: number = Date.now()): string {
	if (!Number.isInteger(daysAgo) || daysAgo < 0 || daysAgo > 3650) {
		throw new Error(`daysAgo는 0 이상 3650 이하의 정수여야 합니다: ${daysAgo}`);
	}
	return new Date(now + KST_OFFSET_MS - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/** KST 기준 이번 달 (YYYY-MM). */
export function currentMonthKST(now: number = Date.now()): string {
	return todayKST(now).slice(0, 7);
}

export type Period = "today" | "yesterday" | "this_week" | "this_month" | "last_month" | "last_7d" | "last_30d" | "this_year";

export const PERIODS: readonly Period[] = [
	"today",
	"yesterday",
	"this_week",
	"this_month",
	"last_month",
	"last_7d",
	"last_30d",
	"this_year",
];

/** 월의 마지막 날 (YYYY-MM → YYYY-MM-DD). */
function endOfMonth(month: string): string {
	const [y, m] = month.split("-").map(Number);
	const last = new Date(Date.UTC(y as number, m as number, 0)).getUTCDate();
	return `${month}-${String(last).padStart(2, "0")}`;
}

/** 상대 기간을 실제 날짜 범위로 변환한다. */
export function resolvePeriod(period: Period, now: number = Date.now()): { from: string; to: string } {
	const today = todayKST(now);
	const month = today.slice(0, 7);

	switch (period) {
		case "today":
			return { from: today, to: today };
		case "yesterday": {
			const d = dateFromDaysAgo(1, now);
			return { from: d, to: d };
		}
		case "this_week": {
			// 월요일 시작
			const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0=일
			const back = dow === 0 ? 6 : dow - 1;
			return { from: dateFromDaysAgo(back, now), to: today };
		}
		case "this_month":
			return { from: `${month}-01`, to: endOfMonth(month) };
		case "last_month": {
			const [y, m] = month.split("-").map(Number);
			const prev = m === 1 ? `${(y as number) - 1}-12` : `${y}-${String((m as number) - 1).padStart(2, "0")}`;
			return { from: `${prev}-01`, to: endOfMonth(prev) };
		}
		case "last_7d":
			return { from: dateFromDaysAgo(6, now), to: today };
		case "last_30d":
			return { from: dateFromDaysAgo(29, now), to: today };
		case "this_year":
			return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
		default:
			return { from: `${month}-01`, to: endOfMonth(month) };
	}
}
