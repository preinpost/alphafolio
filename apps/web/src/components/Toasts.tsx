import type { ReactNode } from "react";
import { dismissToast, useToasts } from "../lib/toast.ts";

/** 토스트 자리 — 셸에 하나. extra 는 감시 발동처럼 셸이 직접 그리는 알림 */
export function ToastHost({ extra }: { extra?: ReactNode }) {
	const list = useToasts();
	return (
		<div className="toast-host" aria-live="polite">
			{extra}
			{list.map((t) => (
				<div key={t.id} className="toast">
					<span className="t">
						{t.text}
						{t.sub && <small>{t.sub}</small>}
					</span>
					{t.action && (
						<button
							onClick={() => {
								t.action?.run();
								dismissToast(t.id);
							}}
						>
							{t.action.label}
						</button>
					)}
				</div>
			))}
		</div>
	);
}
