/**
 * 채팅 상태 — WebSocket 연결·재연결·메시지 누적.
 *
 * 소켓은 한 번에 대화 하나에 붙는다 (PLAN §24). 지금 보는 대화 id 를 들고 있다가
 * 재연결할 때 그 id 로 다시 붙는다 — iOS 는 백그라운드에서 소켓을 끊지만 서버의 대화는 계속 돌고,
 * 포그라운드로 돌아오면 ready 스냅샷으로 그 사이 만들어진 답까지 복원된다 (PLAN.md §8.3).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageAttachment, StreamMessage, UIMessage } from "@alphafolio/protocol";
import { getToken, wsUrl } from "./auth.ts";

export interface RunningTool {
	id: string;
	name: string;
}

export interface ChatState {
	/** 지금 보고 있는 대화 (서버가 ready 로 확정하기 전에는 null) */
	sessionId: string | null;
	connected: boolean;
	streaming: boolean;
	messages: UIMessage[];
	/** 스트리밍 중인 텍스트 (아직 message_end로 확정되지 않은 부분) */
	pending: string;
	runningTools: RunningTool[];
	model: string;
	ledgerEnabled: boolean;
	error: string | null;
	/** images 의 dataUrl 은 낙관적 표시에만 쓰고 서버로는 base64 만 보낸다 */
	send: (text: string, images?: Array<ImageAttachment & { dataUrl?: string }>) => void;
	abort: () => void;
	/** 다른 대화로 옮긴다. null = 새 대화 */
	open: (sessionId: string | null) => void;
	newSession: () => void;
}

export interface ChatOptions {
	/** 처음 붙을 대화 (주소의 /c/<id>). 없으면 새 대화 */
	initialSessionId: string | null;
	/** 같은 사용자의 어떤 대화가 응답을 시작·끝냄 — 사이드바 목록 갱신용 */
	onActivity?: (sessionId: string, streaming: boolean) => void;
	/** 요청한 대화가 없어 새 대화로 돌아감 — 주소를 / 로 */
	onMissing?: (sessionId: string) => void;
}

const RECONNECT_DELAY_MS = 1500;

