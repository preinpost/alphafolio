import { useChat } from "../lib/chat.ts";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";

export function ChatPage() {
	const chat = useChat();

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{!chat.connected && (
				<div className="bg-inset px-4 py-1.5 text-center text-xs text-muted">연결 중…</div>
			)}
			{chat.error && (
				<div className="bg-inset px-4 py-1.5 text-center text-xs text-danger">{chat.error}</div>
			)}

			<MessageList
				messages={chat.messages}
				pending={chat.pending}
				streaming={chat.streaming}
				runningTools={chat.runningTools}
			/>

			<Composer
				onSend={chat.send}
				onAbort={chat.abort}
				streaming={chat.streaming}
				disabled={!chat.connected}
			/>
		</div>
	);
}
