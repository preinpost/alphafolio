/**
 * AlphaFolio 로고 — 파비콘(public/favicon-64.png 등)과 같은 도형을 SVG로 옮긴 것.
 * 딥 네이비 배경 + 밝은 A + 파란 가로획. 색은 styles.css 의 --logo-* 토큰.
 * 기본 크기·모서리·다크 테두리는 .logo 클래스가 주고, 다르게 쓰려면 className(size-*, rounded-*)으로 덮는다.
 */
export function Logo({ className = "" }: { className?: string }) {
	return (
		<svg viewBox="0 0 512 512" aria-hidden="true" className={`logo ${className}`}>
			<rect width="512" height="512" fill="var(--logo-bg)" />
			{/* 두 획을 별도 서브패스로 — 꼭대기가 이어지지 않고 V자 홈이 남는다 */}
			<path d="M256 134 127 398M256 134 385 398" stroke="var(--logo-fg)" strokeWidth="48" fill="none" />
			<rect x="189" y="271" width="135" height="44" fill="var(--logo-bar)" />
		</svg>
	);
}
