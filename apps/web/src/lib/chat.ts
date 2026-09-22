/**
 * 채팅 상태 — WebSocket 연결·재연결·메시지 누적.
 *
 * iOS는 백그라운드에서 WebSocket을 끊는다. 포그라운드 복귀(visibilitychange) 시
 * 재연결하고, 서버가 ready로 내려주는 스냅샷으로 대화를 복원한다 (PLAN.md §8.3).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamMessage, UIMessage } from "@alphafolio/protocol";
import { getToken, wsUrl } from "./auth.ts";

export interface RunningTool {
	id: string;
	name: string;
}

export interface ChatState {
	connected: boolean;
	streaming: boolean;
	messages: UIMessage[];
	/** 스트리밍 중인 텍스트 (아직 message_end로 확정되지 않은 부분) */
	pending: string;
	runningTools: RunningTool[];
	model: string;
	ledgerEnabled: boolean;
	error: string | null;
	send: (text: string) => void;
	abort: () => void;
	newSession: () => void;
}

const RECONNECT_DELAY_MS = 1500;

export function useChat(): ChatState {
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

		ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));

		ws.onmessage = (ev: MessageEvent<string>) => {
			// 정리에서 놓친 예전 소켓의 메시지는 무시한다 (이중 반영 방지 2차 방어).
			if (wsRef.current !== ws) return;
			const msg = JSON.parse(ev.data) as StreamMessage;
			switch (msg.type) {
				case "ready":
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
		(text: string): void => {
			if (!text.trim()) return;
			// 낙관적 반영 — 서버 message_end가 오면 정식 목록으로 교체된다
			setMessages((m) => [...m, { role: "user", content: [{ type: "text", text }] }]);
			setError(null);
			// 진행 중이면 서버가 알아서 큐에 넣는다 (다른 탭·기기에서 대화 중일 수 있으므로
			// 클라이언트 상태로 prompt/steer 를 고르지 않는다)
			command({ type: "prompt", text });
		},
		[command],
	);

	return {
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
		newSession: () => command({ type: "new_session" }),
	};
}
