/**
 * WebSocket — 대화별 에이전트 이벤트 중계.
 *
 * 인증: 쿼리스트링이 아니라 **첫 메시지로 토큰을 받는다**.
 * (URL 쿼리는 프록시·액세스 로그에 남아 토큰이 유출된다)
 * 인증 전에는 다른 명령을 받지 않고, 5초 내 인증이 없으면 연결을 끊는다.
 *
 * 소켓 하나는 한 번에 **대화 하나**에 붙는다 (PLAN §24).
 *   - 대화 이벤트는 그 대화를 보고 있는 같은 사용자의 소켓에만 보낸다
 *   - 같은 사용자의 다른 소켓에는 "어느 대화가 응답 중인지" (activity) 만 보낸다 — 사이드바 표시용
 *   - 다른 사용자에게는 아무것도 가지 않는다
 *   - 소켓이 끊겨도 대화는 서버에서 끝까지 돈다 (앱을 꺼도 답이 만들어진다). 다시 붙으면 ready 로 복원
 *
 * pi 원본 이벤트를 그대로 흘리지 않는다:
 *   - thinking 채널 delta는 전송하지 않고, 본문의 사고 독백도 걸러낸다 (CotStreamFilter)
 *   - 페이로드를 UI가 쓰는 형태(StreamMessage)로만 축소한다
 */
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, StreamMessage } from "@alphafolio/protocol";
import { verifyToken } from "./auth.ts";
import { checkImages, MAX_WS_PAYLOAD } from "./images.ts";
import type { RuntimeManager } from "./runtimes.ts";
import { serializeMessages } from "./serialize.ts";
import { CotStreamFilter } from "./thinkingText.ts";
import type { AccountStore } from "./accounts.ts";

const AUTH_TIMEOUT_MS = 5000;

interface WsDeps {
	secret: string;
	accounts: AccountStore;
	runtimes: RuntimeManager;
	/** 호출 시점 판정 — 앱에서 키를 넣으면 재시작 없이 true 가 된다 */
	ledgerEnabled: () => boolean;
}

/** pi 이벤트의 우리가 쓰는 부분만 좁게 기술한 형태. */
interface PiEvent {
	type: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	args?: unknown;
	assistantMessageEvent?: { type: string; delta?: string };
}

/** 인증된 소켓 */
interface Client {
	ws: WebSocket;
	user: string;
	/** 토큰 버전 — 비밀번호 변경·비활성화 뒤에는 열린 소켓도 끊는다 */
	version: number;
	/** 지금 보고 있는 대화 (붙기 전·옮기는 중에는 null) */
	sessionId: string | null;
}

