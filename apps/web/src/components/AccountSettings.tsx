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
import { useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { setToken } from "../lib/auth.ts";

const input = "min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent";
const btn = "shrink-0 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-40";
const primary = `${btn} bg-accent text-accent-ink`;
const subtle = `${btn} border border-line text-ink active:bg-hover`;

const INVITE_STATUS: Record<SignupInviteDto["status"], string> = {
	pending: "대기",
	used: "사용됨",
	expired: "만료",
	revoked: "취소",
};

const date = (iso: string | null): string => (iso ? iso.slice(0, 10) : "—");

function Card({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section>
			<h2 className="mb-2 text-sm font-medium text-muted">{title}</h2>
			<div className="space-y-4 rounded-xl border border-line bg-inset p-4">{children}</div>
		</section>
	);
}

/** 한 번만 보여줄 값 — 복사 버튼과 경고 */
function OneTime({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="rounded-lg border border-accent/40 bg-card p-3">
			<div className="text-xs text-muted">{label} — 지금만 보입니다. 닫으면 다시 볼 수 없어요.</div>
			<div className="mt-1 flex items-center gap-2">
				<code className="min-w-0 flex-1 truncate font-mono text-base tracking-wider text-ink select-all">{value}</code>
				<button
					className={subtle}
					onClick={() => {
						void navigator.clipboard?.writeText(value).then(() => setCopied(true));
					}}
				>
					{copied ? "복사됨" : "복사"}
				</button>
				<button className={subtle} onClick={onDone}>
					닫기
				</button>
			</div>
		</div>
	);
}

export function AccountSettings({ me }: { me: MeDto }) {
	return (
		<>
			<MyAccount me={me} />
			{me.admin && <AdminPanel me={me} />}
		</>
	);
}

function MyAccount({ me }: { me: MeDto }) {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [notice, setNotice] = useState<string | null>(null);

	const change = useMutation({
		mutationFn: () => api.changePassword(current, next),
		onSuccess: async ({ token }) => {
			// 이전 토큰은 서버에서 무효가 됐다 — 이 기기는 새 토큰으로 이어간다
			await setToken(token);
			setCurrent("");
			setNext("");
			setConfirm("");
			setNotice("비밀번호를 바꿨습니다. 다른 기기에서는 다시 로그인해야 합니다.");
		},
	});
	const logoutAll = useMutation({
		mutationFn: api.logoutAll,
		onSuccess: async ({ token }) => {
			await setToken(token);
			setNotice("다른 기기의 로그인을 모두 끊었습니다.");
		},
	});

	if (me.source !== "db") {
		return (
			<Card title="계정">
				<p className="text-sm text-ink">
					<b>{me.user}</b> <span className="text-xs text-muted">서버 설정 계정 · 관리자</span>
				</p>
				<p className="text-xs text-muted">
					비밀번호는 서버 환경변수(AF_USERS / AF_AUTH_PASSWORD)에서 바꿉니다. 모든 로그인을 끊으려면 AF_AUTH_SECRET 을
					바꾸고 서버를 다시 시작하세요.
				</p>
			</Card>
		);
	}

	const mismatch = confirm.length > 0 && confirm !== next;
	return (
		<Card title="계정">
			<p className="text-sm text-ink">
				<b>{me.user}</b>
			</p>
			<div className="space-y-2">
				<div className="text-xs font-medium text-muted">비밀번호 변경</div>
				<input className={`${input} w-full`} type="password" autoComplete="current-password" placeholder="현재 비밀번호" value={current} onChange={(e) => setCurrent(e.target.value)} />
				<input className={`${input} w-full`} type="password" autoComplete="new-password" placeholder="새 비밀번호 (10자 이상)" value={next} onChange={(e) => setNext(e.target.value)} />
				<div className="flex gap-2">
					<input className={input} type="password" autoComplete="new-password" placeholder="새 비밀번호 확인" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
					<button
						className={primary}
						disabled={change.isPending || !current || next.length < 10 || next !== confirm}
						onClick={() => {
							setNotice(null);
							change.mutate();
						}}
					>
						변경
					</button>
				</div>
				{mismatch && <p className="text-xs text-danger">새 비밀번호가 서로 다릅니다</p>}
				{change.error && <p className="text-xs text-danger">{change.error.message}</p>}
			</div>
			<div className="flex items-center justify-between gap-3 border-t border-line pt-3">
				<span className="text-xs text-muted">폰을 잃어버렸다면 — 이 기기만 남기고 모두 로그아웃</span>
				<button
					className={subtle}
					disabled={logoutAll.isPending}
					onClick={() => {
						if (confirm_("다른 모든 기기에서 로그아웃할까요?")) {
							setNotice(null);
							logoutAll.mutate();
						}
					}}
				>
					모든 기기 로그아웃
				</button>
			</div>
			{notice && <p className="text-xs text-success">{notice}</p>}
		</Card>
	);
}

/** window.confirm — 컴포넌트의 confirm 상태 이름과 겹쳐서 따로 둔다 */
const confirm_ = (msg: string): boolean => window.confirm(msg);

function AdminPanel({ me }: { me: MeDto }) {
	const qc = useQueryClient();
	const invites = useQuery({ queryKey: ["admin-invites"], queryFn: api.invites });
	const accounts = useQuery({ queryKey: ["admin-accounts"], queryFn: api.accounts });
	const [note, setNote] = useState("");
	const [days, setDays] = useState(7);
	const [issued, setIssued] = useState<{ label: string; value: string } | null>(null);
	const [error, setError] = useState<string | null>(null);

	const act = useMutation({
		mutationFn: async (run: () => Promise<unknown>) => run(),
		onMutate: () => setError(null),
		onError: (e: Error) => setError(e.message),
		onSettled: async () => {
			await qc.invalidateQueries({ queryKey: ["admin-invites"] });
			await qc.invalidateQueries({ queryKey: ["admin-accounts"] });
		},
	});

	const members = (accounts.data ?? []).filter((a) => a.source === "db");

	return (
		<Card title="관리자">
			<div className="space-y-2">
				<div className="text-xs font-medium text-muted">초대 코드 발급 — 한 번 쓰면 끝나는 코드입니다</div>
				<div className="flex gap-2">
					<input className={input} placeholder="누구에게 (메모, 선택)" value={note} onChange={(e) => setNote(e.target.value)} />
					<select
						value={days}
						onChange={(e) => setDays(Number(e.target.value))}
						className="shrink-0 rounded-lg border border-line bg-card px-2 py-2 text-sm text-ink outline-none"
					>
						<option value={1}>1일</option>
						<option value={7}>7일</option>
						<option value={30}>30일</option>
					</select>
					<button
						className={primary}
						disabled={act.isPending}
						onClick={() =>
							act.mutate(async () => {
								const r = await api.createInvite(note, days);
								setNote("");
								setIssued({ label: `초대 코드 (${r.expiresAt.slice(0, 10)}까지)`, value: r.code });
							})
						}
					>
						발급
					</button>
				</div>
				{issued && <OneTime label={issued.label} value={issued.value} onDone={() => setIssued(null)} />}
			</div>

			{(invites.data ?? []).length > 0 && (
				<div className="overflow-hidden rounded-lg border border-line bg-card">
					{invites.data?.slice(0, 20).map((i) => (
						<div key={i.id} className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 text-xs last:border-0">
							<span className="min-w-0 truncate text-ink">
								{i.note ?? "(메모 없음)"}
								<span className="ml-2 text-muted">
									{INVITE_STATUS[i.status]}
									{i.usedBy ? ` · ${i.usedBy}` : ""} · {date(i.createdAt)} 발급
									{i.status === "pending" ? ` · ${date(i.expiresAt)}까지` : ""}
								</span>
							</span>
							{i.status === "pending" && (
								<button className="shrink-0 text-danger" disabled={act.isPending} onClick={() => act.mutate(() => api.revokeSignupInvite(i.id))}>
									취소
								</button>
							)}
						</div>
					))}
				</div>
			)}

			<div className="space-y-2 border-t border-line pt-3">
				<div className="text-xs font-medium text-muted">가입한 계정 {members.length}명</div>
				{members.length === 0 && <p className="text-xs text-faint">아직 없습니다.</p>}
				{members.map((a) => (
					<div key={a.name} className="flex items-center justify-between gap-2 text-sm">
						<span className="min-w-0 truncate text-ink">
							{a.name}
							<span className="ml-2 text-xs text-muted">
								{date(a.createdAt)} 가입{a.invitedBy ? ` · ${a.invitedBy} 초대` : ""}
								{a.disabled ? " · 비활성" : ""}
							</span>
						</span>
						<span className="flex shrink-0 gap-3 text-xs">
							<button
								className="text-muted"
								disabled={act.isPending}
								onClick={() => {
									if (confirm_(`${a.name} 님의 비밀번호를 임시 비밀번호로 바꿀까요? 기존 로그인은 모두 끊깁니다.`)) {
										act.mutate(async () => {
											const r = await api.resetAccountPassword(a.name);
											setIssued({ label: `${a.name} 임시 비밀번호`, value: r.password });
										});
									}
								}}
							>
								임시 비밀번호
							</button>
							<button
								className={a.disabled ? "text-accent" : "text-danger"}
								disabled={act.isPending}
								onClick={() => {
									if (a.disabled || confirm_(`${a.name} 님을 비활성화할까요? 바로 로그아웃되고 로그인할 수 없습니다. 기록은 남습니다.`)) {
										act.mutate(() => api.setAccountDisabled(a.name, !a.disabled));
									}
								}}
							>
								{a.disabled ? "다시 켜기" : "비활성화"}
							</button>
						</span>
					</div>
				))}
				<p className="text-[11px] text-faint">
					서버 설정 계정({(accounts.data ?? []).filter((a) => a.source === "env").map((a) => a.name).join(", ") || me.user})은 관리자이며 여기서
					바꿀 수 없습니다.
				</p>
			</div>

			{error && <p className="text-xs text-danger">{error}</p>}
		</Card>
	);
}
