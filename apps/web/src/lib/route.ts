/**
 * 주소 ↔ 화면 (PLAN §24). 라우터 라이브러리 없이 History API 만 쓴다.
 *
 *   /            새 대화
 *   /c/<id>      그 대화 — 새로고침·북마크·다른 기기에서 같은 주소로 이어진다
 *   /portfolio   투자 · /ledger 가계부 · /settings 설정
 *
 * 서버는 모르는 경로에 index.html 을 준다 (SPA fallback). iOS 앱(capacitor://localhost)도 같다.
 */
export type View = "chat" | "ledger" | "portfolio" | "settings";

export interface Route {
	view: View;
	/** view=chat 일 때만. null = 새 대화 */
	sessionId: string | null;
}

const VIEWS: Record<string, View> = { portfolio: "portfolio", ledger: "ledger", settings: "settings" };

export function parseRoute(pathname: string): Route {
	const parts = pathname.split("/").filter(Boolean);
	if (parts[0] === "c" && parts[1]) return { view: "chat", sessionId: decodeURIComponent(parts[1]) };
	const view = parts[0] ? VIEWS[parts[0]] : undefined;
	return { view: view ?? "chat", sessionId: null };
}

export function pathOf(route: Route): string {
	if (route.view !== "chat") return `/${route.view}`;
	return route.sessionId ? `/c/${encodeURIComponent(route.sessionId)}` : "/";
}

/** 주소만 바꾼다 (화면 전환은 호출부가). 같은 주소면 아무것도 하지 않는다. */
export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
	const path = pathOf(route);
	if (location.pathname === path) return;
	if (opts.replace) history.replaceState(null, "", path);
	else history.pushState(null, "", path);
}
