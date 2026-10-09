/**
 * 매매일지 화면 (PLAN §42) — 에이전트를 거치지 않는 직접 경로 (PLAN §3.2).
 *
 * 앱이 낸 주문(챗 확인 카드)·자동 매매는 저절로 들어오고, 연결된 계좌(토스·한국투자·Binance)의 체결은
 * [가져오기] 로 들어온다 (화면을 열면 10분에 한 번 저절로). 앱 밖 매매는 [기록] 으로 직접.
 * 챗에서 "어제 산 삼성전자 근거 적어줘" 처럼 말해도 같은 일지에 쓴다.
 *
 * 화면당 큰 숫자 하나 — 기간 안 매매 수. 손익은 계산하지 않는다 (평가손익은 투자 탭) —
 * 대신 근거·손절가·회고를 얼마나 채웠는지와 태그·감정 분포를 보여 준다.
 */
import type { JournalEntryDto } from "@alphafolio/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, type JournalManualInput } from "../lib/api.ts";
import {
	amountOf,
	BROKER_LABEL,
	CHIPS,
	EMOTIONS,
	filterEntries,
	kstToday,
	money,
	parseNumber,
	parseTags,
	periodFrom,
	PERIODS,
	SOURCE_LABEL,
	summarize,
	tradeText,
	type Chip,
	type PeriodId,
} from "../lib/journal.ts";
import { toast } from "../lib/toast.ts";
import { PlusIcon, RefreshIcon, SearchIcon, XIcon } from "./icons.tsx";
import { Topbar } from "./Topbar.tsx";

const WEEKDAY = "일월화수목금토";
const pct = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 100) : 0);

