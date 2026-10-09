import type { ConversationListItem, MeDto, StreamMessage } from "@alphafolio/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type TouchEvent } from "react";
import { api } from "./lib/api.ts";
import { clearToken, getToken, isNativeApp } from "./lib/auth.ts";
import { useChat, type ChatState } from "./lib/chat.ts";
import { navigate, parseRoute, type View } from "./lib/route.ts";
import { forgetSeen, isUnread, lastSession, markSeen } from "./lib/seen.ts";
import { isDarkNow, onThemeApplied, setThemeMode } from "./lib/theme.ts";
import { toast } from "./lib/toast.ts";
import { applyUpdate, reportServerVersion } from "./lib/update.ts";
import { ChatPage } from "./components/ChatPage.tsx";
import { JournalPage } from "./components/JournalPage.tsx";
import { LedgerPage } from "./components/LedgerPage.tsx";
import { PortfolioPage } from "./components/PortfolioPage.tsx";
import { LoginPage } from "./components/LoginPage.tsx";
import { Logo } from "./components/Logo.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { ToastHost } from "./components/Toasts.tsx";
import {
	BellIcon,
	ChatIcon,
	JournalIcon,
	LogOutIcon,
	MoonIcon,
	PlusIcon,
	SettingsIcon,
	SunIcon,
	TrashIcon,
	TrendingIcon,
	WalletIcon,
	XIcon,
} from "./components/icons.tsx";

const NAV: Array<{ view: View; label: string; Icon: ComponentType<{ size?: number }> }> = [
	{ view: "chat", label: "챗", Icon: ChatIcon },
	{ view: "portfolio", label: "투자", Icon: TrendingIcon },
	{ view: "journal", label: "일지", Icon: JournalIcon },
	{ view: "ledger", label: "가계부", Icon: WalletIcon },
	{ view: "settings", label: "설정", Icon: SettingsIcon },
];

/** 단축키 표시 — 맥은 ⌘, 그 밖은 Ctrl */
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl ";

export function App() {
	const [authed, setAuthed] = useState(() => Boolean(getToken()));
	if (!authed) return <LoginPage onSuccess={() => setAuthed(true)} />;
	return <Shell onLogout={() => setAuthed(false)} />;
}

