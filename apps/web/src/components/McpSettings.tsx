/**
 * 설정 → 연결 → MCP 서버 (PLAN §38).
 *
 * 추가·연결·삭제는 여기서만 한다 (에이전트 툴 없음). 에이전트는 mcp_call 로 읽기 툴은 바로 쓰고,
 * 쓰기 툴(알림·관심목록 변경 등)은 확인 카드를 띄운다 — 사람이 [확인] 을 눌러야 실행된다 (PLAN §39).
 *
 * OAuth 연결:
 *   웹  — 같은 탭에서 인가 서버로 이동 → 서버 콜백이 /settings/connect?mcp=ok 로 되돌린다
 *   앱  — 시스템 브라우저로 연다 (WKWebView 안에서 남의 로그인 화면을 띄우지 않는다).
 *         콜백 완료 페이지가 "앱으로 돌아가세요" 를 보여 주고, 앱이 앞으로 오면 목록을 다시 읽는다 (react-query 포커스 재조회)
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type McpAddInput, type McpListing, type McpServerStatus } from "../lib/api.ts";
import { isNativeApp } from "../lib/auth.ts";

const input = "min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent";
const btn = "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-40";
const primary = `${btn} bg-accent text-accent-ink`;
const subtle = `${btn} border border-line text-ink`;

type AuthChoice = "oauth" | "bearer" | "none";

const AUTH_LABEL: Record<McpServerStatus["auth"], string> = { oauth: "OAuth 로그인", headers: "고정 헤더", none: "인증 없음" };

/** OAuth 콜백이 붙여 준 결과 (?mcp=ok|error&msg=…) — 한 번 읽고 주소에서 지운다 */
function takeCallbackNotice(): { ok: boolean; message: string } | null {
	const q = new URLSearchParams(location.search);
	const r = q.get("mcp");
	if (!r) return null;
	const message = q.get("msg") ?? (r === "ok" ? "연결됐습니다" : "연결하지 못했습니다");
	history.replaceState(null, "", location.pathname);
	return { ok: r === "ok", message };
}

function statusText(s: McpServerStatus): { text: string; tone: "ok" | "warn" } {
	if (s.problem) return { text: s.problem, tone: "warn" };
	if (!s.connected) return { text: "연결 필요", tone: "warn" };
	if (s.auth === "oauth") return { text: "연결됨 · 자동 갱신", tone: "ok" };
	return { text: s.auth === "headers" ? `헤더 ${s.headerNames.join(", ")}` : "연결됨", tone: "ok" };
}

