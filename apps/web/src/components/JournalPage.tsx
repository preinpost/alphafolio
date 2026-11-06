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
import { CHIPS, PERIODS } from "../lib/journal.ts";
import { PlusIcon, RefreshIcon, SearchIcon, XIcon } from "./icons.tsx";
import { EntryDialog } from "./journal/EntryDialog.tsx";
import { EntryList } from "./journal/EntryList.tsx";
import { JournalSummary } from "./journal/JournalSummary.tsx";
import { useJournalPage } from "./journal/useJournalPage.ts";
import { Topbar } from "./Topbar.tsx";

export function JournalPage({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
	const { period, setPeriod, chip, setChip, tag, setTag, q, setQ, dialog, setDialog, qc, list, sync, all, shown, s } = useJournalPage();

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
							<JournalSummary period={period} s={s} tag={tag} setTag={setTag} setChip={setChip} />
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
