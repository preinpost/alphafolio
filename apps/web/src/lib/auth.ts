/**
 * 토큰 저장 — 쿠키를 쓰지 않는다 (PLAN.md §8.2).
 *
 * Capacitor(iOS) WebView는 origin이 capacitor://localhost 라 쿠키를 신뢰할 수 없다.
 * 웹/모바일이 같은 코드를 쓰도록 양쪽 다 Bearer 토큰으로 통일한다.
 *
 * 저장소는 환경마다 다르다:
 *   - 웹: localStorage
 *   - iOS 앱: Keychain (앱 로컬 플러그인 — apps/mobile/ios/App/App/KeychainPlugin.swift).
 *     localStorage 는 평문 plist 로 기기 백업에 실린다.
 *
 * Keychain 은 비동기라, 모듈을 불러올 때 한 번 읽어 메모리에 올려두고(top-level await)
 * getToken() 은 그대로 동기 함수로 둔다. 호출부(App·api·chat)가 바뀌지 않는다.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

const KEY = "af_token";

interface KeychainPlugin {
	get(options: { key: string }): Promise<{ value: string | null }>;
	set(options: { key: string; value: string }): Promise<void>;
	remove(options: { key: string }): Promise<void>;
}

/** iOS 앱 안에서 도는가 */
export const isNativeApp: boolean = Capacitor.isNativePlatform();

const keychain = isNativeApp ? registerPlugin<KeychainPlugin>("Keychain") : null;

/** 메모리 사본 — 앱에서는 Keychain 의 캐시, 웹에서는 쓰지 않는다 */
let cached: string | null = null;

if (keychain) {
	try {
		cached = (await keychain.get({ key: KEY })).value;
	} catch (err) {
		// 읽지 못하면 로그인 화면으로 — 앱이 멈추는 것보다 낫다
		console.error("[auth] Keychain 읽기 실패", err);
	}
}

export function getToken(): string | null {
	if (keychain) return cached;
	try {
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
}

/** 앱에서는 Keychain 쓰기가 끝나야 resolve 된다 (메모리 사본은 즉시 바뀐다). */
export async function setToken(token: string): Promise<void> {
	if (keychain) {
		cached = token;
		await keychain.set({ key: KEY, value: token }).catch((err: unknown) => {
			// 이번 실행 동안은 메모리로 동작한다 — 다음 실행 때 다시 로그인
			console.error("[auth] Keychain 저장 실패", err);
		});
		return;
	}
	try {
		localStorage.setItem(KEY, token);
	} catch {
		/* 프라이빗 모드 등 — 메모리 세션으로만 동작 */
	}
}

/**
 * 앱에서는 **await 한 뒤 새로고침해야 한다.** 삭제가 끝나기 전에 reload 하면
 * 만료된 토큰을 다시 읽어 401 → 로그아웃 → reload 가 반복된다.
 */
export async function clearToken(): Promise<void> {
	if (keychain) {
		cached = null;
		await keychain.remove({ key: KEY }).catch((err: unknown) => {
			console.error("[auth] Keychain 삭제 실패", err);
		});
		return;
	}
	try {
		localStorage.removeItem(KEY);
	} catch {
		/* noop */
	}
}

/**
 * API 기준 URL.
 * 웹은 같은 오리진, iOS 앱은 빌드 시 주입한 원격 서버를 쓴다 (`task mobile:build`).
 */
export const API_BASE: string = import.meta.env.VITE_AF_API_BASE ?? "";

// 앱 번들은 capacitor://localhost 에서 뜨므로 "같은 오리진"이 존재하지 않는다
if (isNativeApp && !API_BASE) {
	console.error("[auth] VITE_AF_API_BASE 없이 빌드된 앱 — 서버에 연결할 수 없습니다");
}

export function wsUrl(): string {
	if (API_BASE) {
		return `${API_BASE.replace(/^http/, "ws")}/ws`;
	}
	const proto = location.protocol === "https:" ? "wss" : "ws";
	return `${proto}://${location.host}/ws`;
}
