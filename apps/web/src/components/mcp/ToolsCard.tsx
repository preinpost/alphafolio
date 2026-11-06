import { useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useState } from "react";
import { api, type McpServerStatus, type McpToolsView, type McpToolView } from "../../lib/api.ts";
import { toast } from "../../lib/toast.ts";
import { AlertIcon, InfoIcon, RefreshIcon, SearchIcon } from "../icons.tsx";
import { stamp, type Filter } from "./helpers.ts";

export function ToolsCard({
	servers,
	current,
	query,
	countOf,
	onPick,
}: {
	servers: McpServerStatus[];
	current: McpServerStatus;
	query: UseQueryResult<McpToolsView> | undefined;
	countOf: (id: string) => number | null;
	onPick: (id: string) => void;
}) {
	const qc = useQueryClient();
	const [filter, setFilter] = useState<Filter>("all");
	const [q, setQ] = useState("");
	const refresh = useMutation({
		mutationFn: () => api.refreshMcpTools(current.id),
		onSuccess: (view) => {
			qc.setQueryData(["mcp-tools", current.id, current.connected], view);
			toast(view.error ? `다시 받지 못했습니다: ${view.error}` : "툴 목록을 다시 받았습니다");
		},
	});

	const view = query?.data;
	const tools = view?.tools ?? [];
	const reads = tools.filter((t) => t.mode === "read").length;
	const needle = q.trim().toLowerCase();
	const hit = tools.filter(
		(t) => (filter === "all" || t.mode === filter) && (!needle || [t.name, t.label, t.title, t.description].some((v) => v?.toLowerCase().includes(needle))),
	);

	const refreshBtn = (
		<button className="icon-btn" onClick={() => refresh.mutate()} disabled={refresh.isPending} aria-label="툴 목록 다시 받기" title="다시 받기">
			{refresh.isPending ? <span className="spin" /> : <RefreshIcon size={16} />}
		</button>
	);

	let meta = null;
	if (!query || query.isLoading)
		meta = (
			<div className="tools-meta">
				<span className="spin" />
				<span className="t">툴 목록을 받는 중…</span>
			</div>
		);
	else if (view?.error)
		meta = (
			<div className="tools-meta bad">
				<AlertIcon size={15} />
				<span className="t">{view.error}</span>
				{current.connected && refreshBtn}
			</div>
		);
	else if (view?.source === "preset")
		meta = (
			<div className="tools-meta">
				<InfoIcon size={15} />
				<span className="t">연결 전이라 이름과 판정만 보입니다. 이름은 {current.name} 프리셋 목록 기준이고, 설명은 연결하면 서버에서 받아 옵니다.</span>
			</div>
		);
	else if (view?.source === "server")
		meta = (
			<div className="tools-meta">
				<InfoIcon size={15} />
				<span className="t">
					설명은 서버가 보낸 원문 그대로입니다. 에이전트도 같은 설명을 보고 툴을 고릅니다.
					{view.fetchedAt ? ` · ${stamp(view.fetchedAt)} 받음` : ""} · 10분 캐시
				</span>
				{refreshBtn}
			</div>
		);

	return (
		<section className="card" aria-labelledby="mcp-tools-h">
			<div className="card-h tools-h">
				<h2 id="mcp-tools-h">툴</h2>
				<span className="spacer" />
				{servers.length > 1 && (
					<div className="seg max-w-full overflow-x-auto" role="group" aria-label="서버 고르기">
						{servers.map((s) => {
							const n = countOf(s.id);
							return (
								<button key={s.id} aria-pressed={s.id === current.id} onClick={() => onPick(s.id)}>
									{s.name}
									{n !== null && <span className="num"> {n}</span>}
								</button>
							);
						})}
					</div>
				)}
			</div>
			{meta}
			{tools.length > 0 && (
				<div className="tools-bar">
					<label className="search-field">
						<SearchIcon size={15} />
						<span className="sr-only">툴 검색</span>
						<input className="input input-sm" type="search" placeholder="이름·설명으로 찾기" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
					</label>
					<div className="hscroll" role="group" aria-label="판정으로 거르기">
						{(
							[
								["all", "전체", tools.length],
								["read", "바로 실행", reads],
								["confirm", "확인 카드", tools.length - reads],
							] as const
						).map(([v, label, n]) => (
							<button key={v} className="chip" aria-pressed={filter === v} onClick={() => setFilter(v)}>
								{label} <span className="num">{n}</span>
							</button>
						))}
					</div>
				</div>
			)}
			<div className="rows border-t border-line">
				{view && !view.tools && !view.error && <div className="empty">{current.name}에 연결하면 툴 목록을 받아 옵니다.</div>}
				{view?.tools && tools.length === 0 && <div className="empty">서버가 보낸 툴이 없습니다.</div>}
				{tools.length > 0 && hit.length === 0 && <div className="empty">‘{q.trim()}’와 맞는 툴이 없습니다.</div>}
				{(
					[
						["read", "바로 실행 — 에이전트가 바로 호출"],
						["confirm", "확인 카드 — 사람이 [확인]을 눌러야 실행"],
					] as const
				).map(([mode, title]) => {
					const group = hit.filter((t) => t.mode === mode);
					if (group.length === 0) return null;
					return (
						<div key={mode}>
							<div className="t-grp">
								{title} · <span className="num">{group.length}</span>
							</div>
							<div className="rows border-t border-line">
								{group.map((t) => (
									<ToolRow key={t.name} t={t} />
								))}
							</div>
						</div>
					);
				})}
			</div>
		</section>
	);
}

function ToolRow({ t }: { t: McpToolView }) {
	const heading = t.label ?? (t.title && t.title !== t.name ? t.title : null);
	return (
		// 판정 이유 (왜 바로 실행 / 확인 카드인지) 는 올리면
		<div className="row mcp-tool" title={t.reason}>
			<span className="grow">
				<span className="tn">{t.name}</span>
				{heading && <span className="tl">{heading}</span>}
				<span className="td">{t.description ?? "설명은 연결 후 표시"}</span>
				{t.params.length > 0 && (
					<span className="tp" aria-label="파라미터">
						{t.params.map((p) => (
							<span key={p.name} title={p.description ?? undefined}>
								<b>{p.name}</b>
								{p.required ? "*" : ""}
								{p.type ? `: ${p.type}` : ""}
							</span>
						))}
					</span>
				)}
				{t.note && <span className="td">{t.note}</span>}
			</span>
			{t.mode === "confirm" && (
				<span className={`badge ${t.destructive ? "bad" : "warn"}`} title={t.reason}>
					{t.destructive ? "확인 · 삭제" : "확인 카드"}
				</span>
			)}
		</div>
	);
}