export function McpSettings() {
	const qc = useQueryClient();
	const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
	const [tests, setTests] = useState<Record<string, { ok: boolean; message: string }>>({});
	const [adding, setAdding] = useState(false);

	useEffect(() => setNotice(takeCallbackNotice()), []);

	// 앱에서 시스템 브라우저로 로그인하고 돌아오면 다시 읽는다 — 전역 기본값은 포커스 재조회를 끈다 (main.tsx)
	const list = useQuery({ queryKey: ["mcp"], queryFn: api.mcpServers, refetchOnWindowFocus: "always" });
	const set = (data: McpListing) => qc.setQueryData(["mcp"], data);

	const add = useMutation({ mutationFn: (i: McpAddInput) => api.addMcpServer(i), onSuccess: (d) => (set(d), setAdding(false)) });
	const remove = useMutation({ mutationFn: api.deleteMcpServer, onSuccess: set });
	const disconnect = useMutation({ mutationFn: api.disconnectMcp, onSuccess: set });
	const test = useMutation({
		mutationFn: async (id: string) => ({ id, r: await api.testMcp(id) }),
		onSuccess: ({ id, r }) => setTests((t) => ({ ...t, [id]: r })),
	});
	const connect = useMutation({
		mutationFn: (id: string) => api.startMcpOAuth(id, isNativeApp ? "app" : "web"),
		onSuccess: ({ url }) => {
			// 앱: WKWebView 밖(Safari)으로 — Capacitor 는 외부 주소의 window.open 을 시스템 브라우저로 넘긴다
			if (isNativeApp) window.open(url, "_blank");
			else location.assign(url);
		},
	});

	const data = list.data;
	const busy = add.isPending || remove.isPending || disconnect.isPending || connect.isPending;
	const error = add.error ?? remove.error ?? disconnect.error ?? connect.error;

	return (
		<section>
			<h2 className="mb-2 text-sm font-medium text-muted">MCP 서버</h2>
			<div className="space-y-3 rounded-xl border border-line p-3">
				{notice && (
					<p className={`rounded-lg bg-inset p-2 text-xs ${notice.ok ? "text-success" : "text-danger"}`}>
						{notice.message}
						<button className="ml-2 text-faint" onClick={() => setNotice(null)}>
							닫기
						</button>
					</p>
				)}
				{data && !data.oauthReady && (
					<p className="text-xs text-danger">서버에 AF_PUBLIC_URL 이 없어 OAuth 로그인(TradingView 등)을 할 수 없습니다. 관리자에게 요청하세요.</p>
				)}

				{data?.items.length === 0 && <p className="text-xs text-faint">연결된 서버가 없습니다.</p>}
				{data?.items.map((s) => {
					const st = statusText(s);
					const t = tests[s.id];
					return (
						<div key={s.id} className="space-y-1.5 border-b border-line pb-3 last:border-0 last:pb-0">
							<div className="flex items-baseline justify-between gap-2">
								<div className="min-w-0">
									<div className="truncate text-sm text-ink">{s.name}</div>
									<div className="truncate text-[11px] text-faint">
										{s.url} · {AUTH_LABEL[s.auth]}
									</div>
								</div>
								<span className={`shrink-0 text-[11px] ${st.tone === "ok" ? "text-success" : "text-danger"}`}>{st.text}</span>
							</div>
							<div className="flex flex-wrap items-center gap-2">
								{s.auth === "oauth" && !s.connected && (
									<button className={primary} disabled={busy || !data.oauthReady} onClick={() => connect.mutate(s.id)}>
										{connect.isPending && connect.variables === s.id ? "여는 중…" : "연결"}
									</button>
								)}
								{s.connected && (
									<button className={subtle} disabled={test.isPending} onClick={() => test.mutate(s.id)}>
										{test.isPending && test.variables === s.id ? "확인 중…" : "연결 테스트"}
									</button>
								)}
								{s.auth === "oauth" && s.connected && (
									<button className={subtle} disabled={busy} onClick={() => disconnect.mutate(s.id)}>
										연결 해제
									</button>
								)}
								<button
									className="shrink-0 text-xs text-faint"
									disabled={busy}
									onClick={() => {
										if (confirm(`${s.name} 을(를) 삭제할까요? 저장된 로그인도 함께 지웁니다.`)) remove.mutate(s.id);
									}}
								>
									삭제
								</button>
								{t && <span className={`text-xs ${t.ok ? "text-success" : "text-danger"}`}>{t.message}</span>}
							</div>
						</div>
					);
				})}

				<div className="flex flex-wrap gap-2 pt-1">
					{data?.presets
						.filter((p) => !p.added)
						.map((p) => (
							<button key={p.id} className={subtle} disabled={busy} onClick={() => add.mutate({ preset: p.id })}>
								+ {p.name}
							</button>
						))}
					{!adding && (
						<button className={subtle} disabled={busy} onClick={() => setAdding(true)}>
							+ 직접 추가
						</button>
					)}
				</div>
				{adding && <AddForm busy={busy} onAdd={(i) => add.mutate(i)} onCancel={() => setAdding(false)} />}
				{error && <p className="text-xs text-danger">{error.message}</p>}
			</div>
			<p className="mt-2 text-xs text-faint">
				에이전트는 조회는 바로 하고, 알림·관심목록 변경 같은 <b>쓰기는 확인 카드</b>로 묻습니다 — [확인] 을 눌러야 실행됩니다. 원격(https) 서버만
				추가할 수 있고, 로그인 토큰과 헤더 값은 암호화되어 서버에만 남습니다.
			</p>
		</section>
	);
}

function AddForm({ busy, onAdd, onCancel }: { busy: boolean; onAdd: (i: McpAddInput) => void; onCancel: () => void }) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [auth, setAuth] = useState<AuthChoice>("oauth");
	const [token, setToken] = useState("");
	const ready = name.trim() && url.trim() && (auth !== "bearer" || token.trim());

	return (
		<div className="space-y-2 rounded-lg bg-inset p-2">
			<div className="flex flex-col gap-2 sm:flex-row">
				<input className={`${input} sm:max-w-40`} placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} />
				<input className={input} placeholder="https://…/mcp" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" />
			</div>
			<div className="flex flex-col gap-2 sm:flex-row">
				<select
					value={auth}
					onChange={(e) => setAuth(e.target.value as AuthChoice)}
					className="shrink-0 rounded-lg border border-line bg-card px-2 py-2 text-sm text-ink outline-none"
				>
					<option value="oauth">OAuth 로그인</option>
					<option value="bearer">Bearer 토큰</option>
					<option value="none">인증 없음</option>
				</select>
				{auth === "bearer" && (
					<input className={input} type="password" placeholder="토큰" value={token} onChange={(e) => setToken(e.target.value)} />
				)}
			</div>
			<div className="flex gap-2">
				<button
					className={primary}
					disabled={busy || !ready}
					onClick={() => onAdd(auth === "bearer" ? { name, url, auth, token } : { name, url, auth })}
				>
					추가
				</button>
				<button className={subtle} onClick={onCancel}>
					취소
				</button>
			</div>
		</div>
	);
}
