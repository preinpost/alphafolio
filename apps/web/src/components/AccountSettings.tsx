/**
 * 설정 — 내 계정 + 관리자 (PLAN §25).
 *
 *   내 계정  비밀번호 변경, 모든 기기 로그아웃 (가입 계정만 — 서버 설정 계정은 env 로 관리)
 *   관리자   1회용 초대 코드 발급·취소, 계정 목록·비활성화·임시 비밀번호 (env 계정만 보인다)
 *
 * 초대 코드와 임시 비밀번호는 서버에 원문이 남지 않는다 — 발급 직후 이 화면에서만 보인다.
 */
import type { MeDto, SignupInviteDto } from "@alphafolio/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../lib/api.ts";
import { API_BASE, setToken } from "../lib/auth.ts";
import { toast } from "../lib/toast.ts";
import { CopyIcon, InfoIcon, LinkIcon, XIcon } from "./icons.tsx";

const PW_MIN = 10;

const INVITE_STATUS: Record<SignupInviteDto["status"], { label: string; tone: string }> = {
	pending: { label: "대기", tone: "accent" },
	used: { label: "사용됨", tone: "ok" },
	expired: { label: "만료", tone: "" },
	revoked: { label: "취소", tone: "" },
};

const date = (iso: string | null): string => (iso ? iso.slice(0, 10) : "—");

async function copy(text: string, done: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		toast(done);
	} catch {
		toast("복사하지 못했습니다 — 길게 눌러 직접 선택하세요");
	}
}

/** 한 번만 보여줄 값 — 복사 버튼과 경고. link 가 있으면 링크 복사도 */
function OneTime({ label, value, link, onDone }: { label: string; value: string; link?: string; onDone: () => void }) {
	return (
		<div className="mt-3">
			<div className="one-time">
				<span className="mono text-[15px] tracking-wider">{value}</span>
				<button className="btn btn-ghost btn-sm" onClick={() => void copy(value, "복사했습니다")}>
					<CopyIcon size={14} />
					복사
				</button>
				{link && (
					<button className="btn btn-ghost btn-sm" onClick={() => void copy(link, "가입 링크를 복사했습니다")}>
						<LinkIcon size={14} />
						링크
					</button>
				)}
				<button className="icon-btn" onClick={onDone} aria-label="닫기">
					<XIcon size={16} />
				</button>
			</div>
			<p className="mt-2 text-[12.5px] text-muted">{label} — 지금만 보입니다. 닫으면 다시 볼 수 없어요.</p>
		</div>
	);
}