/**
 * 로그인 후 셸 — 데스크톱은 왼쪽 사이드바, 모바일은 하단 탭바 + (챗에서) 대화 목록 드로어.
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
		onWatchEvent: (ev) => {
			void qc.invalidateQueries({ queryKey: ["watch"] });
			// 상태 변경(일시정지 등)은 목록만 갱신 — 발동·만료·비상 정지만 띄운다
			if (["fired", "missed", "expired", "stopped", "ordered", "skipped"].includes(ev.kind)) setWatchToast(ev);
		},
		onMissing: () => {
			lastSession.set(null);
			if (parseRoute(location.pathname).view === "chat") navigate({ view: "chat", sessionId: null }, { replace: true });
		},
	});
	const [view, setView] = useState<View>(initial.view);
	const [watchToast, setWatchToast] = useState<WatchToastEvent | null>(null);
	/** 이미 설정 화면일 때 감시 탭으로 옮기려면 다시 그려야 한다 (탭은 처음 그릴 때 주소에서 읽는다) */
	const [settingsKey, setSettingsKey] = useState(0);
	const [drawer, setDrawer] = useState(false);
	// 대화 드로어는 챗 화면 전용 — 다른 화면의 가장자리 스와이프는 그대로 둔다
	const swipe = useDrawerSwipe(drawer, setDrawer, view === "chat");
	const me = useQuery({ queryKey: ["me"], queryFn: api.me });

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

	// ⌘1~5 화면 이동, Esc 드로어 닫기 — 핸들러는 최신 go 를 본다
	const goRef = useRef(go);
	goRef.current = go;
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") setDrawer(false);
			if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
			const i = ["1", "2", "3", "4", "5"].indexOf(e.key);
			if (i < 0) return;
			e.preventDefault();
			goRef.current(NAV[i]!.view);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	function logout(): void {
		void clearToken();
		onLogout();
	}

	const page =
		view === "chat" ? (
			<ChatPage chat={chat} onOpenDrawer={() => setDrawer(true)} onNewChat={newChat} />
		) : view === "ledger" ? (
			<LedgerPage />
		) : view === "portfolio" ? (
			<PortfolioPage onAskChat={newChat} />
		) : view === "journal" ? (
			<JournalPage onOpenConversation={openConversation} />
		) : (
			<SettingsPage key={settingsKey} onOpenConversation={openConversation} />
		);

	const drawerOpen = drawer || swipe.dragging;

	return (
		<div
			className="app"
			onTouchStart={swipe.onTouchStart}
			onTouchMove={swipe.onTouchMove}
			onTouchEnd={swipe.onTouchEnd}
			onTouchCancel={swipe.onTouchEnd}
		>
			<aside className="sidebar">
				<Sidebar
					view={view}
					chat={chat}
					me={me.data}
					onNavigate={go}
					onNewChat={newChat}
					onOpenConversation={openConversation}
					onLogout={logout}
				/>
			</aside>

			<main className="main">{page}</main>

			{/* 모바일 하단 탭바 */}
			<nav className="tabbar" aria-label="주요 화면">
				{NAV.map(({ view: v, label, Icon }) => (
					<button key={v} onClick={() => go(v)} aria-current={view === v ? "page" : undefined}>
						<Icon size={21} />
						{label}
					</button>
				))}
			</nav>

			{/* 모바일 대화 드로어 — 화면 이동은 탭바가 맡는다 */}
			<div className={`drawer ${drawer ? "open" : ""} ${swipe.dragging ? "dragging" : ""}`} inert={!drawerOpen}>
				<div
					className="scrim"
					onClick={() => setDrawer(false)}
					style={swipe.dragging ? { opacity: swipe.progress, transition: "none" } : undefined}
				/>
				<div
					ref={swipe.drawerRef}
					className="panel"
					role="dialog"
					aria-label="대화 목록"
					style={swipe.dragging ? { transform: `translateX(${swipe.offset}px)`, transition: "none" } : undefined}
				>
					<div className="panel-h">
						<strong>대화</strong>
						<button className="icon-btn" onClick={() => setDrawer(false)} aria-label="닫기">
							<XIcon size={18} />
						</button>
					</div>
					<button className="btn btn-secondary side-new" onClick={newChat}>
						<PlusIcon size={16} />새 대화
					</button>
					<ConversationList current={view === "chat" ? chat.sessionId : null} onOpen={openConversation} />
				</div>
			</div>

			<ToastHost
				extra={
					watchToast && (
						<WatchToast
							ev={watchToast}
							onClose={() => setWatchToast(null)}
							onOpen={() => {
								setWatchToast(null);
								const conv = watchToast.path?.match(/^\/c\/(.+)$/)?.[1];
								if (conv) return openConversation(decodeURIComponent(conv));
								history.pushState(null, "", "/settings/watch");
								setView("settings");
								setSettingsKey((k) => k + 1);
							}}
						/>
					)
				}
			/>
		</div>
	);
}

type WatchToastEvent = Extract<StreamMessage, { type: "watch_event" }>;

/** 감시 발동 알림 — 12초 뒤 사라진다. 누르면 만든 대화(또는 설정 → 감시) */
function WatchToast({ ev, onClose, onOpen }: { ev: WatchToastEvent; onClose: () => void; onOpen: () => void }) {
	useEffect(() => {
		const id = setTimeout(onClose, 12_000);
		return () => clearTimeout(id);
	}, [ev, onClose]);
	return (
		<div className="toast" role="status">
			<BellIcon size={18} />
			<button className="t" onClick={onOpen}>
				{ev.title}
				{ev.lines.map((l) => (
					<small key={l}>{l}</small>
				))}
			</button>
			<button onClick={onClose} aria-label="닫기">
				<XIcon size={16} />
			</button>
		</div>
	);
}

interface SidebarProps {
	view: View;
	chat: ChatState;
	me: MeDto | undefined;
	onNavigate: (v: View) => void;
	onNewChat: () => void;
	onOpenConversation: (id: string) => void;
	onLogout: () => void;
}

