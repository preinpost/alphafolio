/**
 * 설정 — 탭으로 묶는다 (데스크톱은 왼쪽 세로 탭, 좁으면 가로로 밀어 넘기는 탭).
 *
 *   계정    내 계정 (비밀번호·모든 기기 로그아웃)
 *   연결    증권(KIS·토스)·뉴스 키 + 원격 MCP 서버 (TradingView 등)
 *   감시    봉 마감 감시 목록 — 일시정지·다시 켜기·삭제·비상 정지 (PLAN §40). 만들기는 챗에서
 *   AI 모델 LLM 키 (비우면 서버 기본 계정)
 *   화면    테마 · 단축키
 *   관리자  초대 코드·계정 관리·서버 DB 상태 — env 계정(슈퍼관리자)에게만 보인다
 *
 * 키는 전부 **사용자별**이다. 같은 서버를 써도 각자 자기 증권 계정을 쓴다.
 * 가계부 D1 접속 정보는 서버 env 전용이라 여기서 다루지 않는다
 * (DB가 있어야 앱이 도는데 그 설정을 앱에서 넣는 구조는 닭-달걀이 된다).
 *
 * 지금 탭은 주소에 싣는다 (/settings/connect) — 새로고침해도, "설정에서 키를 넣으세요" 링크로 와도 그 탭이 열린다.
 */
import { Tabs } from "@base-ui/react/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { api, type SecretStatus } from "../lib/api.ts";
import { getThemeMode, setThemeMode, type ThemeMode } from "../lib/theme.ts";
import { toast } from "../lib/toast.ts";
import { AdminPanel, MyAccount } from "./AccountSettings.tsx";
import { AlertIcon, ShieldIcon } from "./icons.tsx";
import { McpSettings } from "./McpSettings.tsx";
import { Topbar } from "./Topbar.tsx";
import { WatchSettings } from "./WatchSettings.tsx";

const SOURCE: Record<SecretStatus["source"], { label: string; tone: string }> = {
	user: { label: "내 설정", tone: "ok" },
	env: { label: "서버 env", tone: "" },
	none: { label: "미설정", tone: "" },
};

