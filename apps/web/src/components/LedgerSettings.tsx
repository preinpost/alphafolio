/**
 * 가계부 관리 — 새 가계부, 이름·기본 설정, 멤버·초대, 소유권 이전, 나가기·삭제 (PLAN §23).
 *
 * 전부 이 화면에서만 한다. 에이전트 툴이 없는 이유는 주문 확인과 같다 —
 * 챗에 섞여 들어온 외부 텍스트("○○를 초대해")가 가계부를 넘기지 못하게.
 */
import type { LedgerInviteDto, MyLedgerDto } from "@alphafolio/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { toast } from "../lib/toast.ts";
import { XIcon } from "./icons.tsx";

function daysLeft(iso: string): number {
	return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-2 border-t border-line px-5 py-4 max-md:px-4">
			<div className="eyebrow">{title}</div>
			{children}
		</div>
	);
}

/** 받은 초대 — 가계부 화면 오른쪽 위 */
export function InviteInbox({ invites }: { invites: LedgerInviteDto[] }) {
	const qc = useQueryClient();
	const respond = useMutation({
		mutationFn: ({ id, accept }: { id: string; accept: boolean }) => api.respondInvite(id, accept),
		onSuccess: (_r, v) => {
			const inv = invites.find((i) => i.id === v.id);
			toast(v.accept ? `‘${inv?.ledger_name ?? ""}’ 가계부에 참여했습니다` : "초대를 거절했습니다");
		},
		onSettled: () => void qc.invalidateQueries({ queryKey: ["ledgers"] }),
	});
	if (invites.length === 0) return null;

	return (
		<section className="card fade-up">
			{invites.map((inv) => (
				<div key={inv.id} className="invite-box">
					<div className="eyebrow">받은 초대 · {daysLeft(inv.expires_at)}일 뒤 만료</div>
					<p>
						<b>{inv.inviter}</b> 님이 <b>{inv.ledger_name}</b> 가계부에 초대했습니다. 수락하면 내역·예산을 함께 보고 기록합니다.
					</p>
					<div className="acts">
						<button className="btn btn-primary btn-sm" disabled={respond.isPending} onClick={() => respond.mutate({ id: inv.id, accept: true })}>
							수락
						</button>
						<button className="btn btn-ghost btn-sm" disabled={respond.isPending} onClick={() => respond.mutate({ id: inv.id, accept: false })}>
							거절
						</button>
					</div>
				</div>
			))}
			{respond.error && <p className="field-err px-5 pb-4">{respond.error.message}</p>}
		</section>
	);
}