function Sidebar({ view, chat, me, onNavigate, onNewChat, onOpenConversation, onLogout }: SidebarProps) {
	const dark = useSyncExternalStore(onThemeApplied, isDarkNow);
	return (
		<>
			<div className="side-head">
				{/* 로고 = 홈 — 챗 화면으로 돌아간다 (대화는 그대로, 새 대화는 아래 버튼) */}
				<button className="brand" onClick={() => onNavigate("chat")} aria-label="홈(챗)으로">
					<Logo />
					AlphaFolio
				</button>
			</div>
			<button className="btn btn-secondary side-new" onClick={onNewChat}>
				<PlusIcon size={16} />새 대화
			</button>

			<nav className="nav" aria-label="주요 화면">
				{NAV.map(({ view: v, label, Icon }, i) => (
					<button key={v} className="nav-item" onClick={() => onNavigate(v)} aria-current={view === v ? "page" : undefined}>
						<Icon />
						{label}
						<kbd>
							{MOD}
							{i + 1}
						</kbd>
					</button>
				))}
			</nav>

			<div className="side-label">최근 대화</div>
			<ConversationList current={view === "chat" ? chat.sessionId : null} onOpen={onOpenConversation} />

			<div className="side-foot">
				<StatusLine connected={chat.connected} model={chat.model} />
				<div className="me">
					<span className="avatar">{(me?.user ?? "").slice(0, 2).toUpperCase()}</span>
					<span className="who">
						{me?.user ?? ""}
						<small>{me ? (me.admin ? "관리자" : "사용자") : ""}</small>
					</span>
					<button
						className="icon-btn"
						onClick={() => setThemeMode(dark ? "light" : "dark")}
						aria-label="테마 전환"
						title={dark ? "라이트로" : "다크로"}
					>
						{dark ? <SunIcon size={17} /> : <MoonIcon size={17} />}
					</button>
					<button className="icon-btn" onClick={onLogout} aria-label="로그아웃" title="로그아웃">
						<LogOutIcon size={17} />
					</button>
				</div>
			</div>
		</>
	);
}

/**
 * 연결 상태 · 모델 · 이 화면(번들)의 버전. 서버 버전이 다르면 새로고침 안내.
 * 배포 직후 서비스워커가 옛 번들을 주면 새 카드가 안 보인다 (PLAN §39) — 여기서 바로 드러난다.
 * 서버 버전은 소켓이 다시 붙을 때(= 배포로 서버가 재시작) 다시 읽는다. 상단 배너도 이 버전을 본다 (lib/update.ts).
 */
function StatusLine({ connected, model }: { connected: boolean; model: string }) {
	const health = useQuery({ queryKey: ["health", connected], queryFn: api.health, staleTime: Infinity, retry: false });
	const server = health.data?.version;
	useEffect(() => reportServerVersion(server), [server]);
	const stale = !!server && server !== "unknown" && server !== __APP_VERSION__;
	return (
		<div className="status-line">
			<span className={`led ${connected ? "" : "off"}`} />
			<span className="t" title={model || undefined}>
				{connected ? modelName(model) || "연결됨" : "연결 중…"}
			</span>
			{stale ? (
				<button className="ver stale" onClick={() => void applyUpdate()} title="서버가 새 버전입니다. 새로고침하면 새 화면을 받습니다.">
					v{server} 받기
				</button>
			) : (
				<span className="ver">v{__APP_VERSION__}</span>
			)}
		</div>
	);
}

/** "openrouter/deepseek/deepseek-v4.1-flash" → "deepseek-v4.1-flash" — 제공자·경로는 빼고 모델명만 (전체는 title 로) */
function modelName(label: string): string {
	return label.split("/").pop() ?? label;
}

const DAY = 86_400_000;

/** 대화 묶음 — 마지막으로 바뀐 날 기준 (기기 현지 시각) */
function groupOf(iso: string, now = new Date()): string {
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const t = Date.parse(iso);
	if (t >= today) return "오늘";
	if (t >= today - DAY) return "어제";
	if (t >= today - 6 * DAY) return "지난 7일";
	if (t >= today - 29 * DAY) return "지난 30일";
	return "이전";
}

/**
 * 최근 대화 — 응답 중(서버에서 도는 중) 표시와, 안 본 사이 끝난 답 표시.
 * 목록은 대화 활동(activity)·화면 복귀 때 다시 읽는다.
 */
