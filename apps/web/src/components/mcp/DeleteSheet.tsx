import { useEffect, useRef } from "react";
import type { McpServerStatus } from "../../lib/api.ts";

/** 삭제 확인 — 저장된 로그인·헤더도 함께 지워지고 챗에서 더 못 쓴다 */
export function DeleteSheet({ server, onCancel, onConfirm }: { server: McpServerStatus | null; onCancel: () => void; onConfirm: (s: McpServerStatus) => void }) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (server && !d.open) d.showModal();
		if (!server && d.open) d.close();
	}, [server]);
	return (
		<dialog
			ref={ref}
			className="sheet"
			aria-labelledby="mcp-del-t"
			onClose={onCancel}
			onClick={(e) => {
				if (e.target === e.currentTarget) onCancel();
			}}
		>
			<div className="sheet-h">
				<h2 id="mcp-del-t">서버를 삭제할까요?</h2>
			</div>
			<div className="sheet-b">
				<p className="text-[14px]">
					{server?.name}을(를) 삭제합니다. 저장된 로그인과 헤더 값도 함께 지우고, 챗에서 이 서버의 툴을 더 쓸 수 없습니다.
				</p>
			</div>
			<div className="sheet-f">
				{/* 처음 포커스는 취소에 — Enter 한 번에 지워지지 않게 */}
				<button className="btn btn-ghost" onClick={onCancel} autoFocus>
					취소
				</button>
				<button className="btn btn-danger" onClick={() => server && onConfirm(server)}>
					삭제
				</button>
			</div>
		</dialog>
	);
}
