import { useState, type FormEvent } from "react";
import { login } from "../lib/api.ts";
import { setToken } from "../lib/auth.ts";

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
	const [user, setUser] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(e: FormEvent): Promise<void> {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			setToken(await login(user, password));
			onSuccess();
		} catch (err) {
			setError(err instanceof Error ? err.message : "로그인 실패");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex min-h-dvh items-center justify-center bg-canvas px-6">
			<form onSubmit={submit} className="w-full max-w-sm space-y-5">
				<div className="flex flex-col items-center gap-3">
					<div className="flex size-12 items-center justify-center rounded-2xl bg-accent text-2xl font-semibold text-accent-ink">
						α
					</div>
					<div className="text-center">
						<h1 className="text-lg font-semibold text-ink">AlphaFolio</h1>
						<p className="text-sm text-muted">개인 금융 에이전트</p>
					</div>
				</div>

				<div className="space-y-2">
					<input
						className="w-full rounded-xl border border-line bg-card px-4 py-3 text-ink outline-none focus:border-accent"
						placeholder="아이디"
						autoComplete="username"
						value={user}
						onChange={(e) => setUser(e.target.value)}
					/>
					<input
						className="w-full rounded-xl border border-line bg-card px-4 py-3 text-ink outline-none focus:border-accent"
						placeholder="비밀번호"
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
				</div>

				{error && <p className="text-sm text-danger">{error}</p>}

				<button
					type="submit"
					disabled={busy || !user || !password}
					className="w-full rounded-xl bg-accent py-3 font-medium text-accent-ink transition active:scale-[0.99] disabled:opacity-50"
				>
					{busy ? "확인 중…" : "로그인"}
				</button>
			</form>
		</div>
	);
}
