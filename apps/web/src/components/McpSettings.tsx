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
import { useEffect, useState, type FormEvent } from "react";
import { api, type McpAddInput, type McpListing, type McpServerStatus } from "../lib/api.ts";
import { isNativeApp } from "../lib/auth.ts";
import { toast } from "../lib/toast.ts";
import { AlertIcon, PlusIcon, TrashIcon } from "./icons.tsx";

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

function statusOf(s: McpServerStatus): { text: string; tone: "ok" | "warn" | "bad" } {
	if (s.problem) return { text: s.problem, tone: "bad" };
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

	const add = useMutation({
		mutationFn: (i: McpAddInput) => api.addMcpServer(i),
		onSuccess: (d) => {
			set(d);
			setAdding(false);
			toast("서버를 추가했습니다");
		},
	});
	const remove = useMutation({ mutationFn: api.deleteMcpServer, onSuccess: (d) => (set(d), toast("서버를 삭제했습니다")) });
	const disconnect = useMutation({ mutationFn: api.disconnectMcp, onSuccess: (d) => (set(d), toast("연결을 해제했습니다")) });
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
	const presets = data?.presets.filter((p) => !p.added) ?? [];

	return (
		<section className="card">
			<div className="card-h">
				<h2>MCP 서버</h2>
				<span className="spacer" />
				<span className="eyebrow font-medium">TradingView 등 외부 도구</span>
			</div>

			{(notice || (data && !data.oauthReady)) && (
				<div className="card-b flex flex-col gap-2">
					{notice && (
						<div className={`notice ${notice.ok ? "ok" : "bad"}`}>
							<AlertIcon size={16} />
							<span className="flex-1">{notice.message}</span>
							<button className="btn btn-ghost btn-sm" onClick={() => setNotice(null)}>
								닫기
							</button>
						</div>
					)}
					{data && !data.oauthReady && (
						<div className="notice warn">
							<AlertIcon size={16} />
							<span>
								서버에 <span className="mono">AF_PUBLIC_URL</span> 이 없어 OAuth 로그인(TradingView 등)을 할 수 없습니다. 관리자에게 요청하세요.
							</span>
						</div>
					)}
				</div>
			)}

			<div className="rows border-t border-line">
				{data?.items.length === 0 && <div className="empty">연결된 서버가 없습니다.</div>}
				{data?.items.map((s) => {
					const st = statusOf(s);
					const t = tests[s.id];
					return (
						<div key={s.id} className="row flex-wrap items-start">
							<span className="grow">
								<span className="name flex items-center gap-2">
									{s.name}
									<span className={`badge ${st.tone}`}>{st.text}</span>
								</span>
								<span className="meta">
									<span className="mono">{s.url}</span> · {AUTH_LABEL[s.auth]}
								</span>
								{t && <span className={`meta ${t.ok ? "ok-text" : "danger-text"}`}>{t.message}</span>}
							</span>
							<span className="flex shrink-0 flex-wrap items-center gap-1">
								{s.auth === "oauth" && !s.connected && (
									<button className="btn btn-primary btn-sm" disabled={busy || !data.oauthReady} onClick={() => connect.mutate(s.id)}>
										{connect.isPending && connect.variables === s.id ? "여는 중…" : "연결"}
									</button>
								)}
								{s.connected && (
									<button className="btn btn-ghost btn-sm" disabled={test.isPending} onClick={() => test.mutate(s.id)}>
										{test.isPending && test.variables === s.id ? "확인 중…" : "연결 테스트"}
									</button>
								)}
								{s.auth === "oauth" && s.connected && (
									<button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => disconnect.mutate(s.id)}>
										연결 해제
									</button>
								)}
								<button
									className="icon-btn"
									disabled={busy}
									aria-label={`${s.name} 삭제`}
									title="삭제"
									onClick={() => {
										if (confirm(`${s.name} 을(를) 삭제할까요? 저장된 로그인도 함께 지웁니다.`)) remove.mutate(s.id);
									}}
								>
									<TrashIcon size={16} />
								</button>
							</span>
						</div>
					);
				})}
			</div>

			<div className="flex flex-col gap-3 border-t border-line px-5 py-4 max-md:px-4">
				{(presets.length > 0 || !adding) && (
					<div className="flex flex-wrap gap-2">
						{presets.map((p) => (
							<button key={p.id} className="btn btn-secondary btn-sm" disabled={busy} onClick={() => add.mutate({ preset: p.id })}>
								<PlusIcon size={14} />
								{p.name}
							</button>
						))}
						{!adding && (
							<button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setAdding(true)}>
								<PlusIcon size={14} />
								직접 추가
							</button>
						)}
					</div>
				)}
				{adding && <AddForm busy={busy} onAdd={(i) => add.mutate(i)} onCancel={() => setAdding(false)} />}
				{error && <p className="field-err">{error.message}</p>}
				<p className="text-[12.5px] text-muted">
					에이전트는 조회는 바로 하고, 알림·관심목록 변경 같은 <b>쓰기는 확인 카드</b>로 묻습니다 — [확인] 을 눌러야 실행됩니다. 원격(https) 서버만 추가할 수 있고, 로그인
					토큰과 헤더 값은 암호화되어 서버에만 남습니다.
				</p>
			</div>
		</section>
	);
}

function AddForm({ busy, onAdd, onCancel }: { busy: boolean; onAdd: (i: McpAddInput) => void; onCancel: () => void }) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [auth, setAuth] = useState<AuthChoice>("oauth");
	const [token, setToken] = useState("");
	const ready = name.trim() && url.trim() && (auth !== "bearer" || token.trim());

	function submit(e: FormEvent): void {
		e.preventDefault();
		if (!ready) return;
		onAdd(auth === "bearer" ? { name, url, auth, token } : { name, url, auth });
	}

	return (
		<form className="inline-edit rounded-[var(--r)]" onSubmit={submit}>
			<div className="form-grid">
				<label className="field">
					<span>이름</span>
					<input className="input input-sm" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
				</label>
				<label className="field">
					<span>주소</span>
					<input className="input input-sm mono" placeholder="https://…/mcp" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} />
				</label>
				<label className="field">
					<span>인증</span>
					<select className="input input-sm" value={auth} onChange={(e) => setAuth(e.target.value as AuthChoice)}>
						<option value="oauth">OAuth 로그인</option>
						<option value="bearer">Bearer 토큰</option>
						<option value="none">인증 없음</option>
					</select>
				</label>
				{auth === "bearer" && (
					<label className="field">
						<span>토큰</span>
						<input className="input input-sm mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
					</label>
				)}
			</div>
			<div className="flex justify-end gap-2">
				<button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
					취소
				</button>
				<button type="submit" className="btn btn-primary btn-sm" disabled={busy || !ready}>
					추가
				</button>
			</div>
		</form>
	);
}
