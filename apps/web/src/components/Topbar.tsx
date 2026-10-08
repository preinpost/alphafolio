import type { ReactNode } from "react";

/**
 * 화면 위 막대 — 제목 · 보조 문구 · 오른쪽 동작. 화면마다 자기 막대를 그린다
 * (챗: 대화 제목·새 대화, 투자: 갱신 시각·새로고침, 가계부: 월 이동·기록 추가).
 * 모바일에서는 보조 문구가 숨는다.
 */
export function Topbar({ title, sub, leading, children }: { title: ReactNode; sub?: ReactNode; leading?: ReactNode; children?: ReactNode }) {
	return (
		<header className="topbar">
			{leading}
			<h1>{title}</h1>
			{sub && <span className="sub">{sub}</span>}
			<span className="spacer" />
			{children}
		</header>
	);
}
