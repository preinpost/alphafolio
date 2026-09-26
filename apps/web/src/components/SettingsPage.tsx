/**
 * 설정 — 탭으로 묶는다.
 *
 *   계정    내 계정 (비밀번호·모든 기기 로그아웃)
 *   연결    증권(KIS·토스)·뉴스 키 + 원격 MCP 서버 (TradingView 등)
 *   AI 모델 LLM 키 (비우면 서버 기본 계정)
 *   감시    봉 마감 감시 목록 — 일시정지·다시 켜기·삭제·비상 정지 (PLAN §40). 만들기는 챗에서
 *   화면    테마
 *   관리자  초대 코드·계정 관리·서버 DB 상태 — env 계정(슈퍼관리자)에게만 보인다
 *
 * 키는 전부 **사용자별**이다. 같은 서버를 써도 각자 자기 증권 계정을 쓴다.
 * 가계부 D1 접속 정보는 서버 env 전용이라 여기서 다루지 않는다
 * (DB가 있어야 앱이 도는데 그 설정을 앱에서 넣는 구조는 닭-달걀이 된다).
 *
 * 지금 탭은 주소에 싣는다 (/settings/connect) — 새로고침해도, "설정에서 키를 넣으세요" 링크로 와도 그 탭이 열린다.
 */
import { Tabs } from "@base-ui-components/react/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { api, type SecretStatus } from "../lib/api.ts";
import { getThemeMode, setThemeMode, type ThemeMode } from "../lib/theme.ts";
import { AdminPanel, MyAccount } from "./AccountSettings.tsx";
import { McpSettings } from "./McpSettings.tsx";
import { WatchSettings } from "./WatchSettings.tsx";

const SOURCE_LABEL: Record<string, string> = {
	user: "내 설정",
	env: "서버 env",
	none: "미설정",
};

const THEMES: Array<{ value: ThemeMode; label: string }> = [
	{ value: "light", label: "라이트" },
	{ value: "dark", label: "다크" },
	{ value: "system", label: "시스템" },
];

type Tab = "account" | "connect" | "watch" | "ai" | "display" | "admin";

const TABS: Array<{ value: Tab; label: string; admin?: boolean }> = [
	{ value: "account", label: "계정" },
	{ value: "connect", label: "연결" },
	{ value: "watch", label: "감시" },
	{ value: "ai", label: "AI 모델" },
	{ value: "display", label: "화면" },
	{ value: "admin", label: "관리자", admin: true },
];

/** 키 그룹 → 탭. 서버 카탈로그(secrets.ts)의 group 문자열을 따른다 */
const tabOfGroup = (group: string): Tab => (group === "LLM" ? "ai" : "connect");

function tabFromPath(): Tab {
	const t = location.pathname.split("/")[2];
	return TABS.some((x) => x.value === t) ? (t as Tab) : "account";
}

