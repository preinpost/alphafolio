import type { UseQueryResult } from "@tanstack/react-query";
import type { McpServerStatus, McpToolsView } from "../../lib/api.ts";
import { TrashIcon } from "../icons.tsx";
import { AUTH_LABEL, counts, square, statusOf } from "./helpers.ts";

/** 연결한 서버 한 줄 — 상태 · 툴 수 · 연결/테스트/해제/삭제 */
export function ServerRow({
	s,
	t,
	tools,
	busy,
	oauthReady,
	connecting,
	testing,
	testBusy,
	onConnect,
	onTest,
	onDisconnect,
	onDelete,
}: {
	s: McpServerStatus;
	/** 마지막 연결 테스트 결과 */
	t: { ok: boolean; message: string } | undefined;
	tools: UseQueryResult<McpToolsView> | undefined;
	busy: boolean;
	oauthReady: boolean;
	connecting: boolean;
	testing: boolean;
	testBusy: boolean;
	onConnect: () => void;
	onTest: () => void;
	onDisconnect: () => void;
	onDelete: () => void;
}) {
	const st = statusOf(s);
	return (
		<div className="row conn-row">
			<span className="logo-sq" aria-hidden="true">
				{square(s)}
			</span>
			<span className="grow">
				<span className="name flex items-center gap-2">
					{s.name}
					<span className={`badge ${st.tone}`}>{st.text}</span>
				</span>
				<span className="detail">
					<span className="mono">{s.url}</span>
					<span>{AUTH_LABEL[s.auth]}</span>
					<span>{counts(tools)}</span>
				</span>
				{t && <span className={`test-msg ${t.ok ? "ok-text" : "danger-text"}`}>{t.message}</span>}
			</span>
			<span className="acts">
				{s.auth === "oauth" && !s.connected && (
					<button className="btn btn-primary btn-sm" disabled={busy || !oauthReady} onClick={onConnect}>
						{connecting ? (
							<>
								<span className="spin" />
								여는 중…
							</>
						) : (
							"연결"
						)}
					</button>
				)}
				{s.connected && (
					<button className="btn btn-ghost btn-sm" disabled={testBusy} onClick={onTest}>
						{testing ? (
							<>
								<span className="spin" />
								확인 중…
							</>
						) : (
							"연결 테스트"
						)}
					</button>
				)}
				{s.auth === "oauth" && s.connected && (
					<button className="btn btn-ghost btn-sm" disabled={busy} onClick={onDisconnect}>
						연결 해제
					</button>
				)}
				<button className="icon-btn" disabled={busy} aria-label={`${s.name} 삭제`} title="삭제" onClick={onDelete}>
					<TrashIcon size={16} />
				</button>
			</span>
		</div>
	);
}