const THEMES: Array<{ value: ThemeMode; label: string; preview: string; side: string }> = [
	{ value: "light", label: "라이트", preview: "oklch(0.977 0.004 255)", side: "oklch(0.95 0.006 255)" },
	{ value: "dark", label: "다크", preview: "oklch(0.165 0.018 258)", side: "oklch(0.205 0.02 258)" },
	{ value: "system", label: "시스템", preview: "linear-gradient(135deg, oklch(0.977 0.004 255) 50%, oklch(0.165 0.018 258) 50%)", side: "transparent" },
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

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/** 키 그룹 → 탭. 서버 카탈로그(secrets.ts)의 group 문자열을 따른다 */
const tabOfGroup = (group: string): Tab => (group === "LLM" ? "ai" : "connect");

function tabFromPath(): Tab {
	const t = location.pathname.split("/")[2];
	return TABS.some((x) => x.value === t) ? (t as Tab) : "account";
}

/** 패널 머리 — 큰 제목 + 한 줄 설명 */
export function PanelHead({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<div className="panel-h">
			<h2>{title}</h2>
			{children && <p>{children}</p>}
		</div>
	);
}

export function SettingsPage({ onOpenConversation }: { onOpenConversation?: (id: string) => void } = {}) {
	const qc = useQueryClient();
	const [tab, setTab] = useState<Tab>(tabFromPath);

	const secrets = useQuery({ queryKey: ["secrets"], queryFn: api.secrets });
	const me = useQuery({ queryKey: ["me"], queryFn: api.me });
	const isAdmin = me.data?.admin === true;

	const save = useMutation({
		mutationFn: ({ name, value }: { name: string; value: string }) => api.setSecret(name, value),
		onSuccess: () => {
			toast("저장했습니다", { sub: "저장한 값은 화면으로 다시 내려오지 않습니다" });
			void qc.invalidateQueries({ queryKey: ["secrets"] });
		},
		onError: (e: Error) => toast(`저장하지 못했습니다: ${e.message}`),
	});
	const remove = useMutation({
		mutationFn: (name: string) => api.deleteSecret(name),
		onSuccess: () => {
			toast("내 설정 값을 지웠습니다");
			void qc.invalidateQueries({ queryKey: ["secrets"] });
		},
	});

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
				<section key={group} className="card">
					<div className="card-h">
						<h2>{group}</h2>
					</div>
					<div className="rows border-t border-line">
						{items
							.filter((i) => i.group === group)
							.map((item) => (
								<SecretRow
									key={item.name}
									item={item}
									busy={save.isPending || remove.isPending}
									onSave={(value) => save.mutate({ name: item.name, value })}
									onDelete={() => {
										if (confirm(`${item.label} — 내 설정 값을 지울까요?${item.source === "user" ? " 서버 기본값이 있으면 그걸 씁니다." : ""}`)) remove.mutate(item.name);
									}}
								/>
							))}
						{group === TELEGRAM_GROUP && <TelegramTest />}
					</div>
				</section>
			));

	// 키를 저장해도 재시작 뒤 못 읽는 상황 — 키를 넣는 탭에서 바로 보이게
	const storageWarnings = (
		<>
			{secrets.data && !secrets.data.storageReady && (
				<Warn>키 저장소가 준비되지 않았습니다. 관리자에게 서버 DB 설정을 확인해 달라고 하세요.</Warn>
			)}
			{secrets.data?.ephemeralMaster && (
				<Warn>
					AF_AUTH_SECRET 이 설정되지 않아 매 기동 새로 생성됩니다. 지금 저장한 키는 재시작 후 읽을 수 없습니다. 서버 환경변수에 고정한 뒤 다시 입력하세요.
				</Warn>
			)}
			{(secrets.data?.undecryptable ?? 0) > 0 && (
				<Warn>
					저장된 키 {secrets.data?.undecryptable}건을 복호화하지 못했습니다. AF_AUTH_SECRET 이 바뀌었을 수 있습니다. 새 값을 저장하면 덮어씁니다.
				</Warn>
			)}
		</>
	);
	const keyNote = (
		<div className="notice">
			<ShieldIcon size={16} />
			<span>키는 사용자별로 암호화되어 저장됩니다. 저장한 값은 화면으로 다시 내려오지 않으니, 바꾸려면 새 값을 입력하세요.</span>
		</div>
	);

	return (
		<>
			<Topbar title="설정" />
			<div className="page">
				<div className="wrap narrow">
					<Tabs.Root value={current} onValueChange={(v) => select(v as Tab)} className="set-grid">
						<Tabs.List className="set-tabs" aria-label="설정 분류">
							{tabs.map((t) => (
								<span key={t.value} className="contents">
									{t.admin && <span className="sep" aria-hidden="true" />}
									<Tabs.Tab value={t.value}>{t.label}</Tabs.Tab>
								</span>
							))}
						</Tabs.List>

						<div className="min-w-0">
							<Tabs.Panel value="account" className="set-panel">
								<PanelHead title="계정">로그인 정보와 이 계정으로 들어온 기기입니다.</PanelHead>
								{me.data && <MyAccount me={me.data} />}
							</Tabs.Panel>

							<Tabs.Panel value="connect" className="set-panel">
								<PanelHead title="연결">증권사·거래소 키와 알림 받을 곳, 원격 MCP 서버를 설정합니다.</PanelHead>
								{storageWarnings}
								{keyNote}
								{keyGroups("connect")}
								<McpSettings />
							</Tabs.Panel>

							<Tabs.Panel value="watch" className="set-panel">
								<PanelHead title="감시">챗에서 켠 감시와 자동 매매 한도입니다. 새 감시는 챗에서 말로 만드세요.</PanelHead>
								<WatchSettings {...(onOpenConversation ? { onOpenConversation } : {})} />
							</Tabs.Panel>

							<Tabs.Panel value="ai" className="set-panel">
								<PanelHead title="AI 모델">
									챗이 쓰는 모델의 키입니다. 비워두면 서버의 기본 계정으로 호출합니다. 넣으면 내 키로 과금되며, 서버를 다시 시작하지 않아도 바로 적용됩니다.
								</PanelHead>
								{storageWarnings}
								{keyNote}
								{keyGroups("ai")}
							</Tabs.Panel>

							<Tabs.Panel value="display" className="set-panel">
								<PanelHead title="화면">이 기기에만 적용됩니다.</PanelHead>
								<ThemeCard />
								<section className="card">
									<div className="card-h">
										<h2>단축키</h2>
									</div>
									{["챗", "투자", "가계부", "설정"].map((label, i) => (
										<div key={label} className="kbd-row">
											<span>{label}</span>
											<kbd className="key">
												{MOD} {i + 1}
											</kbd>
										</div>
									))}
									<div className="kbd-row">
										<span>줄바꿈 (챗 입력창)</span>
										<kbd className="key">Shift Enter</kbd>
									</div>
								</section>
							</Tabs.Panel>

							{isAdmin && me.data && (
								<Tabs.Panel value="admin" className="set-panel">
									<PanelHead title="관리자">이 서버의 저장소와 사용자입니다.</PanelHead>
									<ServerDbCard storageReady={secrets.data?.storageReady ?? true} />
									<AdminPanel me={me.data} />
								</Tabs.Panel>
							)}
						</div>
					</Tabs.Root>
				</div>
			</div>
		</>
	);
}

function Warn({ children }: { children: ReactNode }) {
	return (
		<div className="notice bad" role="alert">
			<AlertIcon size={16} />
			<span>{children}</span>
		</div>
	);
}

