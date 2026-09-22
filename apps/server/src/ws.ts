/**
 * WebSocket — 사용자별 에이전트 이벤트 중계.
 *
 * 인증: 쿼리스트링이 아니라 **첫 메시지로 토큰을 받는다**.
 * (URL 쿼리는 프록시·액세스 로그에 남아 토큰이 유출된다)
 * 인증 전에는 다른 명령을 받지 않고, 5초 내 인증이 없으면 연결을 끊는다.
 *
 * ⚠️ 이벤트는 **같은 사용자의 클라이언트에게만** 보낸다.
 *    (데스크탑+모바일 동시 접속은 같은 대화를 공유하고, 다른 사용자와는 완전히 분리된다)
 *
 * pi 원본 이벤트를 그대로 흘리지 않는다:
 *   - thinking 채널 delta는 전송하지 않고, 본문의 사고 독백도 걸러낸다 (CotStreamFilter)
 *   - 페이로드를 UI가 쓰는 형태(StreamMessage)로만 축소한다
 */
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { AlphaFolioRuntime } from "@alphafolio/agent";
import type { ClientMessage, StreamMessage } from "@alphafolio/protocol";
import { verifyToken } from "./auth.ts";
import type { RuntimeManager } from "./runtimes.ts";
import { serializeMessages } from "./serialize.ts";
import { CotStreamFilter } from "./thinkingText.ts";
import { hasUser, type UserDirectory } from "./users.ts";

const AUTH_TIMEOUT_MS = 5000;

interface WsDeps {
	secret: string;
	users: UserDirectory;
	runtimes: RuntimeManager;
	/** 호출 시점 판정 — 앱에서 키를 넣으면 재시작 없이 true 가 된다 */
	ledgerEnabled: () => boolean;
}

/** 사용자 단위 팬아웃 — 런타임 구독은 사용자당 하나만 건다. */
interface UserChannel {
	clients: Set<WebSocket>;
	unsubscribe: () => void;
	cot: CotStreamFilter;
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

export function attachWebSocket(server: Server, deps: WsDeps): void {
	const wss = new WebSocketServer({ noServer: true });
	const channels = new Map<string, UserChannel>();

	function channelFor(user: string, runtime: AlphaFolioRuntime): UserChannel {
		const existing = channels.get(user);
		if (existing) return existing;

		const channel: UserChannel = {
			clients: new Set(),
			cot: new CotStreamFilter(),
			unsubscribe: () => {},
		};

		const broadcast = (msg: StreamMessage): void => {
			const payload = JSON.stringify(msg);
			for (const ws of channel.clients) {
				if (ws.readyState === ws.OPEN) ws.send(payload);
			}
		};

		channel.unsubscribe = runtime.subscribe((raw) => {
			const e = raw as PiEvent;
			switch (e.type) {
				case "agent_start":
					channel.cot.reset();
					broadcast({ type: "agent_start" });
					return;
				case "message_update": {
					const inner = e.assistantMessageEvent;
					if (inner?.type !== "text_delta" || !inner.delta) return; // thinking 채널 비전송
					const clean = channel.cot.push(inner.delta);
					if (clean) broadcast({ type: "text_delta", delta: clean });
					return;
				}
				case "message_end": {
					const tail = channel.cot.flush();
					if (tail) broadcast({ type: "text_delta", delta: tail });
					broadcast({ type: "message_end", messages: serializeMessages(runtime.messages) });
					return;
				}
				case "tool_execution_start":
					broadcast({ type: "tool_start", id: e.toolCallId ?? "", name: e.toolName ?? "unknown", args: e.args });
					return;
				case "tool_execution_end":
					broadcast({
						type: "tool_end",
						id: e.toolCallId ?? "",
						name: e.toolName ?? "unknown",
						isError: e.isError === true,
					});
					return;
				case "agent_end":
					broadcast({ type: "agent_end" });
					broadcast({ type: "message_end", messages: serializeMessages(runtime.messages) });
					return;
				default:
					return;
			}
		});

		channels.set(user, channel);
		return channel;
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
		let user: string | null = null;

		const send = (msg: StreamMessage): void => {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
		};

		const timer = setTimeout(() => {
			if (!user) {
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

			if (!user) {
				if (msg.type !== "auth") {
					send({ type: "error", message: "인증이 필요합니다" });
					ws.close(4401, "unauthorized");
					return;
				}
				const name = verifyToken(msg.token, deps.secret);
				// 토큰이 유효해도 계정이 삭제됐을 수 있으므로 현재 목록과 대조한다
				if (!name || !hasUser(deps.users, name)) {
					send({ type: "error", message: "인증 실패" });
					ws.close(4401, "unauthorized");
					return;
				}

				user = name;
				clearTimeout(timer);

				void (async () => {
					try {
						const runtime = await deps.runtimes.get(name);
						const channel = channelFor(name, runtime);
						channel.clients.add(ws);
						deps.runtimes.acquire(name);

						send({
							type: "ready",
							sessionId: runtime.sessionId,
							model: runtime.modelLabel,
							ledgerEnabled: deps.ledgerEnabled(),
							isStreaming: runtime.isStreaming,
							messages: serializeMessages(runtime.messages),
						});
					} catch (err) {
						send({ type: "error", message: err instanceof Error ? err.message : String(err) });
						ws.close(1011, "runtime error");
					}
				})();
				return;
			}

			void handleCommand(send, msg, user, deps);
		});

		ws.on("close", () => {
			clearTimeout(timer);
			if (!user) return;

			const channel = channels.get(user);
			if (channel) {
				channel.clients.delete(ws);
				// 마지막 클라이언트가 나가면 구독을 끊는다 (런타임 자체는 유휴 정리에 맡긴다)
				if (channel.clients.size === 0) {
					channel.unsubscribe();
					channels.delete(user);
				}
			}
			deps.runtimes.release(user);
		});
	});
}

async function handleCommand(
	send: (msg: StreamMessage) => void,
	msg: ClientMessage,
	user: string,
	deps: WsDeps,
): Promise<void> {
	try {
		const runtime = await deps.runtimes.get(user);
		deps.runtimes.touch(user);

		switch (msg.type) {
			case "prompt":
				if (!msg.text.trim()) return;
				// 클라이언트의 streaming 상태는 믿지 않는다 — 같은 사용자의 다른 탭·기기에서
				// 이미 대화가 진행 중일 수 있다. 진행 중이면 거부 대신 큐에 넣는다.
				if (runtime.isStreaming) await runtime.followUp(msg.text);
				else await runtime.prompt(msg.text);
				return;
			case "steer":
				if (!msg.text.trim()) return;
				await runtime.steer(msg.text);
				return;
			case "abort":
				await runtime.abort();
				return;
			case "new_session":
				await runtime.newSession();
				send({
					type: "ready",
					sessionId: runtime.sessionId,
					model: runtime.modelLabel,
					ledgerEnabled: deps.ledgerEnabled(),
					isStreaming: false,
					messages: [],
				});
				return;
			case "ping":
				send({ type: "pong" });
				return;
			default:
				send({ type: "error", message: "알 수 없는 명령" });
		}
	} catch (err) {
		send({ type: "error", message: err instanceof Error ? err.message : String(err) });
	}
}
