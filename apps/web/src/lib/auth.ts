/**
 * 토큰 저장 — 쿠키를 쓰지 않는다 (PLAN.md §8.2).
 *
 * Capacitor(iOS) WebView는 origin이 capacitor://localhost 라 쿠키를 신뢰할 수 없다.
 * 웹/모바일이 같은 코드를 쓰도록 양쪽 다 Bearer 토큰 + 로컬 저장소로 통일한다.
 *
 * Phase 5: Capacitor에서는 Preferences/Keychain 플러그인으로 교체한다
 * (아래 get/set/clear 세 함수만 갈아끼우면 된다).
 */
const KEY = "af_token";

export function getToken(): string | null {
	try {
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
}

export function setToken(token: string): void {
	try {
		localStorage.setItem(KEY, token);
	} catch {
		/* 프라이빗 모드 등 — 메모리 세션으로만 동작 */
	}
}

export function clearToken(): void {
	try {
		localStorage.removeItem(KEY);
	} catch {
		/* noop */
	}
}

/**
 * API 기준 URL.
 * 웹은 같은 오리진, Capacitor 앱은 빌드 시 주입한 원격 서버를 쓴다.
 */
export const API_BASE: string = import.meta.env.VITE_AF_API_BASE ?? "";

export function wsUrl(): string {
	if (API_BASE) {
		return `${API_BASE.replace(/^http/, "ws")}/ws`;
	}
	const proto = location.protocol === "https:" ? "wss" : "ws";
	return `${proto}://${location.host}/ws`;
}
