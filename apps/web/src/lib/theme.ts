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

/** 주소창·상태바 색 = styles.css 의 --bg (oklch 0.977 / 0.165 를 hex 로). index.html 인라인 스크립트도 같은 값 */
const THEME_COLOR = { light: "#f6f8fa", dark: "#090f16" } as const;

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
	if (meta) meta.setAttribute("content", dark ? THEME_COLOR.dark : THEME_COLOR.light);
	window.dispatchEvent(new Event(THEME_EVENT));
}

const THEME_EVENT = "af-theme";

/** 화면 테마가 바뀔 때 (설정 화면·사이드바 토글·system 모드의 OS 변경). useSyncExternalStore 용 */
export function onThemeApplied(cb: () => void): () => void {
	window.addEventListener(THEME_EVENT, cb);
	return () => window.removeEventListener(THEME_EVENT, cb);
}

/** 지금 다크로 그리고 있는가 (system 모드면 OS 설정에 따라) */
export const isDarkNow = (): boolean => document.documentElement.classList.contains("dark");

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
