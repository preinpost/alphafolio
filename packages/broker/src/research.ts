/**
 * 종목 리서치 묶음 — 구 kis-stock-research 스킬을 툴로 옮긴 것.
 *
 * 스킬은 "시세 → 재무 → 뉴스 → 컨센서스 순서로 부르고 이 형식으로 써라" 였다. 저비용 모델은
 * 순서를 건너뛰거나 실패한 단계를 조용히 빼먹는다. 여기서 병렬로 한 번에 모으고, **섹션마다
 * 성공·실패·해당 없음을 구분해** 모델이 "없는 것"과 "못 가져온 것"을 섞지 않게 한다
 * (컨센서스 실패를 "미커버"로 잘못 말했던 문제 — PLAN §20 — 를 되풀이하지 않는다).
 *
 * 판정(매수/매도)은 넣지 않는다. 리서치는 사실 수집이고 매매 판단은 market_timing 이 한다 —
 * 안 그러면 "삼성전자 알려줘" 에도 매수/매도 라벨이 붙는다.
 */

export type Section<T> =
	| { status: "ok"; data: T }
	/** 조회를 시도했으나 실패 — 데이터가 "없는" 게 아니라 "모른다" */
	| { status: "failed"; error: string }
	/** 해당 없음 (해외 종목의 재무, 뉴스 키 미설정 등) — 이유를 적는다 */
	| { status: "skipped"; reason: string };

/**
 * 실패를 섹션 값으로 바꾼다 — 한 섹션의 실패가 리서치 전체를 죽이지 않게.
 *
 * @param notApplicable 이 오류면 "실패"가 아니라 "해당 없음"으로 분류한다. 자격증명 미설정이
 *   대표적이다 — 서버는 브로커·뉴스 접근자를 항상 넘기고 키가 없으면 호출 시점에 throw 하므로,
 *   구분하지 않으면 "키를 안 넣었음"이 "조회 실패"로 표시된다.
 */
export async function settle<T>(
	run: () => Promise<T>,
	notApplicable?: (err: unknown) => string | null,
): Promise<Section<T>> {
	try {
		return { status: "ok", data: await run() };
	} catch (err) {
		const reason = notApplicable?.(err);
		if (reason) return { status: "skipped", reason };
		const msg = err instanceof Error ? err.message : String(err);
		return { status: "failed", error: msg.length > 120 ? `${msg.slice(0, 120)}…` : msg };
	}
}

export function skipped<T>(reason: string): Section<T> {
	return { status: "skipped", reason };
}

/**
 * 52주 범위 내 위치 (0 = 52주 최저, 100 = 52주 최고).
 * 범위 밖이면(당일 신고가 등) 0~100 을 넘을 수 있다 — 자르지 않고 그대로 준다.
 */
export function position52w(price: number, low: number | null, high: number | null): number | null {
	if (low === null || high === null || high <= low) return null;
	return Math.round(((price - low) / (high - low)) * 1000) / 10;
}

/** 섹션 상태를 한 줄로 — 모델에게 "무엇이 비었고 왜인지"를 명시한다. */
export function sectionNote(label: string, s: Section<unknown>): string | null {
	if (s.status === "ok") return null;
	if (s.status === "skipped") return `${label}: 해당 없음 — ${s.reason}`;
	return `${label}: 조회 실패 (${s.error}) — 데이터가 없는 게 아니라 가져오지 못한 것`;
}
