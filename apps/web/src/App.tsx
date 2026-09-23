import type { ConversationListItem } from "@alphafolio/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ComponentType, type TouchEvent } from "react";
import { api } from "./lib/api.ts";
import { clearToken, getToken, isNativeApp } from "./lib/auth.ts";
import { useChat, type ChatState } from "./lib/chat.ts";
import { navigate, parseRoute, type View } from "./lib/route.ts";
import { isUnread, lastSession, markSeen } from "./lib/seen.ts";
import { ChatPage } from "./components/ChatPage.tsx";
import { LedgerPage } from "./components/LedgerPage.tsx";
import { PortfolioPage } from "./components/PortfolioPage.tsx";
import { LoginPage } from "./components/LoginPage.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import {
	ChatIcon,
	LogOutIcon,
	MenuIcon,
	PlusIcon,
	SettingsIcon,
	TrendingIcon,
	WalletIcon,
	XIcon,
} from "./components/icons.tsx";

const NAV: Array<{ view: View; label: string; Icon: ComponentType<{ size?: number }> }> = [
	{ view: "chat", label: "챗", Icon: ChatIcon },
	{ view: "portfolio", label: "투자", Icon: TrendingIcon },
	{ view: "ledger", label: "가계부", Icon: WalletIcon },
	{ view: "settings", label: "설정", Icon: SettingsIcon },
];

const TITLE: Record<View, string> = { chat: "AlphaFolio", portfolio: "투자", ledger: "가계부", settings: "설정" };

export function App() {
	const [authed, setAuthed] = useState(() => Boolean(getToken()));
	if (!authed) return <LoginPage onSuccess={() => setAuthed(true)} />;
	return <Shell onLogout={() => setAuthed(false)} />;
}

/**
 * 로그인 후 셸 — 좌측 사이드바(데스크톱 고정 / 모바일 드로어) + 본문.
 *
 * 채팅 상태는 여기서 들고 있는다. 사이드바에서 대화를 옮겨야 하고,
 * 다른 화면에 다녀와도 WebSocket 연결·스트리밍이 끊기지 않게 하기 위해서다.
 *
 * 주소가 곧 상태다 (PLAN §24) — /c/<대화 id> 로 새로고침·북마크하면 그 대화로 돌아온다.
 * 대화는 서버에서 돌기 때문에 다른 대화로 옮기거나 앱을 꺼도 응답은 끝까지 만들어진다.
 */
