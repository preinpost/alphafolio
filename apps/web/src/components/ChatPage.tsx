import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { ChatState } from "../lib/chat.ts";
import { Composer } from "./Composer.tsx";
import { AlertIcon, EditIcon, MenuIcon } from "./icons.tsx";
import { MessageList } from "./MessageList.tsx";
import { Topbar } from "./Topbar.tsx";

export function ChatPage({ chat, onOpenDrawer, onNewChat }: { chat: ChatState; onOpenDrawer: () => void; onNewChat: () => void }) {
	// 제목은 사이드바 목록과 같은 캐시에서 — 저장 전(첫 답 전) 대화는 "새 대화"
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions, refetchOnWindowFocus: true });
	const title = sessions.data?.find((s) => s.id === chat.sessionId)?.title ?? "새 대화";
	const model = chat.model.split("/").pop() ?? chat.model;

	return (
		<>
			<Topbar
				title={title}
				sub={model ? <span className="mono" title={chat.model}>{model}</span> : undefined}
				leading={
					<button className="icon-btn mobile-only" onClick={onOpenDrawer} aria-label="대화 목록 열기" style={{ marginLeft: -8 }}>
						<MenuIcon size={20} />
					</button>
				}
			>
				<button className="icon-btn" onClick={onNewChat} aria-label="새 대화" title="새 대화">
					<EditIcon />
				</button>
			</Topbar>

			{/* 대화를 옮기면 스크롤 상태(바닥 고정·맨 아래로 버튼)를 새로 시작한다 */}
			<MessageList
				key={chat.sessionId ?? "opening"}
				messages={chat.messages}
				pending={chat.pending}
				streaming={chat.streaming}
				runningTools={chat.runningTools}
				onSuggest={chat.send}
				canSuggest={chat.connected}
				footer={
					<>
						{chat.error && (
							<div className="notice bad" role="alert" style={{ maxWidth: 760, margin: "0 auto 8px" }}>
								<AlertIcon size={16} />
								<span>{chat.error}</span>
							</div>
						)}
						<Composer
							onSend={chat.send}
							onAbort={chat.abort}
							streaming={chat.streaming}
							// 대화를 옮기는 중(ready 전)에는 보내지 않는다 — 어느 대화로 갈지 모호하다
							disabled={!chat.connected || !chat.sessionId}
						/>
					</>
				}
			/>
		</>
	);
}
