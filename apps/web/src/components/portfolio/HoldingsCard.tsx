import { ManualAssetEditor } from "../ManualAssetEditor.tsx";
import { ArrowUpIcon, ChevronDownIcon, PlusIcon, SearchIcon, XIcon } from "../icons.tsx";
import { approxWon, move, signedPct } from "./format.ts";
import { BROKER_LABEL, KIND_CHIPS, type HoldRow, type Sort } from "./rows.ts";
import type { HoldingsView } from "./useHoldingsView.ts";

/** 보유 자산 — 계좌 필터·보기 방식·검색·정렬 · 직접 입력 자산은 눌러서 고친다 */
export function HoldingsCard({
	holdings,
	only,
	setOnly,
	editing,
	setEditing,
	canAddManual,
}: {
	holdings: HoldingsView;
	only: string | null;
	setOnly: (v: string | null) => void;
	editing: string | null;
	setEditing: (v: string | null) => void;
	canAddManual: boolean;
}) {
	const { rows, allRows, dust, showDust, setShowDust, view, setView, kind, setKind, q, setQ, sort, setSort } = holdings;
	return (
		<section className="card fade-up o-4" aria-labelledby="hold-title">
			<div className="card-h flex-wrap">
				<h2 id="hold-title">
					보유 자산<span className="count">{rows.length}</span>
				</h2>
				{only && (
					<span className="filter-pill">
						{BROKER_LABEL[only] ?? only}만
						<button onClick={() => setOnly(null)} aria-label="계좌 필터 해제">
							<XIcon size={13} />
						</button>
					</span>
				)}
				<span className="spacer" />
				<div className="seg" role="group" aria-label="보기 방식">
					<button aria-pressed={view === "account"} onClick={() => setView("account")}>
						계좌별
					</button>
					<button aria-pressed={view === "symbol"} onClick={() => setView("symbol")}>
						종목별
					</button>
				</div>
			</div>
			<div className="hold-tools">
				<label className="search-field">
					<SearchIcon size={15} />
					<span className="sr-only">종목 검색</span>
					<input className="input input-sm" type="search" placeholder="종목명·티커 검색" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
				</label>
				<div className="hscroll" role="group" aria-label="자산 종류">
					{KIND_CHIPS.map((k) => (
						<button key={k.key} className="chip" aria-pressed={kind === k.key} onClick={() => setKind(k.key)}>
							{k.label}
						</button>
					))}
				</div>
				<label>
					<span className="sr-only">정렬</span>
					<select className="input input-sm" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
						<option value="value">평가금액순</option>
						<option value="pnl">수익률순</option>
						<option value="name">이름순</option>
					</select>
				</label>
			</div>
			<div className="hold-grid hold-head" aria-hidden="true">
				<span>종목</span>
				<span className="c-price">현재가</span>
				<span className="c-val">평가금액</span>
				<span>
					<span className="desktop-only">손익</span>
					<span className="mobile-only">평가 · 손익</span>
				</span>
			</div>
			<div className="hold-list" role="list">
				{rows.map((r) =>
					r.manual && editing === r.manual.id ? (
						<ManualAssetEditor key={r.key} asset={r.manual} onDone={() => setEditing(null)} />
					) : (
						<HoldingRow key={r.key} r={r} onEdit={r.manual ? () => setEditing(r.manual!.id) : undefined} />
					),
				)}
				{rows.length === 0 && editing !== "new" && (
					<div className="empty">{allRows.length ? "조건에 맞는 자산이 없습니다." : "보유 자산이 없습니다."}</div>
				)}
			</div>
			{dust.length > 0 && (kind === "all" || kind === "crypto") && (
				<button className="row-add" onClick={() => setShowDust((v) => !v)}>
					{showDust ? <ArrowUpIcon size={14} /> : <ChevronDownIcon size={14} />}
					{showDust ? "1달러 미만 코인 접기" : `1달러 미만 코인 ${dust.length}개 더 보기`}
				</button>
			)}
			{canAddManual && <AddManual editing={editing} setEditing={setEditing} />}
		</section>
	);
}

function HoldingRow({ r, onEdit }: { r: HoldRow; onEdit: (() => void) | undefined }) {
	const body = (
		<>
			<div className="min-w-0">
				<div className="name">
					<span>{r.name}</span>
					{r.sym && <span className="mono">{r.sym}</span>}
				</div>
				<div className={`meta ${r.metaWarn ? "danger-text" : ""}`} title={r.meta}>
					{r.meta}
				</div>
			</div>
			<div className="c-price">
				<div className="v sm">{r.price ?? "—"}</div>
			</div>
			<div className="c-val">
				<div className="v">{r.value}</div>
				<div className="s muted" title={approxWon(r.valueKrw) || undefined}>
					{r.valueSub}
				</div>
			</div>
			<div>
				<div className="v mobile-only">{r.valueShort}</div>
				{r.pnlPct === null ? (
					<div className="s muted">{r.manual ? "직접 입력" : "손익 없음"}</div>
				) : (
					<>
						<div className={`v desktop-only ${move(r.pnlPct)}`}>{r.pnl}</div>
						<div className={`s ${move(r.pnlPct)}`} title={r.pnlTitle}>
							{r.pnlShort && <span className="mobile-only">{r.pnlShort} · </span>}
							{signedPct(r.pnlPct)}
							{r.pnlNote ? ` ${r.pnlNote}` : ""}
						</div>
					</>
				)}
			</div>
		</>
	);
	if (onEdit)
		return (
			<button className="hold-grid hold-row" role="listitem" onClick={onEdit} title="눌러서 금액 고치기">
				{body}
			</button>
		);
	return (
		<div className="hold-grid hold-row" role="listitem">
			{body}
		</div>
	);
}

export function AddManual({ editing, setEditing }: { editing: string | null; setEditing: (v: string | null) => void }) {
	if (editing === "new") return <ManualAssetEditor onDone={() => setEditing(null)} />;
	return (
		<button className="row-add" onClick={() => setEditing("new")}>
			<PlusIcon size={14} />
			직접 입력 자산 추가 (예금·연금·부동산 등)
		</button>
	);
}