function Shell({ onLogout }: { onLogout: () => void }) {
	const qc = useQueryClient();
	const [initial] = useState(() => {
		const r = parseRoute(location.pathname);
		// iOS 앱은 다시 켜면 "/" 에서 시작한다 — 보던 대화로 돌려놓는다 (웹의 "/" 는 새 대화 그대로)
		if (isNativeApp && r.view === "chat" && !r.sessionId) return { ...r, sessionId: lastSession.get() };
		return r;
	});
	const chat = useChat({
		initialSessionId: initial.view === "chat" ? initial.sessionId : null,
		onActivity: () => void qc.invalidateQueries({ queryKey: ["sessions"] }),
		onMissing: () => {
			lastSession.set(null);
			if (parseRoute(location.pathname).view === "chat") navigate({ view: "chat", sessionId: null }, { replace: true });
		},
	});
	const [view, setView] = useState<View>(initial.view);
	const [drawer, setDrawer] = useState(false);
	const swipe = useDrawerSwipe(drawer, setDrawer);

	// 드로어가 열린 채로 데스크톱 폭이 되면 닫는다 (오버레이가 남지 않게)
	useEffect(() => {
		const mq = window.matchMedia("(min-width: 768px)");
		const onChange = (): void => {
			if (mq.matches) setDrawer(false);
		};
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	// 대화가 저장되면(첫 메시지 이후) 주소에 대화 id 를 싣는다. 빈 새 대화는 "/" 로 둔다 —
	// 저장 전 id 는 서버가 재시작하면 없어지므로 주소로 남기지 않는다.
	const hasMessages = chat.messages.length > 0;
	useEffect(() => {
		if (view !== "chat" || !chat.sessionId || !hasMessages) return;
		navigate({ view: "chat", sessionId: chat.sessionId }, { replace: location.pathname === "/" });
		lastSession.set(chat.sessionId);
	}, [view, chat.sessionId, hasMessages]);

	// 뒤로·앞으로 가기
	useEffect(() => {
		const onPop = (): void => {
			const r = parseRoute(location.pathname);
			setView(r.view);
			if (r.view === "chat" && (r.sessionId ?? null) !== chat.sessionId) chat.open(r.sessionId);
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, [chat]);

	function go(v: View): void {
		setView(v);
		setDrawer(false);
		// 챗으로 돌아올 때는 보던 대화 주소로
		navigate({ view: v, sessionId: v === "chat" && hasMessages ? chat.sessionId : null });
	}

	/** 응답 중이어도 새 대화를 열 수 있다 — 이전 대화는 서버에서 계속 돈다 */
	function newChat(): void {
		chat.newSession();
		setView("chat");
		setDrawer(false);
		navigate({ view: "chat", sessionId: null });
	}

	function openConversation(id: string): void {
		chat.open(id);
		setView("chat");
		setDrawer(false);
		navigate({ view: "chat", sessionId: id });
	}

	const sidebar = (
		<Sidebar
			view={view}
			chat={chat}
			onNavigate={go}
			onNewChat={newChat}
			onOpenConversation={openConversation}
			onClose={() => setDrawer(false)}
			onLogout={() => {
				clearToken();
				onLogout();
			}}
		/>
	);

	return (
		<div
			className="flex min-h-0 flex-1 bg-canvas pr-[env(safe-area-inset-right)]"
			onTouchStart={swipe.onTouchStart}
			onTouchMove={swipe.onTouchMove}
			onTouchEnd={swipe.onTouchEnd}
			onTouchCancel={swipe.onTouchEnd}
		>
			{/* 데스크톱 고정 사이드바 */}
			<aside className="hidden w-64 shrink-0 border-r border-line bg-sidebar pl-[env(safe-area-inset-left)] md:flex">
				{sidebar}
			</aside>

			{/* 모바일 드로어 */}
			<div
				className={`fixed inset-0 z-40 md:hidden ${drawer || swipe.dragging ? "" : "pointer-events-none"}`}
				aria-hidden={!drawer}
			>
				<div
					onClick={() => setDrawer(false)}
					style={swipe.dragging ? { opacity: swipe.progress, transition: "none" } : undefined}
					className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${drawer ? "opacity-100" : "opacity-0"}`}
				/>
				<aside
					ref={swipe.drawerRef}
					style={swipe.dragging ? { translate: `${swipe.offset}px 0`, transition: "none" } : undefined}
					className={`absolute inset-y-0 left-0 flex w-72 max-w-[85%] bg-sidebar pl-[env(safe-area-inset-left)] shadow-xl transition-transform duration-200 ease-out ${
						drawer ? "translate-x-0" : "-translate-x-full"
					}`}
				>
					{sidebar}
				</aside>
			</div>

			<main className="flex min-w-0 flex-1 flex-col pl-[env(safe-area-inset-left)] md:pl-0">
				<header className="box-content flex h-12 shrink-0 items-center gap-1 px-1.5 pt-[env(safe-area-inset-top)] md:px-4">
					<button
						onClick={() => setDrawer(true)}
						className="flex size-11 items-center justify-center rounded-xl text-muted transition hover:bg-hover active:bg-selected md:hidden"
						aria-label="메뉴 열기"
					>
						<MenuIcon />
					</button>
					<div className="flex min-w-0 flex-1 items-center gap-2 px-1">
						<span className="truncate text-sm font-medium text-ink">{TITLE[view]}</span>
						{view === "chat" && chat.model && (
							<span className="hidden truncate rounded-md bg-inset px-2 py-0.5 text-xs text-muted sm:inline">
								{chat.model}
							</span>
						)}
					</div>
					{view === "chat" && (
						<button
							onClick={newChat}
							className="flex size-11 items-center justify-center rounded-xl text-muted transition hover:bg-hover active:bg-selected disabled:opacity-40 md:hidden"
							aria-label="새 대화"
						>
							<PlusIcon />
						</button>
					)}
				</header>

				{view === "chat" ? (
					<ChatPage chat={chat} />
				) : view === "ledger" ? (
					<LedgerPage />
				) : view === "portfolio" ? (
					<PortfolioPage />
				) : (
					<SettingsPage />
				)}
			</main>
		</div>
	);
}

interface SidebarProps {
	view: View;
	chat: ChatState;
	onNavigate: (v: View) => void;
	onNewChat: () => void;
	onOpenConversation: (id: string) => void;
	onClose: () => void;
	onLogout: () => void;
}

function Sidebar({ view, chat, onNavigate, onNewChat, onOpenConversation, onClose, onLogout }: SidebarProps) {
	return (
		<div className="flex w-full flex-col px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]">
			<div className="flex items-center justify-between px-1 pb-3">
				{/* 로고 = 홈 — 챗 화면으로 돌아간다 (대화는 그대로, 새 대화는 아래 버튼) */}
				<button
					onClick={() => onNavigate("chat")}
					className="-mx-1.5 flex items-center gap-2 rounded-lg px-1.5 py-1 transition hover:bg-hover active:bg-selected"
					aria-label="홈(챗)으로"
				>
					<div className="flex size-7 items-center justify-center rounded-lg bg-accent text-sm font-semibold text-accent-ink">
						α
					</div>
					<span className="text-sm font-semibold text-ink">AlphaFolio</span>
				</button>
				<button
					onClick={onClose}
					className="flex size-10 items-center justify-center rounded-xl text-muted transition hover:bg-hover active:bg-selected md:hidden"
					aria-label="메뉴 닫기"
				>
					<XIcon size={16} />
				</button>
			</div>

			<button
				onClick={onNewChat}
				className="mb-3 flex items-center gap-2 rounded-xl border border-line bg-card px-3 py-2.5 text-sm text-ink shadow-sm transition hover:bg-hover active:scale-[0.99] active:bg-hover disabled:opacity-50 md:py-2"
			>
				<PlusIcon size={16} />
				새 대화
			</button>

			<nav className="flex flex-col gap-0.5">
				{NAV.map(({ view: v, label, Icon }) => (
					<button
						key={v}
						onClick={() => onNavigate(v)}
						className={`flex items-center gap-2.5 rounded-lg px-3 py-3 text-[15px] transition md:py-2 md:text-sm ${
							view === v
								? "bg-selected font-medium text-ink"
								: "text-muted hover:bg-hover hover:text-ink active:bg-selected"
						}`}
					>
						<Icon size={16} />
						{label}
					</button>
				))}
			</nav>

			<ConversationList
				current={view === "chat" ? chat.sessionId : null}
				onOpen={onOpenConversation}
			/>

			<div className="mt-auto space-y-1 border-t border-line pt-3">
				<div className="flex items-center gap-2 px-3 py-1 text-xs text-faint">
					<span className={`size-1.5 rounded-full ${chat.connected ? "bg-success" : "bg-faint animate-pulse"}`} />
					<span className="truncate">{chat.connected ? chat.model || "연결됨" : "연결 중…"}</span>
				</div>
				<button
					onClick={onLogout}
					className="flex w-full items-center gap-2.5 rounded-lg px-3 py-3 text-[15px] text-muted transition hover:bg-hover hover:text-ink active:bg-selected md:py-2 md:text-sm"
				>
					<LogOutIcon size={16} />
					로그아웃
				</button>
			</div>
		</div>
	);
}

/**
 * 최근 대화 — 응답 중(서버에서 도는 중) 표시와, 안 본 사이 끝난 답 표시.
 * 목록은 대화 활동(activity)·화면 복귀 때 다시 읽는다.
 */
function ConversationList({ current, onOpen }: { current: string | null; onOpen: (id: string) => void }) {
	const list = useQuery({ queryKey: ["sessions"], queryFn: api.sessions, refetchOnWindowFocus: true });
	const items = list.data ?? [];

	// 보고 있는 대화는 본 것으로 기록한다. 응답 중에도 기록한다 — 그 시점 이후에 끝난 답은
	// 수정 시각이 더 뒤라서, 답을 기다리다 앱을 끄면 다음에 켰을 때 점으로 보인다.
	useEffect(() => {
		const here = items.find((i) => i.id === current);
		if (here && document.visibilityState === "visible") markSeen(here.id, here.modified);
	}, [items, current]);

	if (items.length === 0) return <div className="flex-1" />;

	return (
		<div className="-mx-1 mt-4 min-h-0 flex-1 overflow-y-auto px-1">
			<div className="px-3 pb-1 text-xs text-faint">대화</div>
			<div className="flex flex-col gap-0.5">
				{items.slice(0, 50).map((c) => (
					<ConversationRow key={c.id} item={c} active={c.id === current} onOpen={onOpen} />
				))}
			</div>
		</div>
	);
}

function ConversationRow({ item, active, onOpen }: { item: ConversationListItem; active: boolean; onOpen: (id: string) => void }) {
	const unread = !active && !item.streaming && isUnread(item.id, item.modified);
	return (
		<button
			onClick={() => onOpen(item.id)}
			className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition md:py-1.5 ${
				active ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink active:bg-selected"
			}`}
		>
			<span className={`min-w-0 flex-1 truncate ${unread ? "font-medium text-ink" : ""}`}>{item.title}</span>
			{item.streaming ? (
				<span className="size-2 shrink-0 animate-pulse rounded-full bg-accent" aria-label="응답 중" title="응답 중" />
			) : unread ? (
				<span className="size-2 shrink-0 rounded-full bg-accent" aria-label="새 답" title="새 답" />
			) : null}
		</button>
	);
}

/** 왼쪽 가장자리에서 이 폭(px) 안에서 시작한 가로 스와이프만 드로어 열기로 본다 */
const EDGE_PX = 24;
/** 가로/세로 판정 전 움직임 허용치 */
const SLOP_PX = 8;

/**
 * 모바일 드로어 스와이프 — 가장자리에서 밀어 열고, 열린 드로어를 왼쪽으로 밀어 닫는다.
 * 손가락을 따라 움직이고, 폭의 30% 이상 끌었으면 확정한다.
 */
function useDrawerSwipe(open: boolean, setOpen: (v: boolean) => void) {
	const drawerRef = useRef<HTMLElement>(null);
	const start = useRef<{ x: number; y: number; axis: "x" | "y" | null; from: "open" | "closed" } | null>(null);
	const [drag, setDrag] = useState<{ dx: number; from: "open" | "closed" } | null>(null);
	const lastDx = useRef(0);

	const width = (): number => drawerRef.current?.offsetWidth || 288;
	const isDesktop = (): boolean => window.matchMedia("(min-width: 768px)").matches;

	function onTouchStart(e: TouchEvent): void {
		const t = e.touches[0];
		if (!t || e.touches.length > 1 || isDesktop()) return;
		if (open) start.current = { x: t.clientX, y: t.clientY, axis: null, from: "open" };
		else if (t.clientX < EDGE_PX) start.current = { x: t.clientX, y: t.clientY, axis: null, from: "closed" };
	}

	function onTouchMove(e: TouchEvent): void {
		const s = start.current;
		const t = e.touches[0];
		if (!s || !t) return;
		const mx = t.clientX - s.x;
		const my = t.clientY - s.y;
		if (s.axis === null) {
			if (Math.abs(mx) < SLOP_PX && Math.abs(my) < SLOP_PX) return;
			s.axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
			if (s.axis === "y") {
				start.current = null; // 세로 스크롤은 건드리지 않는다
				return;
			}
		}
		lastDx.current = mx;
		setDrag({ dx: mx, from: s.from });
	}

	function onTouchEnd(): void {
		const s = start.current;
		start.current = null;
		if (s?.axis === "x") {
			const threshold = width() * 0.3;
			if (s.from === "closed" && lastDx.current > threshold) setOpen(true);
			if (s.from === "open" && lastDx.current < -threshold) setOpen(false);
		}
		lastDx.current = 0;
		setDrag(null);
	}

	const w = width();
	const offset = !drag
		? 0
		: drag.from === "open"
			? Math.min(0, Math.max(-w, drag.dx))
			: -w + Math.min(w, Math.max(0, drag.dx));

	return {
		drawerRef,
		dragging: drag !== null,
		offset,
		progress: (offset + w) / w,
		onTouchStart,
		onTouchMove,
		onTouchEnd,
	};
}
