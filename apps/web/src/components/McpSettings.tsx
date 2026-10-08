/**
 * 설정 → MCP 서버 (PLAN §38) — 연결한 서버 · 서버별 툴(이름·설명 원문·파라미터) · 판정(바로 실행 / 확인 카드).
 *
 * 추가·연결·삭제는 여기서만 한다 (에이전트 툴 없음). 에이전트는 mcp_call 로 읽기 툴은 바로 쓰고,
 * 쓰기 툴(알림·관심목록 변경 등)은 확인 카드를 띄운다 — 사람이 [확인] 을 눌러야 실행된다 (PLAN §39).
 * 판정 규칙은 packages/mcp/src/policy.ts — 화면은 서버가 판정한 결과를 그대로 보여 준다.
 *
 * OAuth 연결:
 *   웹  — 같은 탭에서 인가 서버로 이동 → 서버 콜백이 /settings/mcp?mcp=ok 로 되돌린다
 *   앱  — 시스템 브라우저로 연다 (WKWebView 안에서 남의 로그인 화면을 띄우지 않는다).
 *         콜백 완료 페이지가 "앱으로 돌아가세요" 를 보여 주고, 앱이 앞으로 오면 목록을 다시 읽는다 (react-query 포커스 재조회)
 */
import { useMutation, useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type McpAddInput, type McpListing, type McpServerStatus, type McpToolsView, type McpToolView } from "../lib/api.ts";
import { isNativeApp } from "../lib/auth.ts";
import { toast } from "../lib/toast.ts";
import { AlertIcon, InfoIcon, PlusIcon, RefreshIcon, SearchIcon, TrashIcon } from "./icons.tsx";

type AuthChoice = "oauth" | "bearer" | "none";
type Filter = "all" | "read" | "confirm";

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

/** 로고 자리 — 대문자 머리글자가 둘 이상이면 그것 (TradingView → TV, DeepWiki → DW), 아니면 이름 앞 두 글자 */
function square(s: McpServerStatus): string {
	const caps = s.name.match(/[A-Z]/g) ?? [];
	return caps.length >= 2 ? caps.slice(0, 2).join("") : s.name.replace(/\s/g, "").slice(0, 2).toUpperCase();
}

function counts(q: UseQueryResult<McpToolsView> | undefined): string {
	if (!q || q.isLoading) return "툴 목록 받는 중…";
	const tools = q.data?.tools;
	if (!tools) return q.data?.error ? "툴 목록을 받지 못했습니다" : "연결하면 툴 목록을 받아 옵니다";
	const r = tools.filter((t) => t.mode === "read").length;
	return `툴 ${tools.length}개 · 바로 ${r} · 확인 ${tools.length - r}`;
}

/** "오늘 14:20" / "10월 7일 14:20" */
function stamp(ms: number): string {
	const d = new Date(ms);
	const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	return d.toDateString() === new Date().toDateString() ? `오늘 ${hm}` : `${d.getMonth() + 1}월 ${d.getDate()}일 ${hm}`;
}

/** 서버 주소 검사 — 문구는 서버(packages/mcp/src/net.ts)와 같다. 최종 판단은 서버가 한다 (DNS 해석 포함) */
function checkUrl(v: string): string | null {
	let u: URL;
	try {
		u = new URL(v);
	} catch {
		return "URL 형식이 아닙니다";
	}
	if (u.protocol !== "https:") return "https 주소만 쓸 수 있습니다 (원격 MCP 서버)";
	if (u.username || u.password) return "주소에 계정 정보를 넣을 수 없습니다 — 인증은 헤더·OAuth 로";
	const h = u.hostname.replace(/^\[|\]$/g, "");
	if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(h)) return "내부 호스트는 쓸 수 없습니다";
	if (/^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h) || /^(::1|f[cd]|fe80:)/i.test(h)) {
		return "사설·내부 주소는 쓸 수 없습니다";
	}
	return null;
}