function Section({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
	return (
		<section>
			<h2 className="mb-2 text-sm font-medium text-muted">{title}</h2>
			<div className="space-y-2 rounded-xl border border-line p-3">{children}</div>
			{note && <p className="mt-2 text-xs text-faint">{note}</p>}
		</section>
	);
}

export function SettingsPage({ onOpenConversation }: { onOpenConversation?: (id: string) => void } = {}) {
	const qc = useQueryClient();
	const [tab, setTab] = useState<Tab>(tabFromPath);
	const [theme, setTheme] = useState<ThemeMode>(getThemeMode);
	const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);

	const secrets = useQuery({ queryKey: ["secrets"], queryFn: api.secrets });
	const me = useQuery({ queryKey: ["me"], queryFn: api.me });
	const isAdmin = me.data?.admin === true;

	const save = useMutation({
		mutationFn: ({ name, value }: { name: string; value: string }) => api.setSecret(name, value),
		onSuccess: () => void qc.invalidateQueries({ queryKey: ["secrets"] }),
	});
	const remove = useMutation({
		mutationFn: (name: string) => api.deleteSecret(name),
		onSuccess: () => void qc.invalidateQueries({ queryKey: ["secrets"] }),
	});
	const testD1 = useMutation({ mutationFn: api.testD1, onSuccess: setTest });

	const items = secrets.data?.items ?? [];
	const groups = [...new Set(items.map((i) => i.group))];
	const tabs = TABS.filter((t) => !t.admin || isAdmin);
	// 관리자가 아닌데 /settings/admin 으로 들어온 경우
	const current: Tab = tabs.some((t) => t.value === tab) ? tab : "account";

	function select(next: Tab): void {
		setTab(next);
		history.replaceState(null, "", next === "account" ? "/settings" : `/settings/${next}`);
	}

	const keyGroups = (which: Tab) =>
		groups
			.filter((g) => tabOfGroup(g) === which)
			.map((group) => (
				<Section key={group} title={group}>
					{items
						.filter((i) => i.group === group)
						.map((item) => (
							<SecretRow
								key={item.name}
								item={item}
								busy={save.isPending || remove.isPending}
								onSave={(value) => save.mutate({ name: item.name, value })}
								onDelete={() => remove.mutate(item.name)}
							/>
						))}
					{group === TELEGRAM_GROUP && <TelegramTest />}
				</Section>
			));

	// 키를 저장해도 재시작 뒤 못 읽는 상황 — 키를 넣는 탭에서 바로 보이게
	const storageWarnings = (
		<>
			{secrets.data && !secrets.data.storageReady && (
				<p className="rounded-xl border border-danger/40 bg-inset p-3 text-xs text-danger">
					키 저장소가 준비되지 않았습니다. 관리자에게 서버 DB 설정을 확인해 달라고 하세요.
				</p>
			)}
			{secrets.data?.ephemeralMaster && (
				<p className="rounded-xl border border-danger/40 bg-inset p-3 text-xs text-danger">
					AF_AUTH_SECRET 이 설정되지 않아 매 기동 새로 생성됩니다. 지금 저장한 키는 재시작 후 읽을 수 없습니다.
					서버 환경변수에 고정한 뒤 다시 입력하세요.
				</p>
			)}
			{(secrets.data?.undecryptable ?? 0) > 0 && (
				<p className="rounded-xl border border-danger/40 bg-inset p-3 text-xs text-danger">
					저장된 키 {secrets.data?.undecryptable}건을 복호화하지 못했습니다. AF_AUTH_SECRET 이 바뀌었을 수
					있습니다. 새 값을 저장하면 덮어씁니다.
				</p>
			)}
		</>
	);
	const keyNote = "키는 사용자별로 암호화되어 저장됩니다. 저장한 값은 화면으로 다시 내려오지 않으니, 바꾸려면 새 값을 입력하세요.";

	return (
		<Tabs.Root value={current} onValueChange={(v) => select(v as Tab)} className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 border-b border-line px-4">
				{/* 좁은 화면에서는 가로로 밀어 넘기되 스크롤바는 숨긴다. 세로는 막는다 (밑줄 때문에 1px 넘치면 세로 스크롤바가 생겼다) */}
				<Tabs.List
					className="mx-auto flex max-w-2xl gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					aria-label="설정 분류"
				>
					{tabs.map((t) => (
						<Tabs.Tab
							key={t.value}
							value={t.value}
							className="shrink-0 border-b-2 border-transparent px-3 py-2.5 text-sm text-muted transition hover:text-ink aria-selected:border-accent aria-selected:font-medium aria-selected:text-ink"
						>
							{t.label}
						</Tabs.Tab>
					))}
				</Tabs.List>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto max-w-2xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
					<Tabs.Panel value="account" className="space-y-6 outline-none">
						{me.data && <MyAccount me={me.data} />}
					</Tabs.Panel>

					<Tabs.Panel value="connect" className="space-y-6 outline-none">
						{storageWarnings}
						{keyGroups("connect")}
						<p className="text-xs text-faint">{keyNote}</p>
						<McpSettings />
					</Tabs.Panel>

					<Tabs.Panel value="watch" className="outline-none">
						<WatchSettings {...(onOpenConversation ? { onOpenConversation } : {})} />
					</Tabs.Panel>

					<Tabs.Panel value="ai" className="space-y-6 outline-none">
						{storageWarnings}
						{keyGroups("ai")}
						<p className="text-xs text-faint">
							비워두면 서버의 기본 계정으로 호출합니다. 넣으면 내 키로 과금되며, 서버를 다시 시작하지 않아도 바로
							적용됩니다. {keyNote}
						</p>
					</Tabs.Panel>

					<Tabs.Panel value="display" className="space-y-6 outline-none">
						<Section title="테마" note={theme === "system" ? "기기 설정이 바뀌면 자동으로 따라갑니다." : undefined}>
							<div className="flex gap-1 rounded-lg bg-inset p-0.5">
								{THEMES.map((t) => (
									<button
										key={t.value}
										onClick={() => {
											setTheme(t.value);
											setThemeMode(t.value);
										}}
										className={`flex-1 rounded-md px-3 py-1.5 text-xs transition ${
											theme === t.value ? "bg-card text-ink shadow-sm" : "text-muted"
										}`}
									>
										{t.label}
									</button>
								))}
							</div>
						</Section>
					</Tabs.Panel>

					{isAdmin && me.data && (
						<Tabs.Panel value="admin" className="space-y-6 outline-none">
							<AdminPanel me={me.data} />
							<Section
								title="서버 DB"
								note="가계부·계정·개인 키가 저장되는 곳입니다. 접속 정보는 서버 환경변수(AF_D1_*)에서만 바꿉니다."
							>
								<div className="flex items-center gap-2">
									<button
										onClick={() => testD1.mutate()}
										disabled={testD1.isPending}
										className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted disabled:opacity-50"
									>
										{testD1.isPending ? "확인 중…" : "연결 테스트"}
									</button>
									{test && <span className={`text-xs ${test.ok ? "text-success" : "text-danger"}`}>{test.message}</span>}
									{secrets.data && !secrets.data.storageReady && (
										<span className="text-xs text-danger">키 저장소가 준비되지 않았습니다</span>
									)}
								</div>
							</Section>
						</Tabs.Panel>
					)}
				</div>
			</div>
		</Tabs.Root>
	);
}

