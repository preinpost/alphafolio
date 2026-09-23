/**
 * 모바일 뷰포트 — iOS(WKWebView·Safari) 키보드 대응.
 *
 * styles.css 는 body 를 fixed 로 잠그고 #root 높이를 --app-height 로 잡는다.
 * 여기서 visualViewport 높이를 --app-height 에 넣고, 키보드가 열려 있으면
 * <html class="ua-keyboard"> 를 붙인다 (홈 인디케이터 여백 제거 등에 쓰인다).
 *
 * 두 환경을 다 커버한다:
 *   - Safari/PWA, Capacitor Keyboard resize:"none" → 레이아웃 뷰포트는 그대로, visualViewport 만 줄어든다
 *   - Capacitor Keyboard resize:"native"/"body"   → 웹뷰 자체가 줄어든다 (innerHeight 도 같이 줄어듦)
 * 그래서 키보드 판정은 "innerHeight 와의 차이"가 아니라 "지금까지 본 최대 높이와의 차이"로 한다.
 */

/** 이만큼 이상 줄어들면 키보드로 본다 (주소창·툴바 변화는 이보다 작다) */
const KEYBOARD_MIN_PX = 150;

export function installViewport(): () => void {
	const vv = window.visualViewport;
	const root = document.documentElement;
	// 키보드 판정은 터치 기기에서만 — 데스크톱 창 크기 조절을 키보드로 오인하지 않게
	const touch = window.matchMedia("(pointer: coarse)").matches;

	let baseline = 0;
	let orientation = currentOrientation();
	let frame = 0;

	const update = (): void => {
		frame = 0;
		const h = vv ? vv.height : window.innerHeight;

		const o = currentOrientation();
		if (o !== orientation) {
			orientation = o;
			baseline = 0;
		}
		baseline = Math.max(baseline, h);

		root.style.setProperty("--app-height", `${Math.round(h)}px`);
		root.classList.toggle("ua-keyboard", touch && baseline - h > KEYBOARD_MIN_PX);

		// iOS 는 body 가 fixed 여도 포커스된 입력창을 보이려고 문서를 밀어 올린다.
		// #root 를 이미 보이는 높이에 맞췄으니 원위치시킨다 (안 하면 헤더가 화면 밖으로 밀린다).
		if (window.scrollY !== 0 || (vv && vv.offsetTop !== 0)) window.scrollTo(0, 0);
	};

	const schedule = (): void => {
		if (!frame) frame = requestAnimationFrame(update);
	};

	update();
	vv?.addEventListener("resize", schedule);
	vv?.addEventListener("scroll", schedule);
	window.addEventListener("resize", schedule);
	window.addEventListener("orientationchange", schedule);

	return () => {
		if (frame) cancelAnimationFrame(frame);
		vv?.removeEventListener("resize", schedule);
		vv?.removeEventListener("scroll", schedule);
		window.removeEventListener("resize", schedule);
		window.removeEventListener("orientationchange", schedule);
	};
}

function currentOrientation(): string {
	return screen.orientation?.type ?? (window.innerWidth > window.innerHeight ? "landscape" : "portrait");
}

/** 마우스처럼 정밀 포인터 + 호버가 되는 기기 — 호버로 드러나는 UI 를 쓸지 판단한다 */
export const finePointer: boolean =
	typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
