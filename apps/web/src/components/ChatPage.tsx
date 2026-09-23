import type { ChatState } from "../lib/chat.ts";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";

export function ChatPage({ chat }: { chat: ChatState }) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
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
							<div className="mx-auto mb-2 w-full max-w-3xl rounded-xl border border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger">
								{chat.error}
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
		</div>
	);
}