export function useChat(opts: ChatOptions): ChatState {
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [connected, setConnected] = useState(false);
	const [streaming, setStreaming] = useState(false);
	const [messages, setMessages] = useState<UIMessage[]>([]);
	const [pending, setPending] = useState("");
	const [runningTools, setRunningTools] = useState<RunningTool[]>([]);
	const [model, setModel] = useState("");
	const [ledgerEnabled, setLedgerEnabled] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const wsRef = useRef<WebSocket | null>(null);
	const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const closedRef = useRef(false);
	/** 재연결 때 다시 붙을 대화 — 렌더와 무관하게 최신값이어야 해서 ref */
	const wantedRef = useRef<string | null>(opts.initialSessionId);
	const optsRef = useRef(opts);
	optsRef.current = opts;

	/** 대화를 옮길 때 이전 대화의 화면 상태를 비운다 (ready 가 오기 전에 옛 메시지가 남지 않게) */
	const resetView = (): void => {
		setMessages([]);
		setPending("");
		setRunningTools([]);
		setStreaming(false);
		setError(null);
	};

	const connect = useCallback(() => {
		const token = getToken();
		if (!token) return;

		// 이미 연결 중이거나 연결된 소켓이 있으면 새로 열지 않는다.
		// OPEN 만 검사하면 StrictMode(dev)의 effect 재실행 때 CONNECTING 소켓이 하나 더 생겨
		// 같은 delta 가 두 번 적용된다 (스트리밍 텍스트가 두 줄씩 나오던 원인).
		const existing = wsRef.current?.readyState;
		if (existing === WebSocket.OPEN || existing === WebSocket.CONNECTING) return;

		const ws = new WebSocket(wsUrl());
		wsRef.current = ws;

		ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token, sessionId: wantedRef.current }));

		ws.onmessage = (ev: MessageEvent<string>) => {
			// 정리에서 놓친 예전 소켓의 메시지는 무시한다 (이중 반영 방지 2차 방어).
			if (wsRef.current !== ws) return;
			const msg = JSON.parse(ev.data) as StreamMessage;
			switch (msg.type) {
				case "ready":
					wantedRef.current = msg.sessionId;
					setSessionId(msg.sessionId);
					setConnected(true);
					setError(null);
					setModel(msg.model);
					setLedgerEnabled(msg.ledgerEnabled);
					setStreaming(msg.isStreaming);
					setMessages(msg.messages);
					setPending("");
					setRunningTools([]);
					return;
				case "agent_start":
					setStreaming(true);
					setPending("");
					setError(null);
					return;
				case "text_delta":
					setPending((p) => p + msg.delta);
					return;
				case "message_end":
					setMessages(msg.messages);
					setPending("");
					return;
				case "tool_start":
					setRunningTools((t) => [...t, { id: msg.id, name: msg.name }]);
					return;
				case "tool_end":
					setRunningTools((t) => t.filter((x) => x.id !== msg.id));
					return;
				case "agent_end":
					setStreaming(false);
					setRunningTools([]);
					return;
				case "error":
					setError(msg.message);
					setStreaming(false);
					return;
				case "session_missing":
					// 지워졌거나 남의 대화이거나, 저장 전에 서버가 재시작됨 — 새 대화로
					wantedRef.current = null;
					resetView();
					optsRef.current.onMissing?.(msg.sessionId);
					ws.send(JSON.stringify({ type: "open", sessionId: null }));
					return;
				case "activity":
					optsRef.current.onActivity?.(msg.sessionId, msg.streaming);
					return;
				default:
					return;
			}
		};

		ws.onclose = () => {
			// 이미 다른 소켓으로 교체됐으면 현재 연결 상태를 건드리지 않는다
			if (wsRef.current !== ws) return;
			setConnected(false);
			wsRef.current = null;
			if (!closedRef.current) {
				retryRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
			}
		};

		ws.onerror = () => ws.close();
	}, []);

	useEffect(() => {
		closedRef.current = false;
		connect();

		// iOS 포그라운드 복귀 시 즉시 재연결 (백그라운드에서 소켓이 끊긴다)
		const onVisible = (): void => {
			if (document.visibilityState === "visible") connect();
		};
		document.addEventListener("visibilitychange", onVisible);

		return () => {
			closedRef.current = true;
			document.removeEventListener("visibilitychange", onVisible);
			if (retryRef.current) clearTimeout(retryRef.current);
			const ws = wsRef.current;
			wsRef.current = null; // 닫기 전에 비워서 남은 이벤트가 무시되게 한다
			ws?.close();
		};
	}, [connect]);

	const command = useCallback((payload: Record<string, unknown>): void => {
		const ws = wsRef.current;
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
	}, []);

	// command 는 wsRef 만 읽으므로 재생성되지 않는다 — connect 도 마찬가지라
	// useEffect 가 불필요하게 재실행되지 않는다.

	const send = useCallback(
		(text: string, images: Array<ImageAttachment & { dataUrl?: string }> = []): void => {
			if (!text.trim() && images.length === 0) return;
			// 낙관적 반영 — 서버 message_end가 오면 정식 목록으로 교체된다
			setMessages((m) => [
				...m,
				{
					role: "user",
					content: [
						...images.map((i) => ({ type: "image" as const, dataUrl: i.dataUrl })),
						...(text.trim() ? [{ type: "text" as const, text }] : []),
					],
				},
			]);
			setError(null);
			// 진행 중이면 서버가 알아서 큐에 넣는다 (다른 탭·기기에서 대화 중일 수 있으므로
			// 클라이언트 상태로 prompt/steer 를 고르지 않는다)
			command({
				type: "prompt",
				text,
				...(images.length > 0 ? { images: images.map((i) => ({ mimeType: i.mimeType, data: i.data })) } : {}),
			});
		},
		[command],
	);

	const open = useCallback(
		(id: string | null): void => {
			// 이미 보고 있는 대화면 아무것도 하지 않는다 (새 대화 요청은 항상 새로)
			if (id !== null && id === wantedRef.current) return;
			wantedRef.current = id;
			setSessionId(null);
			resetView();
			// 끊겨 있으면 재연결 때 wantedRef 로 붙는다
			command({ type: "open", sessionId: id });
		},
		[command],
	);

	return {
		sessionId,
		connected,
		streaming,
		messages,
		pending,
		runningTools,
		model,
		ledgerEnabled,
		error,
		send,
		abort: () => command({ type: "abort" }),
		open,
		newSession: () => open(null),
	};
}
