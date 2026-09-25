/**
 * 새 버전 감지 — 서비스워커(PWA)가 배포 직후 첫 로드에 **이전 번들**을 캐시에서 준다.
 *
 * 새 서비스워커는 뒤에서 설치되고(autoUpdate: skipWaiting + clientsClaim) 페이지를 넘겨받지만, 열려 있는 페이지의 JS 는
 * 그대로다. 그 사이 서버는 새 카드(예: mcp-confirm-card)를 보내는데 옛 번들은 그 종류를 몰라 조용히 비워 둔다
 * (실측 2026-09-25: 알림 확인 카드 4장이 안 보였다). → 넘겨받는 순간(controllerchange) 새로고침을 권한다.
 *
 * 처음 방문(컨트롤러가 없던 페이지)도 clientsClaim 으로 controllerchange 가 나므로, 로드 때 컨트롤러가 있었을 때만 알린다.
 * iOS 앱(capacitor://)은 서비스워커가 없다 — 번들이 앱에 들어 있다.
 */
type Listener = () => void;

let ready = false;
const listeners = new Set<Listener>();

export function installUpdateWatch(): void {
	if (!("serviceWorker" in navigator)) return;
	const hadController = !!navigator.serviceWorker.controller;
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!hadController || ready) return;
		ready = true;
		for (const l of listeners) l();
	});
	// 오래 열어 둔 탭도 배포를 알아채게 — 다시 볼 때마다 서비스워커 갱신을 확인한다
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		void navigator.serviceWorker.getRegistration().then((r) => r?.update().catch(() => undefined));
	});
}

export function updateReady(): boolean {
	return ready;
}

export function onUpdateReady(l: Listener): () => void {
	listeners.add(l);
	return () => listeners.delete(l);
}
