/** 새 버전 안내 (lib/update.ts) — 누르면 새로고침. 대화는 서버에서 이어지므로 새로고침해도 잃지 않는다 */
import { useSyncExternalStore } from "react";
import { onUpdateReady, updateReady } from "../lib/update.ts";

export function UpdateBanner() {
	const ready = useSyncExternalStore(onUpdateReady, updateReady);
	if (!ready) return null;
	return (
		<div className="fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-50 flex justify-center px-4">
			<div className="flex items-center gap-3 rounded-full border border-line bg-card px-4 py-2 text-sm text-ink shadow-lg">
				<span>새 버전이 준비됐습니다</span>
				<button onClick={() => location.reload()} className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-ink">
					새로고침
				</button>
			</div>
		</div>
	);
}