export function attachWebSocket(server: Server, deps: WsDeps): void {
	// 기본 한도(100MB)는 너무 크다 — 이미지 첨부 최대치까지만 받는다
	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
	/** 사용자별 인증된 소켓 */
	const clients = new Map<string, Set<Client>>();
	/** 대화별 사고 독백 필터 — 대화마다 스트림이 따로라 상태도 따로 둔다 */
	const filters = new Map<string, CotStreamFilter>();
	const key = (user: string, sessionId: string): string => `${user}\u0000${sessionId}`;

	const sendTo = (c: Client, msg: StreamMessage): void => {
		if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
	};

	/** 이 대화를 보고 있는 소켓들에만 */
	const toViewers = (user: string, sessionId: string, msg: StreamMessage): void => {
		const payload = JSON.stringify(msg);
		for (const c of clients.get(user) ?? []) {
			if (c.sessionId === sessionId && c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
		}
	};

	const hasViewers = (user: string, sessionId: string): boolean =>
		[...(clients.get(user) ?? [])].some((c) => c.sessionId === sessionId);

	/** 같은 사용자의 모든 소켓에 — 대화 내용 없이 상태만 */
	const toUser = (user: string, msg: StreamMessage): void => {
		for (const c of clients.get(user) ?? []) sendTo(c, msg);
	};

	// 대화 이벤트는 클라이언트가 없어도 온다 (백그라운드 응답). 볼 사람이 없으면 버려진다 — 결과는 세션 파일에 남는다.
	deps.runtimes.onEvent((user, sessionId, raw) => {
		const e = raw as PiEvent;
		const k = key(user, sessionId);
		let cot = filters.get(k);
		if (!cot) {
			cot = new CotStreamFilter();
			filters.set(k, cot);
		}
		// 볼 사람이 없으면 직렬화하지 않는다 (백그라운드 응답)
		const snapshot = (): void => {
			if (!hasViewers(user, sessionId)) return;
			const conv = deps.runtimes.peek(user, sessionId);
			if (conv) toViewers(user, sessionId, { type: "message_end", messages: serializeMessages(conv.messages) });
		};

		switch (e.type) {
			case "agent_start":
				cot.reset();
				toViewers(user, sessionId, { type: "agent_start" });
				toUser(user, { type: "activity", sessionId, streaming: true });
				return;
			case "message_update": {
				const inner = e.assistantMessageEvent;
				if (inner?.type !== "text_delta" || !inner.delta) return; // thinking 채널 비전송
				const clean = cot.push(inner.delta);
				if (clean) toViewers(user, sessionId, { type: "text_delta", delta: clean });
				return;
			}
			case "message_end": {
				const tail = cot.flush();
				if (tail) toViewers(user, sessionId, { type: "text_delta", delta: tail });
				snapshot();
				return;
			}
			case "tool_execution_start":
				toViewers(user, sessionId, {
					type: "tool_start",
					id: e.toolCallId ?? "",
					name: e.toolName ?? "unknown",
					args: e.args,
				});
				return;
			case "tool_execution_end":
				toViewers(user, sessionId, {
					type: "tool_end",
					id: e.toolCallId ?? "",
					name: e.toolName ?? "unknown",
					isError: e.isError === true,
				});
				return;
			case "agent_end":
				toViewers(user, sessionId, { type: "agent_end" });
				snapshot();
				toUser(user, { type: "activity", sessionId, streaming: false });
				filters.delete(k);
				return;
			default:
				return;
		}
	});

	/** 소켓을 대화에 붙인다 (이전 대화에서는 뗀다). 없는 대화면 session_missing. */
	async function openConversation(c: Client, sessionId: string | null): Promise<void> {
		if (c.sessionId) {
			deps.runtimes.detach(c.user, c.sessionId);
			c.sessionId = null;
		}
		const conv = await deps.runtimes.conversation(c.user, sessionId);
		if (!conv) {
			sendTo(c, { type: "session_missing", sessionId: sessionId ?? "" });
			return;
		}
		// 옮기는 사이에 소켓이 닫혔으면 붙이지 않는다 (붙이면 대화가 영영 정리되지 않는다)
		if (c.ws.readyState !== c.ws.OPEN) return;
		c.sessionId = conv.sessionId;
		deps.runtimes.attach(c.user, conv.sessionId);
		sendTo(c, {
			type: "ready",
			sessionId: conv.sessionId,
			model: conv.modelLabel,
			ledgerEnabled: deps.ledgerEnabled(),
			isStreaming: conv.isStreaming,
			messages: serializeMessages(conv.messages),
		});
	}

	server.on("upgrade", (req, socket, head) => {
		const path = (req.url ?? "").split("?")[0];
		if (path !== "/ws") {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
	});

	wss.on("connection", (ws: WebSocket) => {
		let client: Client | null = null;
		/** 대화 열기·옮기기는 순서대로 — 빠르게 두 번 누르면 나중 것이 이겨야 한다 */
		let queue: Promise<void> = Promise.resolve();

		const send = (msg: StreamMessage): void => {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
		};
		const fail = (err: unknown): void => send({ type: "error", message: err instanceof Error ? err.message : String(err) });

		const timer = setTimeout(() => {
			if (!client) {
				send({ type: "error", message: "인증 시간 초과" });
				ws.close(4401, "unauthorized");
			}
		}, AUTH_TIMEOUT_MS);

		ws.on("message", (raw) => {
			let msg: ClientMessage;
			try {
				msg = JSON.parse(raw.toString()) as ClientMessage;
			} catch {
				send({ type: "error", message: "JSON 파싱 실패" });
				return;
			}

			if (!client) {
				if (msg.type !== "auth") {
					send({ type: "error", message: "인증이 필요합니다" });
					ws.close(4401, "unauthorized");
					return;
				}
				const verified = verifyToken(msg.token, deps.secret);
				// 서명이 맞아도 계정이 비활성화됐거나 비밀번호가 바뀌었을 수 있다 (토큰 버전)
				if (!verified || !deps.accounts.accepts(verified.user, verified.version)) {
					send({ type: "error", message: "인증 실패" });
					ws.close(4401, "unauthorized");
					return;
				}
				clearTimeout(timer);
				const name = verified.user;
				const c: Client = { ws, user: name, version: verified.version, sessionId: null };
				client = c;
				let set = clients.get(name);
				if (!set) clients.set(name, (set = new Set()));
				set.add(c);
				const wanted = typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : null;
				queue = queue.then(() => openConversation(c, wanted)).catch(fail);
				return;
			}

			const c = client;
			// 연결 뒤에 비밀번호가 바뀌었거나 비활성화됐으면 이 소켓도 끊는다
			if (!deps.accounts.accepts(c.user, c.version)) {
				send({ type: "error", message: "다시 로그인해 주세요" });
				ws.close(4401, "unauthorized");
				return;
			}
			switch (msg.type) {
				case "open":
				case "new_session": {
					const wanted = msg.type === "open" && typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : null;
					queue = queue.then(() => openConversation(c, wanted)).catch(fail);
					return;
				}
				case "ping":
					send({ type: "pong" });
					return;
				default:
					// 대화 명령은 열기가 끝난 뒤에 — 새 대화를 열자마자 보낸 첫 메시지가 이전 대화로 가지 않게
					queue = queue.then(() => runCommand(c, msg)).catch(fail);
			}
		});

		ws.on("close", () => {
			clearTimeout(timer);
			const c = client;
			if (!c) return;
			clients.get(c.user)?.delete(c);
			if (clients.get(c.user)?.size === 0) clients.delete(c.user);
			// 대화는 계속 돈다 — 떼기만 한다
			if (c.sessionId) deps.runtimes.detach(c.user, c.sessionId);
			c.sessionId = null;
		});
	});

	async function runCommand(c: Client, msg: ClientMessage): Promise<void> {
		const sessionId = c.sessionId;
		if (!sessionId) {
			sendTo(c, { type: "error", message: "열린 대화가 없습니다" });
			return;
		}
		const conv = await deps.runtimes.conversation(c.user, sessionId);
		if (!conv) {
			sendTo(c, { type: "session_missing", sessionId });
			return;
		}
		deps.runtimes.touch(c.user, sessionId);

		// 이미지 — 형식·크기 검증, 모델이 못 읽으면 보내기 전에 알린다 (SDK 가 조용히 빼지 않게)
		let images: Array<{ mimeType: string; data: string }> = [];
		if (msg.type === "prompt" || msg.type === "steer") {
			const checked = checkImages(msg.images);
			if (!checked.ok) {
				sendTo(c, { type: "error", message: checked.error });
				return;
			}
			images = checked.images;
			if (images.length > 0 && !conv.acceptsImages) {
				sendTo(c, { type: "error", message: `지금 모델(${conv.modelLabel})은 이미지를 읽지 못합니다` });
				return;
			}
		}
		// 이미지만 보내도 된다 — 질문이 없으면 무엇인지 묻는 것으로 본다
		const text = (msg.type === "prompt" || msg.type === "steer") && !msg.text.trim() && images.length > 0
			? "이 이미지를 봐줘."
			: msg.type === "prompt" || msg.type === "steer"
				? msg.text
				: "";

		switch (msg.type) {
			case "prompt":
				if (!text.trim()) return;
				// 응답은 기다리지 않는다 — 기다리면 이 소켓의 다음 명령(다른 대화로 옮기기 등)이 답이 끝날 때까지 막힌다.
				// 소켓이 끊겨도 대화는 끝까지 돈다. 실패는 그때 보고 있는 사람에게 알리고 로그에 남긴다.
				// 클라이언트의 streaming 상태는 믿지 않는다 — 다른 탭·기기에서 같은 대화가 진행 중일 수 있다.
				void (conv.isStreaming ? conv.followUp(text, images) : conv.prompt(text, images)).catch((err: unknown) => {
					console.warn(`[agent] 응답 실패 — user=${c.user} session=${sessionId}:`, err);
					toViewers(c.user, sessionId, { type: "error", message: err instanceof Error ? err.message : String(err) });
				});
				return;
			case "steer":
				if (!text.trim()) return;
				await conv.steer(text, images);
				return;
			case "abort":
				await conv.abort();
				return;
			default:
				sendTo(c, { type: "error", message: "알 수 없는 명령" });
		}
	}
}
