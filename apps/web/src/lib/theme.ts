/**
 * 테마 — light / dark / system.
 *
 * styles.css 가 `@custom-variant dark (&:where(.dark, .dark *))` 를 쓰므로
 * <html> 에 `dark` 클래스를 붙이거나 떼는 것으로 전환된다.
 *
 * 첫 페인트 전에 적용해야 화면이 번쩍이지 않으므로, index.html 의 인라인 스크립트가
 * 같은 키를 읽어 미리 클래스를 붙인다 (아래 STORAGE_KEY 와 값이 일치해야 한다).
 */
export type ThemeMode = "light" | "dark" | "system";

export const STORAGE_KEY = "af_theme";

export function getThemeMode(): ThemeMode {
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		return v === "light" || v === "dark" || v === "system" ? v : "system";
	} catch {
		return "system";
	}
}

function systemPrefersDark(): boolean {
	return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** 현재 모드를 실제 화면에 반영한다. */
export function applyTheme(mode: ThemeMode): void {
	const dark = mode === "dark" || (mode === "system" && systemPrefersDark());
	document.documentElement.classList.toggle("dark", dark);

	// 모바일 브라우저 주소창·상태바 색도 맞춘다
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.setAttribute("content", dark ? "#0e1622" : "#f6f8fb");
}

export function setThemeMode(mode: ThemeMode): void {
	try {
		localStorage.setItem(STORAGE_KEY, mode);
	} catch {
		/* 프라이빗 모드 — 이번 세션에만 적용 */
	}
	applyTheme(mode);
}

/**
 * system 모드일 때 OS 설정 변화를 따라가도록 구독한다.
 * 반환값은 해제 함수.
 */
export function watchSystemTheme(getMode: () => ThemeMode): () => void {
	const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
	if (!mq) return () => {};

	const onChange = (): void => {
		if (getMode() === "system") applyTheme("system");
	};
	mq.addEventListener("change", onChange);
	return () => mq.removeEventListener("change", onChange);
}
