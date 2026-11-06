/** MCP 설정 화면 공용 — 상태 문구 · 로고 머리글자 · 주소 검사 */
import type { UseQueryResult } from "@tanstack/react-query";
import type { McpServerStatus, McpToolsView } from "../../lib/api.ts";

export type AuthChoice = "oauth" | "bearer" | "none";
export type Filter = "all" | "read" | "confirm";

export const AUTH_LABEL: Record<McpServerStatus["auth"], string> = { oauth: "OAuth 로그인", headers: "고정 헤더", none: "인증 없음" };

/** OAuth 콜백이 붙여 준 결과 (?mcp=ok|error&msg=…) — 한 번 읽고 주소에서 지운다 */
export function takeCallbackNotice(): { ok: boolean; message: string } | null {
	const q = new URLSearchParams(location.search);
	const r = q.get("mcp");
	if (!r) return null;
	const message = q.get("msg") ?? (r === "ok" ? "연결됐습니다" : "연결하지 못했습니다");
	history.replaceState(null, "", location.pathname);
	return { ok: r === "ok", message };
}

export function statusOf(s: McpServerStatus): { text: string; tone: "ok" | "warn" | "bad" } {
	if (s.problem) return { text: s.problem, tone: "bad" };
	if (!s.connected) return { text: "연결 필요", tone: "warn" };
	if (s.auth === "oauth") return { text: "연결됨 · 자동 갱신", tone: "ok" };
	return { text: s.auth === "headers" ? `헤더 ${s.headerNames.join(", ")}` : "연결됨", tone: "ok" };
}

/** 로고 자리 — 대문자 머리글자가 둘 이상이면 그것 (TradingView → TV, DeepWiki → DW), 아니면 이름 앞 두 글자 */
export function square(s: McpServerStatus): string {
	const caps = s.name.match(/[A-Z]/g) ?? [];
	return caps.length >= 2 ? caps.slice(0, 2).join("") : s.name.replace(/\s/g, "").slice(0, 2).toUpperCase();
}

export function counts(q: UseQueryResult<McpToolsView> | undefined): string {
	if (!q || q.isLoading) return "툴 목록 받는 중…";
	const tools = q.data?.tools;
	if (!tools) return q.data?.error ? "툴 목록을 받지 못했습니다" : "연결하면 툴 목록을 받아 옵니다";
	const r = tools.filter((t) => t.mode === "read").length;
	return `툴 ${tools.length}개 · 바로 ${r} · 확인 ${tools.length - r}`;
}

/** "오늘 14:20" / "10월 7일 14:20" */
export function stamp(ms: number): string {
	const d = new Date(ms);
	const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	return d.toDateString() === new Date().toDateString() ? `오늘 ${hm}` : `${d.getMonth() + 1}월 ${d.getDate()}일 ${hm}`;
}

/** 서버 주소 검사 — 문구는 서버(packages/mcp/src/net.ts)와 같다. 최종 판단은 서버가 한다 (DNS 해석 포함) */
export function checkUrl(v: string): string | null {
	let u: URL;
	try {
		u = new URL(v);
	} catch {
		return "URL 형식이 아닙니다";
	}
	if (u.protocol !== "https:") return "https 주소만 쓸 수 있습니다 (원격 MCP 서버)";
	if (u.username || u.password) return "주소에 계정 정보를 넣을 수 없습니다 — 인증은 헤더·OAuth 로";
	const h = u.hostname.replace(/^\[|\]$/g, "");
	if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(h)) return "내부 호스트는 쓸 수 없습니다";
	if (/^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h) || /^(::1|f[cd]|fe80:)/i.test(h)) {
		return "사설·내부 주소는 쓸 수 없습니다";
	}
	return null;
}
