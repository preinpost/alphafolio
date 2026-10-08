/**
 * 가계부 화면 — 에이전트를 거치지 않는 직접 경로 (PLAN.md §3.2).
 *
 * 챗은 "어제 김밥천국 8천원" 같은 입력에 강하고, 이 화면은 훑어보기·수정·예산 확인에 강하다.
 * 둘은 같은 D1을 본다.
 *
 * 가계부는 여러 개일 수 있다 (PLAN §23). 위쪽에서 고르고, 받은 초대도 여기서 수락한다.
 * 초대 목록은 react-query 가 화면 복귀(visibilitychange) 때 다시 읽는다 — v1 알림은 이것뿐.
 *
 * 화면당 큰 숫자 하나 — 이달 지출. 내역 행을 누르면 고치기·지우기 다이얼로그가 열린다.
 */
import type { LedgerTransaction } from "@alphafolio/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../lib/api.ts";
import { toast } from "../lib/toast.ts";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, SearchIcon, XIcon } from "./icons.tsx";
import { InviteInbox, LedgerSettings } from "./LedgerSettings.tsx";

const won = (n: number): string => `${Math.abs(Math.round(n)).toLocaleString("ko-KR")}원`;
const compact = (n: number): string => {
	const v = Math.abs(Math.round(n));
	if (v >= 1e8) return `${Number((v / 1e8).toFixed(2)).toLocaleString("ko-KR")}억원`;
	if (v >= 1e4) return `${Number((v / 1e4).toFixed(v >= 1e6 ? 0 : 1)).toLocaleString("ko-KR")}만원`;
	return `${v.toLocaleString("ko-KR")}원`;
};
const todayKST = (): string => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const WEEKDAY = "일월화수목금토";

