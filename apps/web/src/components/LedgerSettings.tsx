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

const input =
	"min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent";
const btn = "shrink-0 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-40";
const primary = `${btn} bg-accent text-accent-ink`;
const subtle = `${btn} border border-line text-ink active:bg-hover`;
const danger = `${btn} border border-danger/40 text-danger active:bg-hover`;

function daysLeft(iso: string): number {
	return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="space-y-2">
			<h3 className="text-xs font-medium text-muted">{title}</h3>
			{children}
		</section>
	);
}

/** 받은 초대 — 가계부 화면 맨 위에 뜬다 */
export function InviteInbox({ invites }: { invites: LedgerInviteDto[] }) {
	const qc = useQueryClient();
	const respond = useMutation({
		mutationFn: ({ id, accept }: { id: string; accept: boolean }) => api.respondInvite(id, accept),
		onSettled: () => void qc.invalidateQueries({ queryKey: ["ledgers"] }),
	});
	if (invites.length === 0) return null;

	return (
		<div className="space-y-2">
			{invites.map((inv) => (
				<div key={inv.id} className="rounded-xl border border-accent/40 bg-inset p-4">
					<div className="text-sm text-ink">
						<b>{inv.inviter}</b> 님이 <b>{inv.ledger_name}</b> 가계부에 초대했습니다
					</div>
					<div className="mt-0.5 text-xs text-muted">
						수락하면 이 가계부의 내역·예산을 함께 보고 기록합니다 · {daysLeft(inv.expires_at)}일 뒤 만료
					</div>
					<div className="mt-3 flex gap-2">
						<button
							className={primary}
							disabled={respond.isPending}
							onClick={() => respond.mutate({ id: inv.id, accept: true })}
						>
							수락
						</button>
						<button
							className={subtle}
							disabled={respond.isPending}
							onClick={() => respond.mutate({ id: inv.id, accept: false })}
						>
							거절
						</button>
					</div>
				</div>
			))}
			{respond.error && <p className="text-xs text-danger">{respond.error.message}</p>}
		</div>
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
	const [notice, setNotice] = useState<string | null>(null);

	const refresh = async (): Promise<void> => {
		await qc.invalidateQueries({ queryKey: ["ledgers"] });
		await qc.invalidateQueries({ queryKey: ["ledger-members", ledger.id] });
	};
	/** 실행 + 오류 표시 공용 */
	const act = useMutation({
		mutationFn: async (run: () => Promise<unknown>) => run(),
		onMutate: () => {
			setError(null);
			setNotice(null);
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
		<div className="space-y-5 rounded-xl border border-line bg-inset p-4">
			<div className="flex items-center justify-between">
				<h2 className="text-sm font-semibold text-ink">가계부 관리</h2>
				<button onClick={onClose} className="text-xs text-muted">
					닫기
				</button>
			</div>

			<Section title="새 가계부">
				<div className="flex gap-2">
					<input className={input} placeholder="예: 우리집, 개인" value={newName} onChange={(e) => setNewName(e.target.value)} />
					<button
						className={primary}
						disabled={act.isPending || !newName.trim()}
						onClick={() =>
							act.mutate(async () => {
								const created = await api.createLedger(newName);
								setNewName("");
								onSelect(created.id);
							})
						}
					>
						만들기
					</button>
				</div>
			</Section>

			<div className="border-t border-line" />

			<div className="text-sm text-ink">
				<b>{ledger.name}</b>
				<span className="ml-2 text-xs text-muted">
					{owner ? "소유자" : `멤버 · 소유자 ${ledger.owner}`}
					{ledger.isDefault ? " · 기본 가계부" : ""}
				</span>
			</div>

			{!ledger.isDefault && (
				<button className={subtle} disabled={act.isPending} onClick={() => act.mutate(() => api.setDefaultLedger(ledger.id))}>
					기본 가계부로 (챗에서 따로 말하지 않으면 여기에 기록)
				</button>
			)}

			{owner && (
				<Section title="이름">
					<div className="flex gap-2">
						<input className={input} value={rename} onChange={(e) => setRename(e.target.value)} />
						<button
							className={subtle}
							disabled={act.isPending || !rename.trim() || rename.trim() === ledger.name}
							onClick={() => act.mutate(() => api.renameLedger(ledger.id, rename))}
						>
							변경
						</button>
					</div>
				</Section>
			)}

			<Section title={`멤버 ${members.data?.members.length ?? ""}`}>
				<div className="overflow-hidden rounded-lg border border-line bg-card">
					{members.data?.members.map((m) => (
						<div key={m.member} className="flex items-center justify-between border-b border-line px-3 py-2 last:border-0">
							<span className="text-sm text-ink">
								{m.member}
								{m.member === me ? " (나)" : ""}
								<span className="ml-2 text-xs text-muted">{m.role === "owner" ? "소유자" : "멤버"}</span>
							</span>
							{owner && m.role === "member" && (
								<span className="flex gap-3 text-xs">
									<button
										className="text-muted"
										disabled={act.isPending}
										onClick={() => {
											if (confirm(`${m.member} 님에게 소유권을 넘길까요? 나는 일반 멤버가 됩니다.`)) {
												act.mutate(() => api.transferLedger(ledger.id, m.member));
											}
										}}
									>
										소유권 넘기기
									</button>
									<button
										className="text-danger"
										disabled={act.isPending}
										onClick={() => {
											if (confirm(`${m.member} 님을 내보낼까요? 그동안 쓴 기록은 남습니다.`)) {
												act.mutate(() => api.removeLedgerMember(ledger.id, m.member));
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
					<div className="flex gap-2">
						<input
							className={input}
							placeholder="상대 ID"
							autoCapitalize="none"
							autoCorrect="off"
							value={invitee}
							onChange={(e) => setInvitee(e.target.value)}
						/>
						<button
							className={primary}
							disabled={act.isPending || !invitee.trim()}
							onClick={() =>
								act.mutate(async () => {
									const inv = await api.inviteToLedger(ledger.id, invitee);
									setInvitee("");
									setNotice(`${inv.invitee} 님에게 초대를 보냈습니다. 상대가 앱에서 수락하면 멤버가 됩니다.`);
								})
							}
						>
							초대
						</button>
					</div>
					{pending.map((inv) => (
						<div key={inv.id} className="flex items-center justify-between text-xs">
							<span className="text-muted">
								{inv.invitee} — 대기 중 ({daysLeft(inv.expires_at)}일 남음)
							</span>
							<button className="text-danger" disabled={act.isPending} onClick={() => act.mutate(() => api.revokeInvite(inv.id))}>
								취소
							</button>
						</div>
					))}
				</Section>
			)}

			{notice && <p className="text-xs text-success">{notice}</p>}
			{error && <p className="text-xs text-danger">{error}</p>}

			<div className="border-t border-line" />

			<Section title="백업">
				<button className={subtle} onClick={() => void exportJson().catch((e: Error) => setError(e.message))}>
					JSON 으로 내보내기
				</button>
			</Section>

			{owner ? (
				<Section title="가계부 삭제 — 내역·예산이 모두 지워지고 되돌릴 수 없습니다">
					<div className="flex gap-2">
						<input
							className={input}
							placeholder={`확인: "${ledger.name}" 입력`}
							value={confirmName}
							onChange={(e) => setConfirmName(e.target.value)}
						/>
						<button
							className={danger}
							disabled={act.isPending || confirmName.trim() !== ledger.name}
							onClick={() =>
								act.mutate(async () => {
									await api.deleteLedger(ledger.id, confirmName);
									onSelect(undefined);
									onClose();
								})
							}
						>
							삭제
						</button>
					</div>
				</Section>
			) : (
				<button
					className={danger}
					disabled={act.isPending}
					onClick={() => {
						if (confirm(`${ledger.name} 가계부에서 나갈까요? 다시 들어오려면 초대를 받아야 합니다.`)) {
							act.mutate(async () => {
								await api.removeLedgerMember(ledger.id, me);
								onSelect(undefined);
								onClose();
							});
						}
					}}
				>
					이 가계부에서 나가기
				</button>
			)}
		</div>
	);
}
