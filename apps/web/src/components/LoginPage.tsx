/**
 * 로그인 · 초대 코드로 가입 (PLAN §25).
 * 가입은 관리자가 발급한 1회용 초대 코드가 있어야 한다. 가입하면 바로 로그인된다.
 */
import { useState, type FormEvent } from "react";
import { login, signup } from "../lib/api.ts";
import { setToken } from "../lib/auth.ts";
import { Logo } from "./Logo.tsx";

const field = "w-full rounded-xl border border-line bg-card px-4 py-3 text-ink outline-none focus:border-accent";
const NAME_RE = /^[a-z0-9_]{3,20}$/;
const PASSWORD_MIN = 10;

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
	const [mode, setMode] = useState<"login" | "signup">("login");
	const [user, setUser] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	// 가입 입력은 서버도 검사하지만, 흔한 실수는 누르기 전에 알려준다
	const signupProblem =
		mode !== "signup"
			? null
			: user && !NAME_RE.test(user)
				? "ID 는 영문 소문자·숫자·_ 3~20자"
				: password && password.length < PASSWORD_MIN
					? `비밀번호는 ${PASSWORD_MIN}자 이상`
					: confirm && confirm !== password
						? "비밀번호가 서로 다릅니다"
						: null;
	const ready =
		mode === "login" ? Boolean(user && password) : Boolean(code && user && password && confirm) && !signupProblem;

	async function submit(e: FormEvent): Promise<void> {
		e.preventDefault();
		if (!ready) return;
		setBusy(true);
		setError(null);
		try {
			const token = mode === "login" ? await login(user, password) : await signup(code, user, password);
			await setToken(token);
			onSuccess();
		} catch (err) {
			setError(err instanceof Error ? err.message : mode === "login" ? "로그인 실패" : "가입 실패");
		} finally {
			setBusy(false);
		}
	}

	function switchMode(next: "login" | "signup"): void {
		setMode(next);
		setError(null);
		setPassword("");
		setConfirm("");
	}

	return (
		<div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-canvas px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
			<form onSubmit={submit} className="w-full max-w-sm space-y-5">
				<div className="flex flex-col items-center gap-3">
					<Logo className="size-12 rounded-2xl" />
					<div className="text-center">
						<h1 className="text-lg font-semibold text-ink">AlphaFolio</h1>
						<p className="text-sm text-muted">{mode === "login" ? "개인 금융 에이전트" : "초대 코드로 가입"}</p>
					</div>
				</div>

				<div className="space-y-2">
					{mode === "signup" && (
						<input
							className={`${field} font-mono tracking-wider uppercase`}
							placeholder="초대 코드 (XXXX-XXXX-XXXX)"
							autoCapitalize="characters"
							autoCorrect="off"
							autoComplete="one-time-code"
							spellCheck={false}
							value={code}
							onChange={(e) => setCode(e.target.value)}
						/>
					)}
					<input
						className={field}
						placeholder={mode === "login" ? "아이디" : "사용할 ID (영문 소문자·숫자·_)"}
						autoComplete="username"
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						value={user}
						onChange={(e) => setUser(mode === "signup" ? e.target.value.toLowerCase() : e.target.value)}
					/>
					<input
						className={field}
						placeholder={mode === "login" ? "비밀번호" : `비밀번호 (${PASSWORD_MIN}자 이상)`}
						type="password"
						autoComplete={mode === "login" ? "current-password" : "new-password"}
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
					{mode === "signup" && (
						<input
							className={field}
							placeholder="비밀번호 확인"
							type="password"
							autoComplete="new-password"
							value={confirm}
							onChange={(e) => setConfirm(e.target.value)}
						/>
					)}
				</div>

				{(error || signupProblem) && <p className="text-sm text-danger">{error ?? signupProblem}</p>}

				<button
					type="submit"
					disabled={busy || !ready}
					className="w-full rounded-xl bg-accent py-3 font-medium text-accent-ink transition active:scale-[0.99] disabled:opacity-50"
				>
					{busy ? "확인 중…" : mode === "login" ? "로그인" : "가입하고 시작하기"}
				</button>

				<p className="text-center text-sm text-muted">
					{mode === "login" ? (
						<>
							초대 코드를 받으셨나요?{" "}
							<button type="button" onClick={() => switchMode("signup")} className="font-medium text-accent">
								가입하기
							</button>
						</>
					) : (
						<>
							이미 계정이 있나요?{" "}
							<button type="button" onClick={() => switchMode("login")} className="font-medium text-accent">
								로그인
							</button>
						</>
					)}
				</p>
			</form>
		</div>
	);
}