function ConversationList({ current, onOpen }: { current: string | null; onOpen: (id: string) => void }) {
	const qc = useQueryClient();
	const list = useQuery({ queryKey: ["sessions"], queryFn: api.sessions, refetchOnWindowFocus: true });
	const items = list.data ?? [];
	const [deleting, setDeleting] = useState<string | null>(null);

	/**
	 * 삭제 — 되돌릴 수 없어 확인을 받는다. 보고 있던 대화면 서버가 이 소켓에 session_missing 을 보내
	 * 새 대화로 넘어간다 (다른 탭·기기도 같은 경로). 여기서는 목록과 로컬 기록만 정리한다.
	 */
	async function remove(item: ConversationListItem): Promise<void> {
		const warn = item.streaming ? "\n작성 중인 답도 멈춥니다." : "";
		if (!window.confirm(`"${item.title}"\n대화를 삭제할까요? 되돌릴 수 없습니다.${warn}`)) return;
		setDeleting(item.id);
		try {
			await api.deleteSession(item.id);
			forgetSeen(item.id);
			if (lastSession.get() === item.id) lastSession.set(null);
			qc.setQueryData<ConversationListItem[]>(["sessions"], (old) => old?.filter((c) => c.id !== item.id));
			toast("대화를 삭제했습니다");
		} catch (err) {
			toast(`삭제하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setDeleting(null);
			void qc.invalidateQueries({ queryKey: ["sessions"] });
		}
	}

	// 보고 있는 대화는 본 것으로 기록한다. 응답 중에도 기록한다 — 그 시점 이후에 끝난 답은
	// 수정 시각이 더 뒤라서, 답을 기다리다 앱을 끄면 다음에 켰을 때 점으로 보인다.
	useEffect(() => {
		const here = items.find((i) => i.id === current);
		if (here && document.visibilityState === "visible") markSeen(here.id, here.modified);
	}, [items, current]);

	const now = new Date();
	let last = "";
	return (
		<div className="convs thin-scroll">
			{items.slice(0, 50).map((c) => {
				const group = groupOf(c.modified, now);
				const head = group !== last ? <div className="conv-group">{group}</div> : null;
				last = group;
				return (
					<div key={c.id}>
						{head}
						<ConversationRow
							item={c}
							active={c.id === current}
							busy={deleting === c.id}
							onOpen={onOpen}
							onDelete={() => void remove(c)}
						/>
					</div>
				);
			})}
		</div>
	);
}

/**
 * 대화 한 줄 + 삭제 버튼.
 * 휴지통: 마우스가 있으면 올린 행에만, 터치 기기는 보고 있는 대화에만 (styles.css .conv-del).
 * 드로어는 왼쪽 스와이프로 닫혀서 스와이프 삭제는 쓰지 않는다.
 */
function ConversationRow({
	item,
	active,
	busy,
	onOpen,
	onDelete,
}: {
	item: ConversationListItem;
	active: boolean;
	busy: boolean;
	onOpen: (id: string) => void;
	onDelete: () => void;
}) {
	const unread = !active && !item.streaming && isUnread(item.id, item.modified);
	return (
		<div className={`conv ${unread ? "unread" : ""} ${busy ? "busy" : ""}`} aria-current={active ? "true" : undefined}>
			<button className="conv-open" onClick={() => onOpen(item.id)}>
				<span className="t">{item.title}</span>
				{item.streaming ? (
					<span className="dot live" role="img" aria-label="응답 중" title="응답 중" />
				) : unread ? (
					<span className="dot" role="img" aria-label="새 답" title="새 답" />
				) : null}
			</button>
			<button className="conv-del" onClick={onDelete} disabled={busy} aria-label={`"${item.title}" 삭제`} title="삭제">
				<TrashIcon size={15} />
			</button>
		</div>
	);
}

/** 왼쪽 가장자리에서 이 폭(px) 안에서 시작한 가로 스와이프만 드로어 열기로 본다 */
const EDGE_PX = 24;
/** 가로/세로 판정 전 움직임 허용치 */
const SLOP_PX = 8;

/**
 * 모바일 드로어 스와이프 — 가장자리에서 밀어 열고, 열린 드로어를 왼쪽으로 밀어 닫는다.
 * 손가락을 따라 움직이고, 폭의 30% 이상 끌었으면 확정한다. enabled=false 면 열기만 막는다.
 */
function useDrawerSwipe(open: boolean, setOpen: (v: boolean) => void, enabled: boolean) {
	const drawerRef = useRef<HTMLDivElement>(null);
	const start = useRef<{ x: number; y: number; axis: "x" | "y" | null; from: "open" | "closed" } | null>(null);
	const [drag, setDrag] = useState<{ dx: number; from: "open" | "closed" } | null>(null);
	const lastDx = useRef(0);

	const width = (): number => drawerRef.current?.offsetWidth || 310;
	const isDesktop = (): boolean => window.matchMedia("(min-width: 768px)").matches;

	function onTouchStart(e: TouchEvent): void {
		const t = e.touches[0];
		if (!t || e.touches.length > 1 || isDesktop()) return;
		if (open) start.current = { x: t.clientX, y: t.clientY, axis: null, from: "open" };
		else if (enabled && t.clientX < EDGE_PX) start.current = { x: t.clientX, y: t.clientY, axis: null, from: "closed" };
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