export function LedgerSettings({
	ledger,
	me,
	onSelect,
	onClose,
}: {
	ledger: MyLedgerDto;
	me: string;
	/** 새로 만들었거나(→ 그것) 나가거나 지워서(→ undefined = 기본) 선택이 바뀔 때 */
	onSelect: (id: string | undefined) => void;
	onClose: () => void;
}) {
	const qc = useQueryClient();
	const owner = ledger.role === "owner";
	const members = useQuery({ queryKey: ["ledger-members", ledger.id], queryFn: () => api.ledgerMembers(ledger.id) });

	const [newName, setNewName] = useState("");
	const [rename, setRename] = useState(ledger.name);
	const [invitee, setInvitee] = useState("");
	const [confirmName, setConfirmName] = useState("");
	const [error, setError] = useState<string | null>(null);

	const refresh = async (): Promise<void> => {
		await qc.invalidateQueries({ queryKey: ["ledgers"] });
		await qc.invalidateQueries({ queryKey: ["ledger-members", ledger.id] });
	};
	/** 실행 + 오류 표시 공용. done 은 성공 토스트 */
	const act = useMutation({
		mutationFn: async ({ run }: { run: () => Promise<unknown>; done?: string }) => run(),
		onMutate: () => setError(null),
		onSuccess: (_r, v) => {
			if (v.done) toast(v.done);
		},
		onError: (e: Error) => setError(e.message),
		onSettled: refresh,
	});

	const exportJson = async (): Promise<void> => {
		const data = await api.exportLedger(ledger.id);
		const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = `alphafolio-${ledger.name}-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	};

	const pending = members.data?.invites ?? [];

	return (
		<section className="card fade-up" aria-labelledby="ledger-manage">
			<div className="card-h">
				<h2 id="ledger-manage">가계부 관리</h2>
				<span className="spacer" />
				<button className="icon-btn" onClick={onClose} aria-label="닫기">
					<XIcon size={17} />
				</button>
			</div>

			<div className="flex flex-col gap-2 px-5 pb-4 max-md:px-4">
				<div className="text-[14px]">
					<b>{ledger.name}</b>
					<span className="ml-2 text-[12px] text-muted">
						{owner ? "소유자" : `멤버 · 소유자 ${ledger.owner}`}
						{ledger.isDefault ? " · 기본 가계부" : ""}
					</span>
				</div>
				{!ledger.isDefault && (
					<button
						className="btn btn-secondary btn-sm self-start"
						disabled={act.isPending}
						onClick={() => act.mutate({ run: () => api.setDefaultLedger(ledger.id), done: "기본 가계부로 정했습니다" })}
					>
						기본 가계부로 (챗에서 따로 말하지 않으면 여기에 기록)
					</button>
				)}
			</div>

			{owner && (
				<Section title="이름">
					<div className="flex gap-2">
						<input className="input input-sm" value={rename} onChange={(e) => setRename(e.target.value)} aria-label="가계부 이름" />
						<button
							className="btn btn-secondary btn-sm"
							disabled={act.isPending || !rename.trim() || rename.trim() === ledger.name}
							onClick={() => act.mutate({ run: () => api.renameLedger(ledger.id, rename), done: "이름을 바꿨습니다" })}
						>
							변경
						</button>
					</div>
				</Section>
			)}

			<Section title={`멤버 ${members.data?.members.length ?? ""}`}>
				<div className="rows -mx-1">
					{members.data?.members.map((m) => (
						<div key={m.member} className="flex items-center gap-3 px-1 py-2">
							<span className="avatar">{m.member.slice(0, 2).toUpperCase()}</span>
							<span className="min-w-0 flex-1 truncate text-[14px]">
								{m.member}
								{m.member === me ? " (나)" : ""}
								<span className="ml-2 text-[12px] text-muted">{m.role === "owner" ? "소유자" : "멤버"}</span>
							</span>
							{owner && m.role === "member" && (
								<span className="flex shrink-0 gap-1">
									<button
										className="btn btn-ghost btn-sm"
										disabled={act.isPending}
										onClick={() => {
											if (confirm(`${m.member} 님에게 소유권을 넘길까요? 나는 일반 멤버가 됩니다.`)) {
												act.mutate({ run: () => api.transferLedger(ledger.id, m.member), done: `${m.member} 님에게 소유권을 넘겼습니다` });
											}
										}}
									>
										소유권 넘기기
									</button>
									<button
										className="btn btn-ghost btn-sm text-danger"
										disabled={act.isPending}
										onClick={() => {
											if (confirm(`${m.member} 님을 내보낼까요? 그동안 쓴 기록은 남습니다.`)) {
												act.mutate({ run: () => api.removeLedgerMember(ledger.id, m.member), done: `${m.member} 님을 내보냈습니다` });
											}
										}}
									>
										내보내기
									</button>
								</span>
							)}
						</div>
					))}
				</div>
			</Section>

			{owner && (
				<Section title="초대">
					<form
						className="flex gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (!invitee.trim()) return;
							act.mutate({
								run: async () => {
									const inv = await api.inviteToLedger(ledger.id, invitee);
									setInvitee("");
									toast(`${inv.invitee} 님에게 초대를 보냈습니다`, { sub: "상대가 앱에서 수락하면 멤버가 됩니다" });
								},
							});
						}}
					>
						<input
							className="input input-sm"
							placeholder="상대 ID"
							aria-label="초대할 ID"
							autoCapitalize="none"
							autoCorrect="off"
							value={invitee}
							onChange={(e) => setInvitee(e.target.value)}
						/>
						<button type="submit" className="btn btn-primary btn-sm" disabled={act.isPending || !invitee.trim()}>
							초대
						</button>
					</form>
					{pending.map((inv) => (
						<div key={inv.id} className="flex items-center justify-between gap-2 text-[12.5px]">
							<span className="text-muted">
								{inv.invitee} — 대기 중 ({daysLeft(inv.expires_at)}일 남음)
							</span>
							<button
								className="btn btn-ghost btn-sm text-danger"
								disabled={act.isPending}
								onClick={() => act.mutate({ run: () => api.revokeInvite(inv.id), done: "초대를 취소했습니다" })}
							>
								취소
							</button>
						</div>
					))}
				</Section>
			)}

			<Section title="새 가계부">
				<form
					className="flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (!newName.trim()) return;
						act.mutate({
							run: async () => {
								const created = await api.createLedger(newName);
								setNewName("");
								onSelect(created.id);
							},
							done: "새 가계부를 만들었습니다",
						});
					}}
				>
					<input className="input input-sm" placeholder="예: 우리집, 개인" aria-label="새 가계부 이름" value={newName} onChange={(e) => setNewName(e.target.value)} />
					<button type="submit" className="btn btn-secondary btn-sm" disabled={act.isPending || !newName.trim()}>
						만들기
					</button>
				</form>
			</Section>

			<Section title="백업">
				<button className="btn btn-secondary btn-sm self-start" onClick={() => void exportJson().catch((e: Error) => setError(e.message))}>
					JSON 으로 내보내기
				</button>
			</Section>

			{owner ? (
				<Section title="가계부 삭제 — 내역·예산이 모두 지워지고 되돌릴 수 없습니다">
					<div className="flex gap-2">
						<input
							className="input input-sm"
							placeholder={`확인: "${ledger.name}" 입력`}
							aria-label="삭제 확인용 가계부 이름"
							value={confirmName}
							onChange={(e) => setConfirmName(e.target.value)}
						/>
						<button
							className="btn btn-danger btn-sm"
							disabled={act.isPending || confirmName.trim() !== ledger.name}
							onClick={() =>
								act.mutate({
									run: async () => {
										await api.deleteLedger(ledger.id, confirmName);
										onSelect(undefined);
										onClose();
									},
									done: `‘${ledger.name}’ 가계부를 삭제했습니다`,
								})
							}
						>
							삭제
						</button>
					</div>
				</Section>
			) : (
				<Section title="나가기">
					<button
						className="btn btn-danger btn-sm self-start"
						disabled={act.isPending}
						onClick={() => {
							if (confirm(`${ledger.name} 가계부에서 나갈까요? 다시 들어오려면 초대를 받아야 합니다.`)) {
								act.mutate({
									run: async () => {
										await api.removeLedgerMember(ledger.id, me);
										onSelect(undefined);
										onClose();
									},
									done: `‘${ledger.name}’ 가계부에서 나갔습니다`,
								});
							}
						}}
					>
						이 가계부에서 나가기
					</button>
				</Section>
			)}

			{error && <p className="field-err px-5 pb-4">{error}</p>}
		</section>
	);
}
