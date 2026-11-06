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
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, SearchIcon } from "./icons.tsx";
import { BudgetCard } from "./ledger/BudgetCard.tsx";
import { shiftMonth } from "./ledger/format.ts";
import { MemberCard } from "./ledger/MemberCard.tsx";
import { SpendingCard } from "./ledger/SpendingCard.tsx";
import { TxDialog } from "./ledger/TxDialog.tsx";
import { TxList } from "./ledger/TxList.tsx";
import { useLedgerPage } from "./ledger/useLedgerPage.ts";
import { InviteInbox, LedgerSettings } from "./LedgerSettings.tsx";

export function LedgerPage() {
	const {
		thisMonth,
		month,
		setMonth,
		scope,
		setScope,
		setPicked,
		managing,
		setManaging,
		cat,
		setCat,
		q,
		setQ,
		dialog,
		setDialog,
		me,
		books,
		mine,
		current,
		ledgerId,
		summary,
		byMember,
		invalidate,
		cats,
		spent,
		income,
		budgetRows,
		budgetLeft,
		budgetLimit,
		budgetUsed,
		list,
		chipCats,
		shown,
		y,
		m,
		sumLabel,
		knownCats,
	} = useLedgerPage();

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
							<SpendingCard
								sumLabel={sumLabel}
								spent={spent}
								income={income}
								hasBudget={budgetRows.length > 0}
								budgetLeft={budgetLeft}
								cats={cats}
								loading={summary.isLoading}
								loaded={summary.isSuccess}
								onPickCat={setCat}
							/>

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

							<BudgetCard budgetRows={budgetRows} budgetUsed={budgetUsed} budgetLimit={budgetLimit} />

							{(byMember.data ?? []).length > 1 && <MemberCard rows={byMember.data ?? []} me={me.data?.user} />}
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