export function MyAccount({ me }: { me: MeDto }) {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [problem, setProblem] = useState<{ field: "current" | "next" | "confirm"; text: string } | null>(null);

	const change = useMutation({
		mutationFn: () => api.changePassword(current, next),
		onSuccess: async ({ token }) => {
			// 이전 토큰은 서버에서 무효가 됐다 — 이 기기는 새 토큰으로 이어간다
			await setToken(token);
			setCurrent("");
			setNext("");
			setConfirm("");
			toast("비밀번호를 바꿨습니다", { sub: "다른 기기에서는 다시 로그인해야 합니다" });
		},
	});
	const logoutAll = useMutation({
		mutationFn: api.logoutAll,
		onSuccess: async ({ token }) => {
			await setToken(token);
			toast("다른 기기의 로그인을 모두 끊었습니다");
		},
	});

	if (me.source !== "db") {
		return (
			<section className="card">
				<div className="card-h">
					<span className="avatar">{me.user.slice(0, 2).toUpperCase()}</span>
					<h2>{me.user}</h2>
					<span className="badge">서버 설정 계정 · 관리자</span>
				</div>
				<div className="card-b">
					<div className="notice">
						<InfoIcon size={16} />
						<span>
							비밀번호는 서버 환경변수(<span className="mono">AF_USERS</span> / <span className="mono">AF_AUTH_PASSWORD</span>)에서 바꿉니다. 모든 로그인을 끊으려면{" "}
							<span className="mono">AF_AUTH_SECRET</span> 을 바꾸고 서버를 다시 시작하세요.
						</span>
					</div>
				</div>
			</section>
		);
	}

	function submit(e: FormEvent): void {
		e.preventDefault();
		const p = !current
			? ({ field: "current", text: "현재 비밀번호를 입력하세요." } as const)
			: next.length < PW_MIN
				? ({ field: "next", text: `새 비밀번호는 ${PW_MIN}자 이상이어야 합니다.` } as const)
				: next !== confirm
					? ({ field: "confirm", text: "새 비밀번호가 서로 다릅니다." } as const)
					: null;
		setProblem(p);
		if (!p) change.mutate();
	}

	const msg = problem?.text ?? change.error?.message;

	return (
		<>
			<form className="card" onSubmit={submit} noValidate>
				<div className="card-h">
					<h2>비밀번호 바꾸기</h2>
					<span className="spacer" />
					<span className="eyebrow font-medium">{me.user}</span>
				</div>
				<div className="card-b">
					<div className="form-grid">
						<label className="field full">
							<span>현재 비밀번호</span>
							<input
								className="input"
								type="password"
								autoComplete="current-password"
								value={current}
								aria-invalid={problem?.field === "current"}
								onChange={(e) => setCurrent(e.target.value)}
							/>
						</label>
						<label className="field">
							<span>새 비밀번호</span>
							<input
								className="input"
								type="password"
								autoComplete="new-password"
								placeholder={`${PW_MIN}자 이상`}
								value={next}
								aria-invalid={problem?.field === "next"}
								onChange={(e) => setNext(e.target.value)}
							/>
						</label>
						<label className="field">
							<span>새 비밀번호 확인</span>
							<input
								className="input"
								type="password"
								autoComplete="new-password"
								value={confirm}
								aria-invalid={problem?.field === "confirm" || (confirm.length > 0 && confirm !== next)}
								onChange={(e) => setConfirm(e.target.value)}
							/>
						</label>
					</div>
					<div className="form-actions">
						{msg && <span className="msg bad">{msg}</span>}
						<button className="btn btn-secondary" type="submit" disabled={change.isPending}>
							{change.isPending ? "바꾸는 중…" : "비밀번호 바꾸기"}
						</button>
					</div>
				</div>
			</form>

			<section className="card">
				<div className="card-h">
					<h2>다른 기기</h2>
				</div>
				<div className="row border-t border-line">
					<span className="grow">
						<span className="name">이 기기만 남기고 모두 로그아웃</span>
						<span className="meta">폰을 잃어버렸거나 남의 기기에서 로그인했을 때</span>
					</span>
					<button
						className="btn btn-danger btn-sm"
						disabled={logoutAll.isPending}
						onClick={() => {
							if (window.confirm("다른 모든 기기에서 로그아웃할까요?")) logoutAll.mutate();
						}}
					>
						모든 기기 로그아웃
					</button>
				</div>
				{logoutAll.error && <p className="field-err px-5 pb-4">{logoutAll.error.message}</p>}
			</section>
		</>
	);
}

