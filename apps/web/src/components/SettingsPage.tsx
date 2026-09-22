/**
 * 설정 — 화면 테마 + 개인 키 입력.
 *
 * 키는 전부 **사용자별**이다. 같은 서버를 써도 각자 자기 증권 계정을 쓴다.
 * 가계부 D1 접속 정보는 서버 env 전용이라 여기서 다루지 않는다
 * (DB가 있어야 앱이 도는데 그 설정을 앱에서 넣는 구조는 닭-달걀이 된다).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type SecretStatus } from "../lib/api.ts";
import { getThemeMode, setThemeMode, type ThemeMode } from "../lib/theme.ts";

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

export function SettingsPage() {
	const qc = useQueryClient();
	const [theme, setTheme] = useState<ThemeMode>(getThemeMode);
	const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);

	const secrets = useQuery({ queryKey: ["secrets"], queryFn: api.secrets });

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

	return (
		<div className="flex-1 overflow-y-auto">
			<div className="mx-auto max-w-2xl space-y-6 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
				{/* ── 화면 ─────────────────────────────────────── */}
				<section>
					<h2 className="mb-2 text-sm font-medium text-muted">화면</h2>
					<div className="rounded-xl border border-line p-3">
						<div className="flex items-center justify-between gap-3">
							<span className="text-sm text-ink">테마</span>
							<div className="flex gap-1 rounded-lg bg-inset p-0.5">
								{THEMES.map((t) => (
									<button
										key={t.value}
										onClick={() => {
											setTheme(t.value);
											setThemeMode(t.value);
										}}
										className={`rounded-md px-3 py-1.5 text-xs transition ${
											theme === t.value ? "bg-card text-ink shadow-sm" : "text-muted"
										}`}
									>
										{t.label}
									</button>
								))}
							</div>
						</div>
						{theme === "system" && (
							<p className="mt-2 text-xs text-faint">기기 설정이 바뀌면 자동으로 따라갑니다.</p>
						)}
					</div>
				</section>

				{/* ── 서버 연결 ─────────────────────────────────── */}
				<section>
					<h2 className="mb-2 text-sm font-medium text-muted">서버 연결</h2>
					<div className="space-y-2 rounded-xl border border-line p-3">
						<p className="text-xs text-faint">
							가계부와 개인 키는 서버에 등록된 Cloudflare D1 한 곳에 저장됩니다. 접속 정보는 서버 환경변수로만
							설정합니다.
						</p>
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
					</div>
				</section>

				{/* ── 경고 ─────────────────────────────────────── */}
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

				{/* ── 개인 키 ───────────────────────────────────── */}
				{groups.map((group) => (
					<section key={group}>
						<h2 className="mb-2 text-sm font-medium text-muted">{group}</h2>
						<div className="space-y-2 rounded-xl border border-line p-3">
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
						</div>
					</section>
				))}

				<p className="text-xs text-faint">
					키는 사용자별로 저장되며 암호화되어 보관됩니다. 저장한 값은 화면으로 다시 내려오지 않으니, 바꾸려면 새
					값을 입력하세요.
				</p>
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

	return (
		<div className="flex items-center gap-2">
			<div className="w-40 shrink-0">
				<div className="truncate text-sm text-ink">{item.label}</div>
				<div className="text-[11px] text-faint">
					{SOURCE_LABEL[item.source]}
					{item.preview ? ` · ${item.preview}` : ""}
				</div>
			</div>

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
	);
}
