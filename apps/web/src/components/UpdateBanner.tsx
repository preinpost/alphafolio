/**
 * 새 버전 안내 (lib/update.ts) — 누르면 새 버전을 확실히 받아 새로고침. 대화는 서버에서 이어지므로 새로고침해도 잃지 않는다.
 * 버전 차이가 남아 있는 동안은 새로고침 뒤에도 계속 뜬다.
 */
import { useState, useSyncExternalStore } from "react";
import { applyUpdate, onUpdateReady, staleVersion, updateReady } from "../lib/update.ts";

export function UpdateBanner() {
	const ready = useSyncExternalStore(onUpdateReady, updateReady);
	const version = useSyncExternalStore(onUpdateReady, staleVersion);
	const [busy, setBusy] = useState(false);
	if (!ready) return null;
	return (
		<div className="fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-50 flex justify-center px-4">
			<div className="flex items-center gap-3 rounded-full border border-line bg-card px-4 py-2 text-sm text-ink shadow-lg">
				<span>{version ? `새 버전(v${version})이 준비됐습니다` : "새 버전이 준비됐습니다"}</span>
				<button
					disabled={busy}
					onClick={() => {
						setBusy(true);
						void applyUpdate();
					}}
					className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-ink disabled:opacity-60"
				>
					{busy ? "받는 중…" : "새로고침"}
				</button>
			</div>
		</div>
	);
}