export function AdminPanel({ me }: { me: MeDto }) {
	const qc = useQueryClient();
	const invites = useQuery({ queryKey: ["admin-invites"], queryFn: api.invites });
	const accounts = useQuery({ queryKey: ["admin-accounts"], queryFn: api.accounts });
	const [note, setNote] = useState("");
	const [days, setDays] = useState(7);
	const [issued, setIssued] = useState<{ label: string; value: string; link?: string } | null>(null);
	/** 임시 비밀번호 — 계정 카드에 따로 보인다 */
	const [temp, setTemp] = useState<{ label: string; value: string } | null>(null);
	const [error, setError] = useState<string | null>(null);

	const act = useMutation({
		mutationFn: async ({ run }: { run: () => Promise<unknown>; done?: string }) => run(),
		onMutate: () => setError(null),
		onSuccess: (_r, v) => {
			if (v.done) toast(v.done);
		},
		onError: (e: Error) => setError(e.message),
		onSettled: async () => {
			await qc.invalidateQueries({ queryKey: ["admin-invites"] });
			await qc.invalidateQueries({ queryKey: ["admin-accounts"] });
		},
	});

	const members = (accounts.data ?? []).filter((a) => a.source === "db");
	const envAccounts = (accounts.data ?? []).filter((a) => a.source === "env").map((a) => a.name);

	return (
		<>
			<section className="card">
				<div className="card-h">
					<h2>초대 코드</h2>
					<span className="spacer" />
					<span className="eyebrow font-medium">한 번 쓰면 끝나는 코드</span>
				</div>
				<div className="card-b">
					<form
						className="flex flex-wrap gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							act.mutate({
								run: async () => {
									const r = await api.createInvite(note, days);
									setNote("");
									setIssued({
										label: `초대 코드 (${r.expiresAt.slice(0, 10)}까지)`,
										value: r.code,
										link: `${API_BASE || location.origin}/#join=${r.code}`,
									});
								},
							});
						}}
					>
						<input className="input min-w-40 flex-1" placeholder="누구에게 (메모, 선택)" aria-label="메모" value={note} onChange={(e) => setNote(e.target.value)} />
						<select className="input w-auto" aria-label="유효 기간" value={days} onChange={(e) => setDays(Number(e.target.value))}>
							<option value={1}>1일</option>
							<option value={7}>7일</option>
							<option value={30}>30일</option>
						</select>
						<button type="submit" className="btn btn-primary" disabled={act.isPending}>
							<LinkIcon size={15} />
							발급
						</button>
					</form>
					{issued && <OneTime {...issued} onDone={() => setIssued(null)} />}
				</div>
				{(invites.data ?? []).length > 0 && (
					<div className="rows border-t border-line">
						{invites.data?.slice(0, 20).map((i) => {
							const st = INVITE_STATUS[i.status];
							return (
								<div key={i.id} className="row">
									<span className={`badge ${st.tone}`}>{st.label}</span>
									<span className="grow">
										<span className="name">{i.note ?? "(메모 없음)"}</span>
										<span className="meta">
											{date(i.createdAt)} 발급
											{i.usedBy ? ` · ${i.usedBy} 가입` : ""}
											{i.status === "pending" ? ` · ${date(i.expiresAt)}까지` : ""}
										</span>
									</span>
									{i.status === "pending" && (
										<button
											className="btn btn-ghost btn-sm text-danger"
											disabled={act.isPending}
											onClick={() => act.mutate({ run: () => api.revokeSignupInvite(i.id), done: "초대 코드를 취소했습니다" })}
										>
											취소
										</button>
									)}
								</div>
							);
						})}
					</div>
				)}
			</section>

			<section className="card">
				<div className="card-h">
					<h2>
						계정<span className="count">{members.length + envAccounts.length}</span>
					</h2>
				</div>
				<div className="rows border-t border-line">
					{envAccounts.map((name) => (
						<div key={name} className="row">
							<span className="avatar">{name.slice(0, 2).toUpperCase()}</span>
							<span className="grow">
								<span className="name">{name}</span>
								<span className="meta">관리자 · 서버 설정 계정{name === me.user ? " · 나" : ""}</span>
							</span>
						</div>
					))}
					{members.map((a) => (
						<div key={a.name} className="row flex-wrap">
							<span className="avatar">{a.name.slice(0, 2).toUpperCase()}</span>
							<span className="grow">
								<span className="name">
									{a.name}
									{a.disabled && <span className="badge bad ml-2">비활성</span>}
								</span>
								<span className="meta">
									{date(a.createdAt)} 가입{a.invitedBy ? ` · ${a.invitedBy} 초대` : ""}
								</span>
							</span>
							<span className="flex shrink-0 gap-1">
								<button
									className="btn btn-ghost btn-sm"
									disabled={act.isPending}
									onClick={() => {
										if (window.confirm(`${a.name} 님의 비밀번호를 임시 비밀번호로 바꿀까요? 기존 로그인은 모두 끊깁니다.`)) {
											act.mutate({
												run: async () => {
													const r = await api.resetAccountPassword(a.name);
													setTemp({ label: `${a.name} 임시 비밀번호`, value: r.password });
												},
											});
										}
									}}
								>
									임시 비밀번호
								</button>
								<button
									className={`btn btn-ghost btn-sm ${a.disabled ? "" : "text-danger"}`}
									disabled={act.isPending}
									onClick={() => {
										if (a.disabled || window.confirm(`${a.name} 님을 비활성화할까요? 바로 로그아웃되고 로그인할 수 없습니다. 기록은 남습니다.`)) {
											act.mutate({ run: () => api.setAccountDisabled(a.name, !a.disabled), done: a.disabled ? `${a.name} 님을 다시 켰습니다` : `${a.name} 님을 비활성화했습니다` });
										}
									}}
								>
									{a.disabled ? "다시 켜기" : "비활성화"}
								</button>
							</span>
						</div>
					))}
					{members.length === 0 && <div className="empty">가입한 계정이 아직 없습니다. 위에서 초대 코드를 발급하세요.</div>}
				</div>
				{temp && (
					<div className="px-5 pb-4 max-md:px-4">
						<OneTime {...temp} onDone={() => setTemp(null)} />
					</div>
				)}
				{error && <p className="field-err px-5 pb-4">{error}</p>}
			</section>
		</>
	);
}
