import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type McpAddInput, type McpListing, type McpServerStatus } from "../../lib/api.ts";
import { isNativeApp } from "../../lib/auth.ts";
import { toast } from "../../lib/toast.ts";
import { takeCallbackNotice } from "./helpers.ts";

/** MCP 서버 목록 · 서버별 툴 목록 · 추가/삭제/연결/테스트 */
export function useMcpServers() {
	const qc = useQueryClient();
	const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
	const [tests, setTests] = useState<Record<string, { ok: boolean; message: string }>>({});
	const [adding, setAdding] = useState(false);
	const [deleting, setDeleting] = useState<McpServerStatus | null>(null);
	const [selected, setSelected] = useState<string | null>(null);

	useEffect(() => setNotice(takeCallbackNotice()), []);

	// 앱에서 시스템 브라우저로 로그인하고 돌아오면 다시 읽는다 — 전역 기본값은 포커스 재조회를 끈다 (main.tsx)
	const list = useQuery({ queryKey: ["mcp"], queryFn: api.mcpServers, refetchOnWindowFocus: "always" });
	const items = list.data?.items ?? [];
	// 서버마다 툴 목록 — 서버가 10분 캐시하므로 화면은 5분 동안 다시 묻지 않는다
	const toolQueries = useQueries({
		queries: items.map((s) => ({
			// 연결 상태가 바뀌면 다른 목록이다 (프리셋 이름 → 서버 원문)
			queryKey: ["mcp-tools", s.id, s.connected],
			queryFn: () => api.mcpTools(s.id),
			staleTime: 5 * 60_000,
			retry: false,
		})),
	});
	const toolsOf = (id: string) => toolQueries[items.findIndex((s) => s.id === id)];

	const set = (data: McpListing) => qc.setQueryData(["mcp"], data);
	const refreshTools = () => void qc.invalidateQueries({ queryKey: ["mcp-tools"] });

	const add = useMutation({
		mutationFn: (i: McpAddInput) => api.addMcpServer(i),
		onSuccess: (d, input) => {
			set(d);
			setAdding(false);
			const added = "preset" in input ? d.items.find((s) => s.preset === input.preset) : d.items.find((s) => s.name === input.name);
			if (added) setSelected(added.id);
			toast("서버를 추가했습니다");
		},
	});
	const remove = useMutation({
		mutationFn: api.deleteMcpServer,
		onSuccess: (d) => {
			set(d);
			refreshTools();
			toast("서버를 삭제했습니다");
		},
		onError: (e: Error) => toast(`삭제하지 못했습니다: ${e.message}`),
	});
	const disconnect = useMutation({
		mutationFn: api.disconnectMcp,
		onSuccess: (d, id) => {
			set(d);
			setTests(({ [id]: _, ...rest }) => rest);
			refreshTools();
			toast("연결을 해제했습니다");
		},
	});
	const test = useMutation({
		mutationFn: async (id: string) => ({ id, r: await api.testMcp(id) }),
		onSuccess: ({ id, r }) => {
			setTests((t) => ({ ...t, [id]: r }));
			// 테스트가 툴 목록 캐시도 새로 받았다
			void qc.invalidateQueries({ queryKey: ["mcp-tools", id] });
		},
	});
	const connect = useMutation({
		mutationFn: (id: string) => api.startMcpOAuth(id, isNativeApp ? "app" : "web"),
		onSuccess: ({ url }) => {
			// 앱: WKWebView 밖(Safari)으로 — Capacitor 는 외부 주소의 window.open 을 시스템 브라우저로 넘긴다
			if (isNativeApp) window.open(url, "_blank");
			else location.assign(url);
		},
		onError: (e: Error) => toast(`연결을 시작하지 못했습니다: ${e.message}`),
	});

	const data = list.data;
	const busy = add.isPending || remove.isPending || disconnect.isPending || connect.isPending;
	const presets = data?.presets.filter((p) => !p.added) ?? [];
	const current = items.find((s) => s.id === selected) ?? items[0];

	return {
		notice,
		setNotice,
		tests,
		adding,
		setAdding,
		deleting,
		setDeleting,
		setSelected,
		list,
		items,
		toolsOf,
		add,
		remove,
		disconnect,
		test,
		connect,
		data,
		busy,
		presets,
		current,
	};
}