function monthRange(month: string): { from: string; to: string } {
	const [y, m] = month.split("-").map(Number);
	const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
	return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

function shiftMonth(month: string, by: number): string {
	const [y, m] = month.split("-").map(Number);
	const d = new Date(Date.UTC(y!, m! - 1 + by, 1));
	return d.toISOString().slice(0, 7);
}

/** 분류 색 — 자주 쓰는 분류는 고정, 나머지는 이름으로 골라 늘 같은 색 */
const CAT_COLOR: Record<string, string> = {
	주거: "var(--d1)",
	식비: "var(--d3)",
	교통: "var(--d4)",
	생활: "var(--d2)",
	통신: "var(--d6)",
	문화: "oklch(0.62 0.09 220)",
	구독: "oklch(0.6 0.08 330)",
	"카페·간식": "oklch(0.66 0.1 60)",
};
const EXTRA = ["oklch(0.6 0.1 140)", "oklch(0.64 0.1 280)", "oklch(0.7 0.09 100)", "oklch(0.58 0.1 200)", "oklch(0.66 0.11 40)"];
function catColor(cat: string | null): string {
	if (!cat) return "var(--d5)";
	if (CAT_COLOR[cat]) return CAT_COLOR[cat];
	let h = 0;
	for (const ch of cat) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return EXTRA[h % EXTRA.length]!;
}
const DEFAULT_CATS = ["식비", "카페·간식", "교통", "생활", "주거", "통신", "문화", "구독", "의료", "기타"];

export function LedgerPage() {
	const thisMonth = todayKST().slice(0, 7);
	const [month, setMonth] = useState(thisMonth);
	// 공유 가계부 — 기본은 전체, 필요하면 본인 것만 본다
	const [scope, setScope] = useState<"household" | "mine">("household");
	const [picked, setPicked] = useState<string | undefined>(undefined);
	const [managing, setManaging] = useState(false);
	const [cat, setCat] = useState("전체");
	const [q, setQ] = useState("");
	/** 다이얼로그 — null 닫힘, "new" 추가, 거래 = 고치기 */
	const [dialog, setDialog] = useState<"new" | LedgerTransaction | null>(null);
	const { from, to } = monthRange(month);
	const qc = useQueryClient();

	const me = useQuery({ queryKey: ["me"], queryFn: api.me });
	const books = useQuery({ queryKey: ["ledgers"], queryFn: api.ledgers });
	const mine = books.data?.ledgers ?? [];
	// 고른 게 없거나(처음) 더는 멤버가 아니면(나감·삭제) 기본 가계부
	const current = mine.find((l) => l.id === picked) ?? mine.find((l) => l.isDefault) ?? mine[0];
	const ledgerId = current?.id;
	// 가계부가 아직 없으면 조회하지 않는다 — 첫 기록(여기 또는 챗)에서 서버가 개인 가계부를 만든다
	const ready = books.isSuccess && ledgerId !== undefined;

	const summary = useQuery({
		queryKey: ["summary", ledgerId, from, to, scope],
		queryFn: () => api.summary(ledgerId, from, to, "category", scope),
		enabled: ready,
	});
	const byMember = useQuery({
		queryKey: ["summary-member", ledgerId, from, to],
		queryFn: () => api.summary(ledgerId, from, to, "member"),
		enabled: ready,
	});
	const transactions = useQuery({
		queryKey: ["transactions", ledgerId, from, to, scope],
		queryFn: () => api.transactions(ledgerId, { from, to, limit: 200, scope }),
		enabled: ready,
	});
	const budgets = useQuery({
		queryKey: ["budgets", ledgerId, month],
		queryFn: () => api.budgets(ledgerId, month),
		enabled: ready,
	});

	const invalidate = (): void => {
		// 가계부가 없던 사용자는 첫 기록 때 개인 가계부가 생기므로 목록도 다시 읽는다
		if (!ledgerId) void qc.invalidateQueries({ queryKey: ["ledgers"] });
		for (const key of ["summary", "summary-member", "transactions", "budgets"]) void qc.invalidateQueries({ queryKey: [key] });
	};

	const cats = [...(summary.data ?? [])].filter((r) => r.expense > 0).sort((a, b) => b.expense - a.expense);
	const spent = cats.reduce((s, r) => s + r.expense, 0);
	const income = (summary.data ?? []).reduce((s, r) => s + r.income, 0);
	const budgetRows = budgets.data ?? [];
	const budgetLeft = budgetRows.reduce((s, b) => s + b.remaining, 0);
	const budgetLimit = budgetRows.reduce((s, b) => s + b.limit_amt, 0);
	const budgetUsed = budgetRows.reduce((s, b) => s + b.spent, 0);

	const list = transactions.data ?? [];
	const chipCats = ["전체", ...new Set(list.map((t) => t.category ?? "분류 없음"))];
	useEffect(() => {
		if (!chipCats.includes(cat)) setCat("전체");
	}, [chipCats.join("|")]);
	const needle = q.trim();
	const shown = list.filter(
		(t) =>
			(cat === "전체" || (t.category ?? "분류 없음") === cat) &&
			(!needle || (t.merchant ?? "").includes(needle) || (t.memo ?? "").includes(needle) || (t.category ?? "").includes(needle)),
	);

	const [y, m] = month.split("-").map(Number);
	const isThisMonth = month === thisMonth;
	const sumLabel = `${m}월 지출${isThisMonth ? ` · ${Number(todayKST().slice(8))}일까지` : ""}${scope === "mine" ? " · 내 기록" : ""}`;
	const knownCats = [...new Set([...DEFAULT_CATS, ...cats.map((c) => c.key)])];

	return (
		<>
			{/* 월 이동이 제목 바로 옆에 붙는다 — 모바일은 제목을 접고 월만 */}
			<header className="topbar">
				<h1 className="desktop-only">가계부</h1>
				<div className="month-step">
					<button className="icon-btn" onClick={() => setMonth((v) => shiftMonth(v, -1))} aria-label="이전 달">
						<ChevronLeftIcon />
					</button>
					<b aria-live="polite">
						{y}년 {m}월
					</b>
					<button className="icon-btn" onClick={() => setMonth((v) => shiftMonth(v, 1))} disabled={month >= thisMonth} aria-label="다음 달">
						<ChevronRightIcon />
					</button>
				</div>
				<span className="spacer" />
				<button className="btn btn-primary" onClick={() => setDialog("new")} aria-label="기록 추가">
					<PlusIcon size={16} />
					<span className="desktop-only">기록 추가</span>
				</button>
			</header>

			<div className="page">
				<div className="wrap">
					<div className="filterbar">
						{mine.length > 1 ? (
							<label>
								<span className="sr-only">가계부 선택</span>
								<select className="input" value={current?.id ?? ""} onChange={(e) => setPicked(e.target.value)}>
									{mine.map((l) => (
										<option key={l.id} value={l.id}>
											{l.name}
											{l.memberCount > 1 ? ` · ${l.memberCount}명` : ""}
											{l.isDefault ? " · 기본" : ""}
										</option>
									))}
								</select>
							</label>
						) : (
							<b className="text-[14px]">
								{current ? current.name : books.isLoading ? "" : "첫 기록을 하면 내 가계부가 만들어집니다"}
								{current && current.memberCount > 1 && <span className="ml-2 font-medium text-muted">{current.memberCount}명</span>}
							</b>
						)}
						<div className="seg" role="group" aria-label="범위">
							<button aria-pressed={scope === "household"} onClick={() => setScope("household")}>
								전체
							</button>
							<button aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>
								내 기록
							</button>
						</div>
						{current && (
							<button className="btn btn-secondary btn-sm" onClick={() => setManaging((v) => !v)} aria-expanded={managing}>
								{managing ? "관리 닫기" : "관리·초대"}
							</button>
						)}
						<span className="hint">
							챗에서 <span className="mono">어제 김밥천국 8천원</span>처럼 말해도 기록됩니다
						</span>
					</div>

					<div className="grid-main">
						<div className="col">
							<section className="card fade-up" aria-labelledby="spent-label">
								<div className="sum-top">
									<div className="grow">
										<div className="eyebrow" id="spent-label">
											{sumLabel}
										</div>
										<div className="big-num">
											{Math.round(spent).toLocaleString("ko-KR")}
											<span className="unit">원</span>
										</div>
									</div>
									<div className="sum-side">
										<div>
											수입<b>{won(income)}</b>
										</div>
										{budgetRows.length > 0 && (
											<div>
												예산 남음<b className={budgetLeft < 0 ? "danger-text" : ""}>{budgetLeft >= 0 ? won(budgetLeft) : `${won(budgetLeft)} 초과`}</b>
											</div>
										)}
									</div>
								</div>
								{cats.length > 0 && (
									<div className="sum-bar">
										<div className="bar" role="img" aria-label="카테고리별 지출 비중">
											{cats.map((c) => (
												<i key={c.key} style={{ width: `${(c.expense / spent) * 100}%`, background: catColor(c.key) }} title={`${c.key} ${((c.expense / spent) * 100).toFixed(1)}%`} />
											))}
										</div>
									</div>
								)}
								<div className="cat-rows">
									{summary.isLoading && <div className="empty">불러오는 중…</div>}
									{summary.isSuccess && cats.length === 0 && <div className="empty">이 달에는 지출 기록이 없습니다.</div>}
									{cats.map((c) => (
										<button key={c.key} className="cat-row row-btn" onClick={() => setCat(c.key)} title="이 분류만 보기">
											<span className="sw" style={{ background: catColor(c.key) }} />
											<span>
												{c.key} <span className="cnt">{c.count}건</span>
											</span>
											<span className="cnt">{((c.expense / spent) * 100).toFixed(1)}%</span>
											<span className="amt">{won(c.expense)}</span>
										</button>
									))}
								</div>
							</section>

							<section className="card fade-up" aria-labelledby="tx-title">
								<div className="card-h">
									<h2 id="tx-title">
										내역<span className="count">{shown.length}건</span>
									</h2>
								</div>
								<div className="tx-tools">
									<label className="search-field">
										<SearchIcon size={15} />
										<span className="sr-only">내역 검색</span>
										<input className="input input-sm" type="search" placeholder="가맹점·메모 검색" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
									</label>
									<div className="hscroll" role="group" aria-label="분류 필터">
										{chipCats.map((k) => (
											<button key={k} className="chip" aria-pressed={k === cat} onClick={() => setCat(k)}>
												{k}
											</button>
										))}
									</div>
								</div>
								<TxList list={shown} total={list.length} onOpen={setDialog} />
							</section>
						</div>

						<div className="col">
							{managing && current && me.data && (
								<LedgerSettings key={current.id} ledger={current} me={me.data.user} onSelect={setPicked} onClose={() => setManaging(false)} />
							)}
							<InviteInbox invites={books.data?.invites ?? []} />

							<section className="card fade-up">
								<div className="card-h">
									<h2>예산</h2>
									<span className="spacer" />
									{budgetRows.length > 0 && (
										<span className="eyebrow num font-medium">
											{compact(budgetUsed)} / {compact(budgetLimit)}
										</span>
									)}
								</div>
								{budgetRows.length === 0 ? (
									<p className="card-b text-[13px] text-muted">
										이 달 예산이 없습니다. 챗에서 <span className="mono text-ink">식비 예산 30만원</span>처럼 말하면 정해집니다.
									</p>
								) : (
									<div className="border-t border-line">
										{budgetRows.map((b) => {
											const over = b.remaining < 0;
											return (
												<div key={b.category} className="budget">
													<div className="top">
														<span className="sw" style={{ background: catColor(b.category) }} />
														<b>{b.category}</b>
														{over && <span className="badge warn">{won(b.remaining)} 초과</span>}
														<span className="r">
															{won(b.spent)} / {compact(b.limit_amt)}
														</span>
													</div>
													<div
														className={`meter ${over ? "over" : ""}`}
														role="meter"
														aria-valuenow={b.usedPct}
														aria-valuemin={0}
														aria-valuemax={100}
														aria-label={`${b.category} 예산 사용률`}
													>
														<i style={{ width: `${Math.min(b.usedPct, 100)}%` }} />
													</div>
												</div>
											);
										})}
									</div>
								)}
							</section>

							{(byMember.data ?? []).length > 1 && (
								<section className="card fade-up">
									<div className="card-h">
										<h2>사람별</h2>
										<span className="spacer" />
										<span className="eyebrow font-medium">가계부 전체 기준</span>
									</div>
									<div className="rows border-t border-line">
										{byMember.data?.map((r) => {
											const all = byMember.data?.reduce((s, x) => s + x.expense, 0) || 1;
											return (
												<div key={r.key} className="row member">
													<span className="avatar">{r.key.slice(0, 2).toUpperCase()}</span>
													<span className="grow">
														<span className="name">
															{r.key}
															{r.key === me.data?.user && <span className="font-medium text-muted"> · 나</span>}
														</span>
														<div className="meter">
															<i style={{ width: `${(r.expense / all) * 100}%` }} />
														</div>
													</span>
													<span className="amt">
														<b>{won(r.expense)}</b>
														<small className="muted">
															{r.count}건 · {Math.round((r.expense / all) * 100)}%
														</small>
													</span>
												</div>
											);
										})}
									</div>
								</section>
							)}
						</div>
					</div>
				</div>
			</div>

			<TxDialog
				open={dialog}
				ledgerId={ledgerId}
				me={me.data?.user ?? null}
				cats={knownCats}
				onClose={() => setDialog(null)}
				onSaved={(date) => {
					invalidate();
					if (date.slice(0, 7) !== month) setMonth(date.slice(0, 7));
				}}
			/>
		</>
	);
}

function TxList({ list, total, onOpen }: { list: LedgerTransaction[]; total: number; onOpen: (t: LedgerTransaction) => void }) {
	if (list.length === 0) {
		return <div className="empty">{total ? "조건에 맞는 내역이 없습니다." : "기록이 없습니다. 위쪽 ‘기록 추가’나 챗으로 첫 기록을 남겨 보세요."}</div>;
	}
	const out: React.ReactNode[] = [];
	let last = "";
	for (const t of list) {
		if (t.date !== last) {
			last = t.date;
			const day = list.filter((x) => x.date === t.date && x.amount < 0).reduce((s, x) => s - x.amount, 0);
			const wd = WEEKDAY[new Date(`${t.date}T00:00:00`).getDay()];
			out.push(
				<div key={`d${t.date}`} className="day-h">
					<span>
						{Number(t.date.slice(5, 7))}월 {Number(t.date.slice(8))}일 ({wd})
					</span>
					<span>{day ? `지출 ${won(day)}` : ""}</span>
				</div>,
			);
		}
		const inc = t.amount > 0;
		out.push(
			<button key={t.id} className="row row-btn tx" role="listitem" onClick={() => onOpen(t)}>
				<span className="sw" style={{ background: inc ? "var(--ok)" : catColor(t.category) }} />
				<span className="grow">
					<span className="name">{t.merchant ?? t.category ?? "-"}</span>
					<span className="meta">
						{[inc ? "수입" : (t.category ?? "분류 없음"), t.member, t.memo].filter(Boolean).join(" · ")}
						{t.source === "agent" && <span className="src">챗</span>}
					</span>
				</span>
				<span className="amt">
					<b className={inc ? "ok-text" : ""}>
						{inc ? "+" : ""}
						{won(t.amount)}
					</b>
				</span>
			</button>,
		);
	}
	return <div role="list">{out}</div>;
}

/** 기록 추가·고치기 — 데스크톱은 가운데, 모바일은 바텀시트 */
function TxDialog({
	open,
	ledgerId,
	me,
	cats,
	onClose,
	onSaved,
}: {
	open: "new" | LedgerTransaction | null;
	ledgerId: string | undefined;
	me: string | null;
	cats: string[];
	onClose: () => void;
	onSaved: (date: string) => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const amountRef = useRef<HTMLInputElement>(null);
	const merchantRef = useRef<HTMLInputElement>(null);
	const editing = open && open !== "new" ? open : null;
	const [type, setType] = useState<"expense" | "income">("expense");
	const [amount, setAmount] = useState("");
	const [merchant, setMerchant] = useState("");
	const [category, setCategory] = useState("");
	const [date, setDate] = useState(todayKST());
	const [memo, setMemo] = useState("");
	const [errors, setErrors] = useState<{ amount?: string; merchant?: string }>({});

	// 열 때마다 값 채우기
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (!open) {
			if (d.open) d.close();
			return;
		}
		setType(editing && editing.amount > 0 ? "income" : "expense");
		setAmount(editing ? Math.abs(editing.amount).toLocaleString("ko-KR") : "");
		setMerchant(editing?.merchant ?? "");
		setCategory(editing?.category ?? "");
		setDate(editing?.date ?? todayKST());
		setMemo(editing?.memo ?? "");
		setErrors({});
		if (!d.open) d.showModal();
		requestAnimationFrame(() => (editing ? merchantRef : amountRef).current?.focus());
	}, [open]);

	const save = useMutation({
		mutationFn: async () => {
			const n = Number(amount.replace(/[^\d]/g, ""));
			const body = { date, amount: n, type, category: category.trim(), merchant: merchant.trim(), memo: memo.trim() };
			if (editing) return api.updateTransaction(editing.id, body);
			return api.addTransaction(ledgerId, {
				date,
				amount: n,
				type,
				...(body.category ? { category: body.category } : {}),
				...(body.merchant ? { merchant: body.merchant } : {}),
				...(body.memo ? { memo: body.memo } : {}),
			});
		},
		onSuccess: () => {
			toast(editing ? "기록을 고쳤습니다" : `${merchant.trim() || category.trim()} ${Number(amount.replace(/[^\d]/g, "")).toLocaleString("ko-KR")}원 기록했습니다`);
			onSaved(date);
			onClose();
		},
	});
	const remove = useMutation({
		mutationFn: (t: LedgerTransaction) => api.deleteTransaction(t.id),
		onSuccess: (_r, t) => {
			onSaved(t.date);
			onClose();
			// 되돌리기는 새 기록으로 다시 넣는다 — 기록한 사람이 바뀌지 않게 내 기록만
			const mineTx = !t.member || t.member === me;
			toast(`${t.merchant ?? t.category ?? "기록"}을(를) 지웠습니다`, {
				...(mineTx
					? {
							action: {
								label: "되돌리기",
								run: () =>
									void api
										.addTransaction(ledgerId, {
											date: t.date,
											amount: Math.abs(t.amount),
											type: t.amount > 0 ? "income" : "expense",
											...(t.category ? { category: t.category } : {}),
											...(t.merchant ? { merchant: t.merchant } : {}),
											...(t.memo ? { memo: t.memo } : {}),
										})
										.then(() => onSaved(t.date)),
							},
						}
					: {}),
			});
		},
	});

	function submit(e: FormEvent): void {
		e.preventDefault();
		const n = Number(amount.replace(/[^\d]/g, ""));
		const next = {
			...(n > 0 ? {} : { amount: "금액을 입력하세요." }),
			...(merchant.trim() || category.trim() ? {} : { merchant: "어디에 썼는지 적어 주세요." }),
		};
		setErrors(next);
		if (next.amount) return amountRef.current?.focus();
		if (next.merchant) return merchantRef.current?.focus();
		save.mutate();
	}

	const error = (save.error ?? remove.error) as Error | null;

	return (
		<dialog
			ref={ref}
			className="sheet"
			aria-labelledby="tx-dlg-title"
			onClose={onClose}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<form onSubmit={submit} noValidate>
				<div className="sheet-h">
					<h2 id="tx-dlg-title">{editing ? "기록 고치기" : "기록 추가"}</h2>
					<button type="button" className="icon-btn" onClick={onClose} aria-label="닫기">
						<XIcon />
					</button>
				</div>
				<div className="sheet-b">
					<div className="seg block" role="group" aria-label="구분">
						<button type="button" aria-pressed={type === "expense"} onClick={() => setType("expense")}>
							지출
						</button>
						<button type="button" aria-pressed={type === "income"} onClick={() => setType("income")}>
							수입
						</button>
					</div>
					<label className="field">
						<span>금액</span>
						<input
							ref={amountRef}
							className="input amount-input"
							inputMode="numeric"
							placeholder="0원"
							autoComplete="off"
							value={amount}
							aria-invalid={!!errors.amount}
							onChange={(e) => {
								const n = e.target.value.replace(/[^\d]/g, "");
								setAmount(n ? Number(n).toLocaleString("ko-KR") : "");
							}}
						/>
						{errors.amount && <span className="field-err">{errors.amount}</span>}
					</label>
					<label className="field">
						<span>가맹점·내용</span>
						<input
							ref={merchantRef}
							className="input"
							placeholder="예: 김밥천국"
							autoComplete="off"
							value={merchant}
							aria-invalid={!!errors.merchant}
							onChange={(e) => setMerchant(e.target.value)}
						/>
						{errors.merchant && <span className="field-err">{errors.merchant}</span>}
					</label>
					<div className="grid2">
						<label className="field">
							<span>분류</span>
							<input className="input" list="tx-cats" placeholder="예: 식비" autoComplete="off" value={category} onChange={(e) => setCategory(e.target.value)} />
							<datalist id="tx-cats">
								{cats.map((c) => (
									<option key={c} value={c} />
								))}
							</datalist>
						</label>
						<label className="field">
							<span>날짜</span>
							<input className="input" type="date" max={todayKST()} value={date} onChange={(e) => setDate(e.target.value || todayKST())} />
						</label>
					</div>
					<label className="field">
						<span>메모 (선택)</span>
						<input className="input" autoComplete="off" value={memo} onChange={(e) => setMemo(e.target.value)} />
					</label>
					{editing?.member && editing.member !== me && <p className="field-hint">{editing.member} 님이 남긴 기록입니다.</p>}
					{error && <p className="field-err">{error.message}</p>}
				</div>
				<div className="sheet-f">
					{editing && (
						<button
							type="button"
							className="btn btn-danger mr-auto"
							disabled={remove.isPending}
							onClick={() => {
								if (confirm("이 기록을 지울까요?")) remove.mutate(editing);
							}}
						>
							삭제
						</button>
					)}
					<button type="button" className="btn btn-secondary" onClick={onClose}>
						취소
					</button>
					<button type="submit" className="btn btn-primary" disabled={save.isPending}>
						{save.isPending ? "저장 중…" : "저장"}
					</button>
				</div>
			</form>
		</dialog>
	);
}
