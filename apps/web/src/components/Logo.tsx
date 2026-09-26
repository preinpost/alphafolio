/**
 * AlphaFolio 로고 — 파비콘(public/favicon-64.png 등)과 같은 도형을 SVG로 옮긴 것.
 * 딥 네이비 배경 + 밝은 A + 파란 가로획. 크기·모서리는 className(size-*, rounded-*)으로 준다.
 * 배경이 다크 캔버스(#0e1622)와 같아서 다크 모드에선 테두리로 구분한다.
 */
export function Logo({ className = "" }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 512 512"
			aria-hidden="true"
			className={`shrink-0 overflow-hidden dark:ring-1 dark:ring-line ${className}`}
		>
			<rect width="512" height="512" fill="#0e1622" />
			{/* 두 획을 별도 서브패스로 — 꼭대기가 이어지지 않고 V자 홈이 남는다 */}
			<path d="M256 134 127 398M256 134 385 398" stroke="#e6ecf5" strokeWidth="48" fill="none" />
			<rect x="189" y="271" width="135" height="44" fill="#60a5fa" />
		</svg>
	);
}
