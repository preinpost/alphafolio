import { useState } from "react";
import { clearToken, getToken } from "./lib/auth.ts";
import { ChatPage } from "./components/ChatPage.tsx";
import { LedgerPage } from "./components/LedgerPage.tsx";
import { PortfolioPage } from "./components/PortfolioPage.tsx";
import { LoginPage } from "./components/LoginPage.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";

type View = "chat" | "ledger" | "portfolio" | "settings";

export function App() {
	const [authed, setAuthed] = useState(() => Boolean(getToken()));
	const [view, setView] = useState<View>("chat");

	if (!authed) return <LoginPage onSuccess={() => setAuthed(true)} />;

	return (
		<div className="flex h-dvh flex-col bg-canvas">
			<header className="flex items-center justify-between border-b border-line px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
				<div className="flex items-center gap-2">
					<div className="flex size-7 items-center justify-center rounded-lg bg-accent text-sm font-semibold text-accent-ink">
						α
					</div>
					<span className="text-sm font-medium text-ink">AlphaFolio</span>
				</div>

				<nav className="flex gap-1 rounded-lg bg-inset p-0.5">
					{(["chat", "ledger", "portfolio", "settings"] as const).map((v) => (
						<button
							key={v}
							onClick={() => setView(v)}
							className={`rounded-md px-3 py-1 text-xs transition ${
								view === v ? "bg-card text-ink shadow-sm" : "text-muted"
							}`}
						>
							{v === "chat" ? "챗" : v === "ledger" ? "가계부" : v === "portfolio" ? "투자" : "설정"}
						</button>
					))}
				</nav>

				<button
					onClick={() => {
						clearToken();
						setAuthed(false);
					}}
					className="text-xs text-faint"
				>
					로그아웃
				</button>
			</header>

			{view === "chat" ? (
				<ChatPage />
			) : view === "ledger" ? (
				<LedgerPage />
			) : view === "portfolio" ? (
				<PortfolioPage />
			) : (
				<SettingsPage />
			)}
		</div>
	);
}