export function McpSettings() {
	const qc = useQueryClient();
	const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
	const [tests, setTests] = useState<Record<string, { ok: boolean; message: string }>>({});
	const [adding, setAdding] = useState(false);
	const [deleting, setDeleting] = useState<McpServerStatus | null>(null);
	const [selected, setSelected] = useState<string | null>(null);

	useEffect(() => setNotice(takeCallbackNotice()), []);

	// 앱에서 시스템 브라우저로 로그인하고 돌아오면 다시 읽는다 — 전역 기본값은 포커스 재조회를 끈다 (main.tsx)
	const list = useQuery({ queryKey: ["mcp"], queryFn: api.mcpServers, refetchOnWindowFocus: "always" });
	const items = list.data?.items ?? [];
	// 서버마다 툴 목록 — 서버가 10분 캐시하므로 화면은 5분 동안 다시 묻지 않는다
	const toolQueries = useQueries({
		queries: items.map((s) => ({
			// 연결 상태가 바뀌면 다른 목록이다 (프리셋 이름 → 서버 원문)
			queryKey: ["mcp-tools", s.id, s.connected],
			queryFn: () => api.mcpTools(s.id),
			staleTime: 5 * 60_000,
			retry: false,
		})),
	});
	const toolsOf = (id: string) => toolQueries[items.findIndex((s) => s.id === id)];

	const set = (data: McpListing) => qc.setQueryData(["mcp"], data);
	const refreshTools = () => void qc.invalidateQueries({ queryKey: ["mcp-tools"] });

	const add = useMutation({
		mutationFn: (i: McpAddInput) => api.addMcpServer(i),
		onSuccess: (d, input) => {
			set(d);
			setAdding(false);
			const added = "preset" in input ? d.items.find((s) => s.preset === input.preset) : d.items.find((s) => s.name === input.name);
			if (added) setSelected(added.id);
			toast("서버를 추가했습니다");
		},
	});
	const remove = useMutation({
		mutationFn: api.deleteMcpServer,
		onSuccess: (d) => {
			set(d);
			refreshTools();
			toast("서버를 삭제했습니다");
		},
		onError: (e: Error) => toast(`삭제하지 못했습니다: ${e.message}`),
	});
	const disconnect = useMutation({
		mutationFn: api.disconnectMcp,
		onSuccess: (d, id) => {
			set(d);
			setTests(({ [id]: _, ...rest }) => rest);
			refreshTools();
			toast("연결을 해제했습니다");
		},
	});
	const test = useMutation({
		mutationFn: async (id: string) => ({ id, r: await api.testMcp(id) }),
		onSuccess: ({ id, r }) => {
			setTests((t) => ({ ...t, [id]: r }));
			// 테스트가 툴 목록 캐시도 새로 받았다
			void qc.invalidateQueries({ queryKey: ["mcp-tools", id] });
		},
	});
	const connect = useMutation({
		mutationFn: (id: string) => api.startMcpOAuth(id, isNativeApp ? "app" : "web"),
		onSuccess: ({ url }) => {
			// 앱: WKWebView 밖(Safari)으로 — Capacitor 는 외부 주소의 window.open 을 시스템 브라우저로 넘긴다
			if (isNativeApp) window.open(url, "_blank");
			else location.assign(url);
		},
		onError: (e: Error) => toast(`연결을 시작하지 못했습니다: ${e.message}`),
	});

	const data = list.data;
	const busy = add.isPending || remove.isPending || disconnect.isPending || connect.isPending;
	const presets = data?.presets.filter((p) => !p.added) ?? [];
	const current = items.find((s) => s.id === selected) ?? items[0];

	return (
		<>
			{notice && (
				<div className={`notice ${notice.ok ? "ok" : "bad"}`} role="status">
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
			{data && !data.storageReady && (
				<div className="notice bad">
					<AlertIcon size={16} />
					<span>MCP 설정 저장소가 준비되지 않았습니다 (서버 DB 미설정).</span>
				</div>
			)}

			<section className="card" aria-labelledby="mcp-servers-h">
				<div className="card-h">
					<h2 id="mcp-servers-h">연결한 서버</h2>
					<span className="spacer" />
					<span className="eyebrow font-medium">원격(https) 서버만</span>
				</div>
				<div className="rows border-t border-line">
					{list.isLoading && <div className="empty">불러오는 중…</div>}
					{data && items.length === 0 && <div className="empty">연결한 서버가 없습니다.</div>}
					{items.map((s) => {
						const st = statusOf(s);
						const t = tests[s.id];
						return (
							<div key={s.id} className="row conn-row">
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
										<span>{counts(toolsOf(s.id))}</span>
									</span>
									{t && <span className={`test-msg ${t.ok ? "ok-text" : "danger-text"}`}>{t.message}</span>}
								</span>
								<span className="acts">
									{s.auth === "oauth" && !s.connected && (
										<button className="btn btn-primary btn-sm" disabled={busy || !data?.oauthReady} onClick={() => connect.mutate(s.id)}>
											{connect.isPending && connect.variables === s.id ? (
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
										<button className="btn btn-ghost btn-sm" disabled={test.isPending} onClick={() => test.mutate(s.id)}>
											{test.isPending && test.variables === s.id ? (
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
										<button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => disconnect.mutate(s.id)}>
											연결 해제
										</button>
									)}
									<button className="icon-btn" disabled={busy} aria-label={`${s.name} 삭제`} title="삭제" onClick={() => setDeleting(s)}>
										<TrashIcon size={16} />
									</button>
								</span>
							</div>
						);
					})}
				</div>
				<div className="mcp-add">
					{(presets.length > 0 || !adding) && (
						<div className="add-btns">
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
					{adding && (
						<AddForm
							busy={add.isPending}
							serverError={add.error?.message ?? null}
							onAdd={(i) => add.mutate(i)}
							onCancel={() => {
								setAdding(false);
								add.reset();
							}}
						/>
					)}
					<p className="foot-note">
						에이전트는 조회는 바로 하고, 알림·관심목록 변경 같은 <b>쓰기는 확인 카드</b>로 묻습니다. [확인]을 눌러야 실행됩니다. 로그인 토큰과 헤더 값은 암호화되어 서버에만
						남습니다.
					</p>
				</div>
			</section>

			{current && (
				<ToolsCard
					key={current.id}
					servers={items}
					current={current}
					query={toolsOf(current.id)}
					countOf={(id) => toolsOf(id)?.data?.tools?.length ?? null}
					onPick={setSelected}
				/>
			)}

			<DeleteSheet
				server={deleting}
				onCancel={() => setDeleting(null)}
				onConfirm={(s) => {
					setDeleting(null);
					remove.mutate(s.id);
				}}
			/>
		</>
	);
}

function ToolsCard({
	servers,
	current,
	query,
	countOf,
	onPick,
}: {
	servers: McpServerStatus[];
	current: McpServerStatus;
	query: UseQueryResult<McpToolsView> | undefined;
	countOf: (id: string) => number | null;
	onPick: (id: string) => void;
}) {
	const qc = useQueryClient();
	const [filter, setFilter] = useState<Filter>("all");
	const [q, setQ] = useState("");
	const refresh = useMutation({
		mutationFn: () => api.refreshMcpTools(current.id),
		onSuccess: (view) => {
			qc.setQueryData(["mcp-tools", current.id, current.connected], view);
			toast(view.error ? `다시 받지 못했습니다: ${view.error}` : "툴 목록을 다시 받았습니다");
		},
	});

	const view = query?.data;
	const tools = view?.tools ?? [];
	const reads = tools.filter((t) => t.mode === "read").length;
	const needle = q.trim().toLowerCase();
	const hit = tools.filter(
		(t) => (filter === "all" || t.mode === filter) && (!needle || [t.name, t.label, t.title, t.description].some((v) => v?.toLowerCase().includes(needle))),
	);

	const refreshBtn = (
		<button className="icon-btn" onClick={() => refresh.mutate()} disabled={refresh.isPending} aria-label="툴 목록 다시 받기" title="다시 받기">
			{refresh.isPending ? <span className="spin" /> : <RefreshIcon size={16} />}
		</button>
	);

	let meta = null;
	if (!query || query.isLoading)
		meta = (
			<div className="tools-meta">
				<span className="spin" />
				<span className="t">툴 목록을 받는 중…</span>
			</div>
		);
	else if (view?.error)
		meta = (
			<div className="tools-meta bad">
				<AlertIcon size={15} />
				<span className="t">{view.error}</span>
				{current.connected && refreshBtn}
			</div>
		);
	else if (view?.source === "preset")
		meta = (
			<div className="tools-meta">
				<InfoIcon size={15} />
				<span className="t">연결 전이라 이름과 판정만 보입니다. 이름은 {current.name} 프리셋 목록 기준이고, 설명은 연결하면 서버에서 받아 옵니다.</span>
			</div>
		);
	else if (view?.source === "server")
		meta = (
			<div className="tools-meta">
				<InfoIcon size={15} />
				<span className="t">
					설명은 서버가 보낸 원문 그대로입니다. 에이전트도 같은 설명을 보고 툴을 고릅니다.
					{view.fetchedAt ? ` · ${stamp(view.fetchedAt)} 받음` : ""} · 10분 캐시
				</span>
				{refreshBtn}
			</div>
		);

	return (
		<section className="card" aria-labelledby="mcp-tools-h">
			<div className="card-h tools-h">
				<h2 id="mcp-tools-h">툴</h2>
				<span className="spacer" />
				{servers.length > 1 && (
					<div className="seg max-w-full overflow-x-auto" role="group" aria-label="서버 고르기">
						{servers.map((s) => {
							const n = countOf(s.id);
							return (
								<button key={s.id} aria-pressed={s.id === current.id} onClick={() => onPick(s.id)}>
									{s.name}
									{n !== null && <span className="num"> {n}</span>}
								</button>
							);
						})}
					</div>
				)}
			</div>
			{meta}
			{tools.length > 0 && (
				<div className="tools-bar">
					<label className="search-field">
						<SearchIcon size={15} />
						<span className="sr-only">툴 검색</span>
						<input className="input input-sm" type="search" placeholder="이름·설명으로 찾기" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
					</label>
					<div className="hscroll" role="group" aria-label="판정으로 거르기">
						{(
							[
								["all", "전체", tools.length],
								["read", "바로 실행", reads],
								["confirm", "확인 카드", tools.length - reads],
							] as const
						).map(([v, label, n]) => (
							<button key={v} className="chip" aria-pressed={filter === v} onClick={() => setFilter(v)}>
								{label} <span className="num">{n}</span>
							</button>
						))}
					</div>
				</div>
			)}
			<div className="rows border-t border-line">
				{view && !view.tools && !view.error && <div className="empty">{current.name}에 연결하면 툴 목록을 받아 옵니다.</div>}
				{view?.tools && tools.length === 0 && <div className="empty">서버가 보낸 툴이 없습니다.</div>}
				{tools.length > 0 && hit.length === 0 && <div className="empty">‘{q.trim()}’와 맞는 툴이 없습니다.</div>}
				{(
					[
						["read", "바로 실행 — 에이전트가 바로 호출"],
						["confirm", "확인 카드 — 사람이 [확인]을 눌러야 실행"],
					] as const
				).map(([mode, title]) => {
					const group = hit.filter((t) => t.mode === mode);
					if (group.length === 0) return null;
					return (
						<div key={mode}>
							<div className="t-grp">
								{title} · <span className="num">{group.length}</span>
							</div>
							<div className="rows border-t border-line">
								{group.map((t) => (
									<ToolRow key={t.name} t={t} />
								))}
							</div>
						</div>
					);
				})}
			</div>
		</section>
	);
}

function ToolRow({ t }: { t: McpToolView }) {
	const heading = t.label ?? (t.title && t.title !== t.name ? t.title : null);
	return (
		// 판정 이유 (왜 바로 실행 / 확인 카드인지) 는 올리면
		<div className="row mcp-tool" title={t.reason}>
			<span className="grow">
				<span className="tn">{t.name}</span>
				{heading && <span className="tl">{heading}</span>}
				<span className="td">{t.description ?? "설명은 연결 후 표시"}</span>
				{t.params.length > 0 && (
					<span className="tp" aria-label="파라미터">
						{t.params.map((p) => (
							<span key={p.name} title={p.description ?? undefined}>
								<b>{p.name}</b>
								{p.required ? "*" : ""}
								{p.type ? `: ${p.type}` : ""}
							</span>
						))}
					</span>
				)}
				{t.note && <span className="td">{t.note}</span>}
			</span>
			{t.mode === "confirm" && (
				<span className={`badge ${t.destructive ? "bad" : "warn"}`} title={t.reason}>
					{t.destructive ? "확인 · 삭제" : "확인 카드"}
				</span>
			)}
		</div>
	);
}

function AddForm({ busy, serverError, onAdd, onCancel }: { busy: boolean; serverError: string | null; onAdd: (i: McpAddInput) => void; onCancel: () => void }) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [auth, setAuth] = useState<AuthChoice>("oauth");
	const [token, setToken] = useState("");
	const [errors, setErrors] = useState<{ name?: string; url?: string; token?: string }>({});
	const refs = { name: useRef<HTMLInputElement>(null), url: useRef<HTMLInputElement>(null), token: useRef<HTMLInputElement>(null) };

	useEffect(() => refs.name.current?.focus(), []);

	function submit(e: FormEvent): void {
		e.preventDefault();
		const urlError = url.trim() ? checkUrl(url.trim()) : "주소를 입력하세요.";
		const next = {
			...(name.trim() ? {} : { name: "이름을 입력하세요." }),
			...(urlError ? { url: urlError } : {}),
			...(auth === "bearer" && !token.trim() ? { token: "토큰을 입력하세요." } : {}),
		};
		setErrors(next);
		const first = (["name", "url", "token"] as const).find((k) => next[k]);
		if (first) return refs[first].current?.focus();
		onAdd(auth === "bearer" ? { name: name.trim(), url: url.trim(), auth, token: token.trim() } : { name: name.trim(), url: url.trim(), auth });
	}

	return (
		<form className="add-form" onSubmit={submit} noValidate>
			<div className="form-grid">
				<label className="field">
					<span>이름</span>
					<input ref={refs.name} className="input" autoComplete="off" placeholder="예: 사내 문서 검색" value={name} aria-invalid={!!errors.name} onChange={(e) => setName(e.target.value)} />
					{errors.name && <span className="field-err">{errors.name}</span>}
				</label>
				<label className="field">
					<span>주소</span>
					<input
						ref={refs.url}
						className="input mono"
						inputMode="url"
						autoComplete="off"
						placeholder="https://…/mcp"
						value={url}
						aria-invalid={!!errors.url}
						onChange={(e) => setUrl(e.target.value)}
					/>
					{errors.url && <span className="field-err">{errors.url}</span>}
				</label>
				<label className="field">
					<span>인증</span>
					<select className="input" value={auth} onChange={(e) => setAuth(e.target.value as AuthChoice)}>
						<option value="oauth">OAuth 로그인</option>
						<option value="bearer">Bearer 토큰</option>
						<option value="none">인증 없음</option>
					</select>
				</label>
				{auth === "bearer" && (
					<label className="field">
						<span>토큰</span>
						<input ref={refs.token} className="input mono" type="password" autoComplete="off" value={token} aria-invalid={!!errors.token} onChange={(e) => setToken(e.target.value)} />
						{errors.token && <span className="field-err">{errors.token}</span>}
					</label>
				)}
			</div>
			<div className="form-actions">
				{serverError && <span className="msg bad">{serverError}</span>}
				<button className="btn btn-ghost" type="button" onClick={onCancel}>
					취소
				</button>
				<button className="btn btn-primary" type="submit" disabled={busy}>
					{busy ? "추가하는 중…" : "추가"}
				</button>
			</div>
		</form>
	);
}

/** 삭제 확인 — 저장된 로그인·헤더도 함께 지워지고 챗에서 더 못 쓴다 */
function DeleteSheet({ server, onCancel, onConfirm }: { server: McpServerStatus | null; onCancel: () => void; onConfirm: (s: McpServerStatus) => void }) {
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
