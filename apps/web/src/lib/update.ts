/**
 * 새 버전 감지 — 서비스워커(PWA)가 배포 직후 첫 로드에 **이전 번들**을 캐시에서 준다.
 *
 * 새 서비스워커는 뒤에서 설치되고(autoUpdate: skipWaiting + clientsClaim) 페이지를 넘겨받지만, 열려 있는 페이지의 JS 는
 * 그대로다. 그 사이 서버는 새 카드(예: mcp-confirm-card)를 보내는데 옛 번들은 그 종류를 몰라 조용히 비워 둔다
 * (실측 2026-09-25: 알림 확인 카드 4장이 안 보였다). → 넘겨받는 순간(controllerchange) 새로고침을 권한다.
 *
 * 처음 방문(컨트롤러가 없던 페이지)도 clientsClaim 으로 controllerchange 가 나므로, 로드 때 컨트롤러가 있었을 때만 알린다.
 * iOS 앱(capacitor://)은 서비스워커가 없다 — 번들이 앱에 들어 있다.
 *
 * 두 번째 신호: 서버 버전 ≠ 이 번들 버전 (App 의 /api/health). controllerchange 는 한 번만 오므로
 * 배너를 놓치고 그냥 새로고침하면 다시 안 떴다 — 버전 차이는 새로고침 뒤에도 남으므로 배너가 계속 뜬다.
 *
 * ⚠️ 그냥 location.reload() 로는 안 바뀌는 경우가 있었다 (실측 2026-09-29): Cloudflare 가 sw.js 를 최대 4시간 캐시해
 * 브라우저가 업데이트를 확인해도 **옛 sw.js** 를 받고, 옛 서비스워커가 옛 번들을 계속 준다.
 * 서버가 sw.js 에 no-cache 를 붙여 막았고(apps/server/src/static-cache.ts), applyUpdate 는 그래도 새 워커가 안 오면
 * 서비스워커·캐시를 지우고 네트워크에서 받는다.
 */
import { isNativeApp } from "./auth.ts";

type Listener = () => void;

/** 새 서비스워커가 이 페이지를 넘겨받았다 — 새로고침만 하면 새 번들이 온다 */
let swTookOver = false;
let serverVersion: string | null = null;
const listeners = new Set<Listener>();
const emit = () => {
	for (const l of listeners) l();
};

export function installUpdateWatch(): void {
	if (!("serviceWorker" in navigator)) return;
	const hadController = !!navigator.serviceWorker.controller;
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!hadController || swTookOver) return;
		swTookOver = true;
		emit();
	});
	// 오래 열어 둔 탭도 배포를 알아채게 — 다시 볼 때마다 서비스워커 갱신을 확인한다
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		void navigator.serviceWorker.getRegistration().then((r) => r?.update().catch(() => undefined));
	});
}

/** App 이 /api/health 로 읽은 서버 버전을 알린다 */
export function reportServerVersion(v: string | undefined): void {
	const next = v && v !== "unknown" ? v : null;
	if (next === serverVersion) return;
	serverVersion = next;
	emit();
}

/** 서버가 이 번들보다 새 버전이면 그 버전, 아니면 null */
export function staleVersion(): string | null {
	return serverVersion && serverVersion !== __APP_VERSION__ ? serverVersion : null;
}

/**
 * 상단 배너를 띄울지. iOS 앱은 새로고침해도 번들이 안 바뀌므로(앱 업데이트 필요) 버전 차이로는 띄우지 않는다.
 */
export function updateReady(): boolean {
	return swTookOver || (!isNativeApp && staleVersion() !== null);
}

export function onUpdateReady(l: Listener): () => void {
	listeners.add(l);
	return () => listeners.delete(l);
}

/** 워커가 activated 가 될 때까지 (최대 ms) — 설치가 실패(redundant)하거나 시간이 지나면 false */
function untilActivated(sw: ServiceWorker, ms: number): Promise<boolean> {
	if (sw.state === "activated") return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => done(false), ms);
		const onChange = () => {
			if (sw.state === "activated") done(true);
			else if (sw.state === "redundant") done(false);
		};
		const done = (ok: boolean) => {
			clearTimeout(timer);
			sw.removeEventListener("statechange", onChange);
			resolve(ok);
		};
		sw.addEventListener("statechange", onChange);
	});
}

/**
 * 새 버전으로 새로고침.
 *   1. 새 워커가 이미 넘겨받았으면 → 그냥 새로고침
 *   2. 아니면 갱신을 확인하고, 새 워커가 설치 중이면 활성화까지 기다렸다가 새로고침
 *   3. 새 워커가 없으면(옛 sw.js 를 받았다 = CDN 캐시 등) → 서비스워커·캐시를 지우고 새로고침
 *      (다음 로드는 네트워크에서 새 index.html 을 받고 서비스워커는 다시 등록된다)
 */
export async function applyUpdate(): Promise<void> {
	try {
		if (swTookOver || !("serviceWorker" in navigator)) return;
		const reg = await navigator.serviceWorker.getRegistration();
		if (!reg) return;
		await reg.update().catch(() => undefined);
		const next = reg.installing ?? reg.waiting;
		if (next && (await untilActivated(next, 15_000))) return;
		await reg.unregister();
		if ("caches" in window) {
			for (const key of await caches.keys()) await caches.delete(key);
		}
	} catch {
		// 어떤 경우든 새로고침은 한다
	} finally {
		location.reload();
	}
}