export function JournalPage({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
	const today = kstToday();
	const [period, setPeriod] = useState<PeriodId>("30d");
	const [chip, setChip] = useState<Chip>("all");
	const [tag, setTag] = useState<string | null>(null);
	const [q, setQ] = useState("");
	/** 다이얼로그 — null 닫힘, "new" 직접 기록, 기록 = 보기·고치기 */
	const [dialog, setDialog] = useState<"new" | JournalEntryDto | null>(null);
	const qc = useQueryClient();

	const from = periodFrom(period, today);
	const list = useQuery({ queryKey: ["journal", from ?? "all"], queryFn: () => api.journal({ ...(from ? { from } : {}) }), retry: false });

	const sync = useMutation({
		mutationFn: (force: boolean) => api.syncJournal(force),
		onSuccess: (r, force) => {
			if (r.skipped) return;
			if (r.added > 0 || r.updated > 0) void qc.invalidateQueries({ queryKey: ["journal"] });
			const failed = r.sources.filter((s) => s.error);
			// 화면을 열 때 저절로 가져온 것은 바뀐 게 있을 때만 알린다 (늘 실패하는 계좌가 열 때마다 뜨지 않게)
			if (!force && r.added === 0 && r.updated === 0) return;
			if (r.sources.length === 0) {
				if (force) toast("연결된 계좌가 없습니다", { sub: "설정 → 연결에서 토스·한국투자·Binance 키를 넣으면 체결을 가져옵니다" });
				return;
			}
			const sub = [...failed.map((s) => `${s.label} 실패: ${s.error}`), ...r.warnings].join(" · ");
			toast(r.added || r.updated ? `새 기록 ${r.added}건 · 체결 반영 ${r.updated}건` : "새로 가져올 체결이 없습니다", sub ? { sub } : {});
		},
		onError: (e: Error, force) => {
			if (force) toast(`가져오지 못했습니다: ${e.message}`);
		},
	});

	// 화면을 열 때 한 번 — 서버가 10분에 한 번만 증권사를 부른다
	const synced = useRef(false);
	useEffect(() => {
		if (synced.current) return;
		synced.current = true;
		sync.mutate(false);
	}, []);

	const all = list.data?.items ?? [];
	const shown = filterEntries(all, { chip, tag, q });
	const s = summarize(all);

	return (
		<>
			<Topbar title="매매일지" sub={sync.isPending ? "체결 가져오는 중…" : "앱 주문·자동 매매는 저절로, 계좌 체결은 가져오기로"}>
				<button className="btn btn-secondary btn-sm" onClick={() => sync.mutate(true)} disabled={sync.isPending} aria-label="체결 가져오기">
					{sync.isPending ? <span className="spin" /> : <RefreshIcon size={15} />}
					<span className="desktop-only">가져오기</span>
				</button>
				<button className="btn btn-primary" onClick={() => setDialog("new")} aria-label="직접 기록">
					<PlusIcon size={16} />
					<span className="desktop-only">기록</span>
				</button>
			</Topbar>

			<div className="page">
				<div className="wrap">
					<div className="filterbar">
						<div className="seg" role="group" aria-label="기간">
							{PERIODS.map((p) => (
								<button key={p.id} aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>
									{p.label}
								</button>
							))}
						</div>
						<span className="hint">
							챗에서 <span className="mono">어제 산 삼성전자 근거 적어줘</span>처럼 말해도 됩니다
						</span>
					</div>

					{list.isError && (
						<div className="notice bad mb-5" role="alert">
							<span>{(list.error as Error).message}</span>
						</div>
					)}

					<div className="grid-main">
						<div className="col">
							<section className="card fade-up" aria-labelledby="jr-title">
								<div className="card-h">
									<h2 id="jr-title">
										매매<span className="count">{shown.length}건</span>
									</h2>
									{tag && (
										<span className="filter-pill">
											#{tag}
											<button onClick={() => setTag(null)} aria-label="태그 필터 해제">
												<XIcon size={13} />
											</button>
										</span>
									)}
								</div>
								<div className="tx-tools">
									<label className="search-field">
										<SearchIcon size={15} />
										<span className="sr-only">일지 검색</span>
										<input className="input input-sm" type="search" placeholder="종목·근거 검색" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
									</label>
									<div className="hscroll" role="group" aria-label="걸러 보기">
										{CHIPS.map((c) => (
											<button key={c.id} className="chip" aria-pressed={chip === c.id} onClick={() => setChip(c.id)}>
												{c.label}
											</button>
										))}
									</div>
								</div>
								{list.isLoading ? <div className="empty">불러오는 중…</div> : <EntryList list={shown} total={all.length} onOpen={setDialog} />}
							</section>
						</div>

						<div className="col">
							<section className="card fade-up" aria-labelledby="jr-sum">
								<div className="sum-top">
									<div className="grow">
										<div className="eyebrow" id="jr-sum">
											{PERIODS.find((p) => p.id === period)?.label} 매매
										</div>
										<div className="big-num">
											{s.total}
											<span className="unit">건</span>
										</div>
									</div>
									<div className="sum-side">
										<div>
											매수<b>{s.buys}</b>
										</div>
										<div>
											매도<b>{s.sells}</b>
										</div>
										{s.pending > 0 && (
											<div>
												확인 전<b>{s.pending}</b>
											</div>
										)}
									</div>
								</div>
								{s.total > 0 && (
									<div className="border-t border-line">
										<Habit label="근거를 적은 매매" part={s.withThesis} total={s.total} onClick={() => setChip("missing")} hint="근거 없는 것만 보기" />
										<Habit label="손절가를 정한 매수" part={s.buysWithStop} total={s.buys} />
										<Habit label="회고를 쓴 매매" part={s.withReview} total={s.total} />
									</div>
								)}
							</section>

							{s.tags.length > 0 && (
								<section className="card fade-up">
									<div className="card-h">
										<h2>태그</h2>
										<span className="spacer" />
										<span className="eyebrow font-medium">누르면 그 태그만</span>
									</div>
									<div className="card-b jr-tags">
										{s.tags.map((t) => (
											<button key={t.tag} className="chip" aria-pressed={tag === t.tag} onClick={() => setTag((cur) => (cur === t.tag ? null : t.tag))}>
												#{t.tag} <span className="muted">{t.count}</span>
											</button>
										))}
									</div>
								</section>
							)}

							{s.emotions.length > 0 && (
								<section className="card fade-up">
									<div className="card-h">
										<h2>감정</h2>
									</div>
									<div className="cat-rows">
										{s.emotions.map((e) => (
											<div key={e.emotion} className="cat-row">
												<span />
												<span>{e.emotion}</span>
												<span className="cnt">{pct(e.count, s.total)}%</span>
												<span className="amt">{e.count}건</span>
											</div>
										))}
									</div>
								</section>
							)}
						</div>
					</div>
				</div>
			</div>

			<EntryDialog
				open={dialog}
				onClose={() => setDialog(null)}
				onSaved={() => void qc.invalidateQueries({ queryKey: ["journal"] })}
				onOpenConversation={(id) => {
					setDialog(null);
					onOpenConversation(id);
				}}
			/>
		</>
	);
}

/** 기록 습관 한 줄 — 비율 막대 */
function Habit({ label, part, total, onClick, hint }: { label: string; part: number; total: number; onClick?: () => void; hint?: string }) {
	if (total === 0) return null;
	const body = (
		<>
			<div className="top">
				<b>{label}</b>
				<span className="r">
					{part}/{total} · {pct(part, total)}%
				</span>
			</div>
			<div className="meter" role="meter" aria-valuenow={pct(part, total)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
				<i style={{ width: `${pct(part, total)}%` }} />
			</div>
		</>
	);
	return onClick ? (
		<button className="budget row-btn" onClick={onClick} title={hint}>
			{body}
		</button>
	) : (
		<div className="budget">{body}</div>
	);
}

function StatusBadge({ e }: { e: JournalEntryDto }) {
	if (e.status === "pending") return <span className="badge warn">체결 확인 전</span>;
	if (e.status === "canceled") return <span className="badge">체결 없이 끝남</span>;
	return null;
}

function EntryList({ list, total, onOpen }: { list: JournalEntryDto[]; total: number; onOpen: (e: JournalEntryDto) => void }) {
	if (list.length === 0) {
		return (
			<div className="empty">
				{total
					? "조건에 맞는 매매가 없습니다."
					: "이 기간 매매가 없습니다. 챗에서 주문하거나, 위쪽 ‘가져오기’로 계좌 체결을 불러오거나, ‘기록’으로 직접 남겨 보세요."}
			</div>
		);
	}
	const out: ReactNode[] = [];
	let last = "";
	for (const e of list) {
		if (e.date !== last) {
			last = e.date;
			const n = list.filter((x) => x.date === e.date).length;
			const wd = WEEKDAY[new Date(`${e.date}T00:00:00`).getDay()];
			out.push(
				<div key={`d${e.date}`} className="day-h">
					<span>
						{Number(e.date.slice(5, 7))}월 {Number(e.date.slice(8))}일 ({wd})
					</span>
					<span>{n}건</span>
				</div>,
			);
		}
		const amount = amountOf(e);
		out.push(
			<button key={e.id} className={`row row-btn tx jr-row ${e.status === "canceled" ? "jr-dim" : ""}`} role="listitem" onClick={() => onOpen(e)}>
				<span className={`side-tag ${e.side === "BUY" ? "buy" : "sell"}`}>{e.side === "BUY" ? "매수" : "매도"}</span>
				<span className="grow">
					<span className="name">
						{e.name ?? e.symbol}
						{e.name && <span className="mono muted jr-sym">{e.symbol}</span>}
					</span>
					<span className="meta">
						<span className="nw">{tradeText(e)} ·</span>{" "}
						<span className="nw">
							{BROKER_LABEL[e.broker]}
							{/* 계좌 체결이 대부분이라 목록에서는 나머지 출처만 표시한다 */}
							{e.source !== "import" && <span className="src">{SOURCE_LABEL[e.source]}</span>} <StatusBadge e={e} />
						</span>
					</span>
					<span className={`jr-thesis ${e.thesis ? "" : "muted"}`}>
						{e.thesis ?? "근거를 적어 두세요"}
						{e.tags.length > 0 && <span className="jr-tagline"> {e.tags.map((t) => `#${t}`).join(" ")}</span>}
					</span>
				</span>
				<span className="amt">
					{amount !== null && <b>{money(amount, e.currency)}</b>}
					{e.emotion && <small className="muted">{e.emotion}</small>}
				</span>
			</button>,
		);
	}
	return <div role="list">{out}</div>;
}

interface Form {
	side: "BUY" | "SELL";
	symbol: string;
	name: string;
	date: string;
	quantity: string;
	price: string;
	currency: string;
	fee: string;
	broker: JournalEntryDto["broker"];
	thesis: string;
	targetPrice: string;
	stopPrice: string;
	tags: string;
	emotion: string | null;
	review: string;
}

const numText = (v: number | null): string => (v === null ? "" : String(v));

function formOf(e: JournalEntryDto | null, today: string): Form {
	return {
		side: e?.side ?? "BUY",
		symbol: e?.symbol ?? "",
		name: e?.name ?? "",
		date: e?.date ?? today,
		quantity: e ? numText(e.quantity) : "",
		price: e ? numText(e.price) : "",
		currency: e?.currency ?? "",
		fee: e ? numText(e.fee) : "",
		broker: e?.broker ?? "other",
		thesis: e?.thesis ?? "",
		targetPrice: e ? numText(e.targetPrice) : "",
		stopPrice: e ? numText(e.stopPrice) : "",
		tags: e?.tags.join(", ") ?? "",
		emotion: e?.emotion ?? null,
		review: e?.review ?? "",
	};
}

/** 기록 보기·고치기 · 직접 기록 — 데스크톱은 가운데, 모바일은 바텀시트 */
function EntryDialog({
	open,
	onClose,
	onSaved,
	onOpenConversation,
}: {
	open: "new" | JournalEntryDto | null;
	onClose: () => void;
	onSaved: () => void;
	onOpenConversation: (id: string) => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const editing = open && open !== "new" ? open : null;
	/** 매매 칸을 고칠 수 있나 — 새 기록·직접 기록만 */
	const tradeEditable = !editing || editing.source === "manual";
	const [f, setF] = useState<Form>(() => formOf(null, kstToday()));
	const [error, setError] = useState<string | null>(null);
	const set = <K extends keyof Form>(k: K, v: Form[K]): void => setF((cur) => ({ ...cur, [k]: v }));

	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (!open) {
			if (d.open) d.close();
			return;
		}
		setF(formOf(editing, kstToday()));
		setError(null);
		if (!d.open) d.showModal();
	}, [open]);

	const save = useMutation({
		mutationFn: (body: Partial<JournalManualInput>) => (editing ? api.updateJournal(editing.id, body) : api.addJournal(body as JournalManualInput)),
		onSuccess: (e) => {
			toast(editing ? "일지를 고쳤습니다" : `${e.name ?? e.symbol} ${e.side === "BUY" ? "매수" : "매도"}를 기록했습니다`);
			onSaved();
			onClose();
		},
		onError: (e: Error) => setError(e.message),
	});
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteJournal(id),
		onSuccess: () => {
			toast("일지에서 지웠습니다");
			onSaved();
			onClose();
		},
		onError: (e: Error) => setError(e.message),
	});

	function submit(ev: FormEvent): void {
		ev.preventDefault();
		const notes = {
			thesis: f.thesis.trim() || null,
			targetPrice: parseNumber(f.targetPrice),
			stopPrice: parseNumber(f.stopPrice),
			tags: parseTags(f.tags),
			emotion: f.emotion,
			review: f.review.trim() || null,
		};
		if (!tradeEditable) return save.mutate(notes);
		const quantity = parseNumber(f.quantity);
		if (!f.symbol.trim()) return setError("종목코드나 티커를 입력하세요.");
		if (quantity === null || quantity <= 0) return setError("수량을 입력하세요.");
		save.mutate({
			...notes,
			// 날짜를 그대로 두면 보내지 않는다 — 다시 보내면 시각이 그날 정오로 바뀐다
			...(editing && editing.date === f.date ? {} : { date: f.date }),
			symbol: f.symbol.trim(),
			name: f.name.trim() || null,
			side: f.side,
			quantity,
			price: parseNumber(f.price),
			currency: f.currency.trim() || null,
			fee: parseNumber(f.fee),
			broker: f.broker,
		});
	}

	const ctx = editing?.context;
	const busy = save.isPending || remove.isPending;

	return (
		<dialog
			ref={ref}
			className="sheet"
			aria-labelledby="jr-dlg-title"
			onClose={onClose}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<form onSubmit={submit} noValidate>
				<div className="sheet-h">
					<h2 id="jr-dlg-title">{editing ? `${editing.name ?? editing.symbol} ${editing.side === "BUY" ? "매수" : "매도"}` : "매매 직접 기록"}</h2>
					<button type="button" className="icon-btn" onClick={onClose} aria-label="닫기">
						<XIcon />
					</button>
				</div>
				<div className="sheet-b">
					{editing && !tradeEditable && (
						<div className="jr-facts">
							<Fact k="체결">
								{tradeText(editing)} <StatusBadge e={editing} />
							</Fact>
							<Fact k="날짜">
								{editing.date} {new Date(editing.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
							</Fact>
							<Fact k="계좌">
								{BROKER_LABEL[editing.broker]} · {SOURCE_LABEL[editing.source]}
							</Fact>
							{editing.fee !== null && <Fact k="수수료·세금">{money(editing.fee, editing.currency)}</Fact>}
							{ctx?.orderType && (
								<Fact k="주문">
									{ctx.orderType === "LIMIT" ? `지정가${ctx.limitPrice ? ` ${money(ctx.limitPrice, editing.currency)}` : ""}` : "시장가"}
									{ctx.ordered ? ` × ${ctx.ordered}` : ""}
								</Fact>
							)}
							{ctx?.trigger && (
								<Fact k="감시">
									{ctx.trigger}
									{ctx.leg === "stop" ? " · 손절" : ctx.leg === "take" ? " · 익절" : ""}
									{ctx.condition && <span className="muted"> — {ctx.condition}</span>}
								</Fact>
							)}
							{ctx?.slippageBps !== undefined && ctx.slippageBps !== null && <Fact k="슬리피지">{ctx.slippageBps}bp (신호 때 중간가 대비)</Fact>}
							{editing.status === "pending" && <p className="field-hint">체결은 [가져오기]가 증권사에서 확인해 채웁니다.</p>}
							{editing.conversationId && (
								<button type="button" className="text-link text-[13px]" onClick={() => onOpenConversation(editing.conversationId!)}>
									주문을 준비한 대화 보기
								</button>
							)}
						</div>
					)}

					{tradeEditable && (
						<>
							<div className="seg block" role="group" aria-label="매수·매도">
								<button type="button" aria-pressed={f.side === "BUY"} onClick={() => set("side", "BUY")}>
									매수
								</button>
								<button type="button" aria-pressed={f.side === "SELL"} onClick={() => set("side", "SELL")}>
									매도
								</button>
							</div>
							<div className="grid2">
								<label className="field">
									<span>종목코드·티커</span>
									<input className="input mono" placeholder="005930, AAPL, BTCUSDT" autoComplete="off" value={f.symbol} onChange={(e) => set("symbol", e.target.value)} />
								</label>
								<label className="field">
									<span>종목명 (선택)</span>
									<input className="input" placeholder="삼성전자" autoComplete="off" value={f.name} onChange={(e) => set("name", e.target.value)} />
								</label>
							</div>
							<div className="grid2">
								<label className="field">
									<span>수량</span>
									<input className="input" inputMode="decimal" placeholder="10" autoComplete="off" value={f.quantity} onChange={(e) => set("quantity", e.target.value)} />
								</label>
								<label className="field">
									<span>평균 체결가 (선택)</span>
									<input className="input" inputMode="decimal" placeholder="71,000" autoComplete="off" value={f.price} onChange={(e) => set("price", e.target.value)} />
								</label>
							</div>
							<div className="grid2">
								<label className="field">
									<span>날짜</span>
									<input className="input" type="date" max={kstToday()} value={f.date} onChange={(e) => set("date", e.target.value || kstToday())} />
								</label>
								<label className="field">
									<span>어디서</span>
									<select className="input" value={f.broker} onChange={(e) => set("broker", e.target.value as Form["broker"])}>
										{Object.entries(BROKER_LABEL).map(([k, v]) => (
											<option key={k} value={k}>
												{v}
											</option>
										))}
									</select>
								</label>
							</div>
							<div className="grid2">
								<label className="field">
									<span>통화 (비우면 종목으로)</span>
									<input className="input mono" placeholder="KRW · USD · USDT" autoComplete="off" value={f.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} />
								</label>
								<label className="field">
									<span>수수료·세금 (선택)</span>
									<input className="input" inputMode="decimal" autoComplete="off" value={f.fee} onChange={(e) => set("fee", e.target.value)} />
								</label>
							</div>
						</>
					)}

					<label className="field">
						<span>근거 — 왜 샀나·팔았나</span>
						<textarea className="input" maxLength={1000} placeholder="예: 20일선 지지 + 외국인 3일 순매수, 실적 발표 전 분할 매수" value={f.thesis} onChange={(e) => set("thesis", e.target.value)} />
					</label>
					<div className="grid2">
						<label className="field">
							<span>목표가</span>
							<input className="input" inputMode="decimal" autoComplete="off" value={f.targetPrice} onChange={(e) => set("targetPrice", e.target.value)} />
						</label>
						<label className="field">
							<span>손절가</span>
							<input className="input" inputMode="decimal" autoComplete="off" value={f.stopPrice} onChange={(e) => set("stopPrice", e.target.value)} />
						</label>
					</div>
					<label className="field">
						<span>태그 (쉼표·띄어쓰기로 나눔)</span>
						<input className="input" placeholder="돌파, 실적, 눌림목" autoComplete="off" value={f.tags} onChange={(e) => set("tags", e.target.value)} />
					</label>
					<div className="field">
						<span>감정</span>
						<div className="jr-emotions" role="group" aria-label="감정">
							{EMOTIONS.map((x) => (
								<button key={x} type="button" className="chip" aria-pressed={f.emotion === x} onClick={() => set("emotion", f.emotion === x ? null : x)}>
									{x}
								</button>
							))}
						</div>
					</div>
					<label className="field">
						<span>회고 — 결과와 배운 점</span>
						<textarea className="input" maxLength={2000} placeholder="예: 손절가를 지켰다. 다음엔 거래량 확인 후 진입" value={f.review} onChange={(e) => set("review", e.target.value)} />
					</label>
					{error && <p className="field-err">{error}</p>}
				</div>
				<div className="sheet-f">
					{editing && (
						<button
							type="button"
							className="btn btn-danger mr-auto"
							disabled={busy}
							onClick={() => {
								const again = editing.source === "manual" ? "" : "\n지운 매매는 다음 가져오기에서 다시 들어오지 않습니다.";
								if (confirm(`이 기록을 지울까요?${again}`)) remove.mutate(editing.id);
							}}
						>
							삭제
						</button>
					)}
					<button type="button" className="btn btn-secondary" onClick={onClose}>
						취소
					</button>
					<button type="submit" className="btn btn-primary" disabled={busy}>
						{save.isPending ? "저장 중…" : "저장"}
					</button>
				</div>
			</form>
		</dialog>
	);
}

function Fact({ k, children }: { k: string; children: ReactNode }) {
	return (
		<div className="jr-fact">
			<span className="k">{k}</span>
			<span>{children}</span>
		</div>
	);
}