/** 서버 카탈로그(secrets.ts)의 그룹 이름 */
const TELEGRAM_GROUP = "알림 (텔레그램)";

/**
 * 텔레그램 연결 테스트 — 채팅 id 가 비어 있으면 서버가 봇에게 온 최근 개인 메시지에서 찾아 저장한다 (PLAN §40).
 * 그래서 사용자는 봇 토큰만 넣고, 봇에게 한 번 말을 건 뒤 이 버튼을 누르면 된다.
 */
function TelegramTest() {
	const qc = useQueryClient();
	const test = useMutation({
		mutationFn: api.testTelegram,
		onSuccess: (r) => {
			if (r.items) qc.setQueryData(["secrets"], (old: { items: SecretStatus[] } | undefined) => (old ? { ...old, items: r.items as SecretStatus[] } : old));
		},
	});
	return (
		<div className="space-y-1.5 border-t border-line pt-2">
			<p className="text-[11px] text-faint">
				① @BotFather 에서 /newbot 으로 봇을 만들어 토큰을 넣고 ② 텔레그램에서 그 봇에게 아무 메시지나 보낸 뒤 ③ 연결 테스트를 누르세요. 알림에는
				종목·수량·체결가만 담고 잔고·평가금액은 보내지 않습니다.
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<button
					onClick={() => test.mutate()}
					disabled={test.isPending}
					className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted disabled:opacity-50"
				>
					{test.isPending ? "확인 중…" : "연결 테스트"}
				</button>
				{test.data && <span className={`text-xs ${test.data.ok ? "text-success" : "text-danger"}`}>{test.data.message}</span>}
				{test.error && <span className="text-xs text-danger">{test.error.message}</span>}
			</div>
		</div>
	);
}

function SecretRow({
	item,
	busy,
	onSave,
	onDelete,
}: {
	item: SecretStatus;
	busy: boolean;
	onSave: (value: string) => void;
	onDelete: () => void;
}) {
	const [value, setValue] = useState("");

	// 좁은 화면에서는 라벨을 위, 입력·버튼을 아래 줄로 — 한 줄에 넣으면 입력칸이 몇 글자 폭으로 줄어든다
	return (
		<div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
			<div className="flex items-baseline justify-between gap-2 sm:block sm:w-40 sm:shrink-0">
				<div className="truncate text-sm text-ink">{item.label}</div>
				<div className="shrink-0 text-[11px] text-faint">
					{SOURCE_LABEL[item.source]}
					{item.preview ? ` · ${item.preview}` : ""}
				</div>
			</div>

			<div className="flex min-w-0 flex-1 items-center gap-2">
				<input
					type="password"
					value={value}
					placeholder={item.preview ? "새 값으로 교체" : (item.hint ?? "입력")}
					onChange={(e) => setValue(e.target.value)}
					className="min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
				/>

				<button
					onClick={() => {
						onSave(value);
						setValue("");
					}}
					disabled={busy || !value.trim()}
					className="shrink-0 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-ink disabled:opacity-40"
				>
					저장
				</button>

				{item.source === "user" && (
					<button onClick={onDelete} disabled={busy} className="shrink-0 text-xs text-faint">
						삭제
					</button>
				)}
			</div>
		</div>
	);
}
