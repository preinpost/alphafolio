import type { PortfolioDto } from "@alphafolio/protocol";
import { useState } from "react";
import { groupHoldings } from "../../lib/portfolio.ts";
import { cryptoRow, groupedRow, isDust, manualRow, stockRow, type HoldRow, type Kind, type Sort } from "./rows.ts";

/** 보유 자산 표 — 보기 방식·종류·검색·정렬과 걸러낸 줄 */
export function useHoldingsView(p: PortfolioDto | undefined, only: string | null, total: number) {
	const [showDust, setShowDust] = useState(false);
	/** 보유 목록 — 계좌별(account) 또는 같은 종목 합치기(symbol) */
	const [view, setView] = useState<"account" | "symbol">("account");
	const [kind, setKind] = useState<Kind | "all">("all");
	const [q, setQ] = useState("");
	const [sort, setSort] = useState<Sort>("value");

	const holdings = (p?.holdings ?? []).filter((h) => !only || h.broker === only);
	const crypto = (p?.crypto ?? []).filter((c) => !only || c.source === only);
	const manual = (p?.manual ?? []).filter(() => !only || only === "manual");
	const dust = crypto.filter(isDust);
	const allRows: HoldRow[] = [
		...(view === "symbol" ? groupHoldings(holdings).map((g) => groupedRow(g, total)) : holdings.map((h) => stockRow(h, total))),
		...(showDust ? crypto : crypto.filter((c) => !isDust(c))).map(cryptoRow),
		...manual.map((m) => manualRow(m, total)),
	];
	const needle = q.trim().toLowerCase();
	const rows = allRows
		.filter((r) => kind === "all" || r.kind === kind)
		.filter((r) => !needle || r.name.toLowerCase().includes(needle) || (r.sym ?? "").toLowerCase().includes(needle))
		.sort(
			sort === "name"
				? (a, b) => a.name.localeCompare(b.name, "ko")
				: sort === "pnl"
					? (a, b) => (b.pnlPct ?? -Infinity) - (a.pnlPct ?? -Infinity)
					: (a, b) => b.valueKrw - a.valueKrw,
		);

	return { showDust, setShowDust, view, setView, kind, setKind, q, setQ, sort, setSort, dust, allRows, rows };
}

export type HoldingsView = ReturnType<typeof useHoldingsView>;