function ThemeCard() {
	const [theme, setTheme] = useState<ThemeMode>(getThemeMode);
	return (
		<section className="card">
			<div className="card-h">
				<h2>테마</h2>
			</div>
			<div className="card-b">
				<div className="theme-opts" role="radiogroup" aria-label="테마">
					{THEMES.map((t) => (
						<button
							key={t.value}
							className="theme-opt"
							role="radio"
							aria-checked={theme === t.value}
							onClick={() => {
								setTheme(t.value);
								setThemeMode(t.value);
							}}
						>
							<span className="pv" style={{ background: t.preview }}>
								<i style={{ background: t.side }} />
								<i />
							</span>
							<b>{t.label}</b>
						</button>
					))}
				</div>
				{theme === "system" && <p className="mt-3 text-[13px] text-muted">기기 설정이 바뀌면 자동으로 따라갑니다.</p>}
			</div>
		</section>
	);
}

function ServerDbCard({ storageReady }: { storageReady: boolean }) {
	const health = useQuery({ queryKey: ["health", "admin"], queryFn: api.health, staleTime: 60_000, retry: false });
	const test = useMutation({ mutationFn: api.testD1 });
	const r = test.data;
	return (
		<section className="card">
			<div className="card-h">
				<h2>서버 DB</h2>
				<span className="spacer" />
				<span className={`badge ${storageReady ? "ok" : "bad"}`}>{storageReady ? "준비됨" : "미설정"}</span>
			</div>
			<div className="card-b">
				<p className="mb-3.5 text-[13.5px] text-muted">
					가계부·계정·개인 키가 저장되는 곳입니다. 접속 정보는 서버 환경변수(<span className="mono">AF_D1_*</span>)에서만 바꿉니다.
				</p>
				<dl className="kv">
					<dt>설정 출처</dt>
					<dd>
						<span className="badge">서버 env</span>
					</dd>
					<dt>서버 버전</dt>
					<dd className="mono">{health.data?.version ? `v${health.data.version}` : "—"}</dd>
					<dt>모델</dt>
					<dd className="mono">{health.data?.model ?? "—"}</dd>
				</dl>
				<div className="form-actions">
					{(r || test.error) && <span className={`msg ${r?.ok ? "ok" : "bad"}`}>{r ? r.message : test.error?.message}</span>}
					<button className="btn btn-secondary" onClick={() => test.mutate()} disabled={test.isPending}>
						{test.isPending ? (
							<>
								<span className="spin" />
								확인 중…
							</>
						) : (
							"연결 테스트"
						)}
					</button>
				</div>
			</div>
		</section>
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
	const r = test.data;
	return (
		<div className="px-5 py-4 max-md:px-4">
			<p className="text-[12.5px] text-muted">
				① @BotFather 에서 /newbot 으로 봇을 만들어 토큰을 넣고 ② 텔레그램에서 그 봇에게 아무 메시지나 보낸 뒤 ③ 연결 테스트를 누르세요. 알림에는 종목·수량·체결가만
				담고 잔고·평가금액은 보내지 않습니다.
			</p>
			<div className="form-actions">
				{(r || test.error) && <span className={`msg ${r?.ok ? "ok" : "bad"}`}>{r ? r.message : test.error?.message}</span>}
				<button className="btn btn-secondary" onClick={() => test.mutate()} disabled={test.isPending}>
					{test.isPending ? (
						<>
							<span className="spin" />
							테스트 메시지 보내는 중…
						</>
					) : (
						"연결 테스트"
					)}
				</button>
			</div>
		</div>
	);
}

function SecretRow({ item, busy, onSave, onDelete }: { item: SecretStatus; busy: boolean; onSave: (value: string) => void; onDelete: () => void }) {
	const [value, setValue] = useState("");
	const src = SOURCE[item.source];

	function submit(e: FormEvent): void {
		e.preventDefault();
		if (!value.trim()) return;
		onSave(value);
		setValue("");
	}

	// 좁은 화면에서는 이름을 위, 입력·버튼을 아래 줄로 — 한 줄에 넣으면 입력칸이 몇 글자 폭으로 줄어든다
	return (
		<form className="key-row" onSubmit={submit}>
			<div className="who">
				<div className="name truncate">{item.label}</div>
				<div className="meta">
					<span className={`badge ${src.tone}`}>{src.label}</span>
					{item.preview && <span className="mono">{item.preview}</span>}
				</div>
			</div>
			<div className="edit">
				<input
					className="input input-sm mono"
					type="password"
					autoComplete="off"
					value={value}
					aria-label={`${item.label} 새 값`}
					placeholder={item.preview ? "새 값으로 교체" : (item.hint ?? "입력")}
					onChange={(e) => setValue(e.target.value)}
				/>
				<button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !value.trim()}>
					저장
				</button>
				{item.source === "user" && (
					<button type="button" className="btn btn-ghost btn-sm" onClick={onDelete} disabled={busy}>
						삭제
					</button>
				)}
			</div>
		</form>
	);
}
