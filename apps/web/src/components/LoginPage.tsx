/**
 * 로그인 · 초대 코드로 가입 (PLAN §25).
 * 가입은 관리자가 발급한 1회용 초대 코드가 있어야 한다. 가입하면 바로 로그인된다.
 *
 * 데스크톱은 왼쪽에 네이비 소개 패널, 모바일은 폼만. 입력 규칙은 서버(accounts.ts)와 같다 —
 * 흔한 실수는 누르기 전에 알려 주고, 서버 오류는 그대로 보여 준다.
 * 시도가 너무 많으면 서버가 잠근다(429) — 남은 시간을 세어 보여 준다.
 *
 * 주소: #signup 이면 가입으로, #join=CODE 면 코드를 채운 가입으로 연다.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, login, signup } from "../lib/api.ts";
import { setToken } from "../lib/auth.ts";
import { isDarkNow, onThemeApplied, setThemeMode } from "../lib/theme.ts";
import { AlertIcon, ChatIcon, CheckIcon, EyeIcon, EyeOffIcon, MoonIcon, ShieldIcon, SunIcon, TrendingIcon, WalletIcon } from "./icons.tsx";
import { Logo } from "./Logo.tsx";

type Mode = "login" | "signup";

const NAME_RE = /^[a-z0-9_]{3,20}$/;
const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const PW_MIN = 10;
const PW_MAX = 128;

/** 대문자·숫자만 남기고 4자리마다 하이픈 (서버는 하이픈·대소문자를 무시한다) */
const formatCode = (raw: string): string =>
	raw
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "")
		.slice(0, 12)
		.match(/.{1,4}/g)
		?.join("-") ?? "";

const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

type Hint = { text: string; tone?: "err" | "ok" | "warn" } | null;

/** 처음 열 때 — #join=CODE · #signup */
function initialFromHash(): { mode: Mode; code: string; prefilled: boolean } {
	const join = location.hash.match(/^#join=([A-Za-z0-9-]+)/);
	if (join?.[1]) return { mode: "signup", code: formatCode(join[1]), prefilled: true };
	return { mode: location.hash === "#signup" ? "signup" : "login", code: "", prefilled: false };
}

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
	const [init] = useState(initialFromHash);
	const [mode, setModeState] = useState<Mode>(init.mode);
	const [code, setCode] = useState(init.code);
	const [prefilled, setPrefilled] = useState(init.prefilled);
	const [user, setUser] = useState("");
	const [pw, setPw] = useState("");
	const [pw2, setPw2] = useState("");
	const [show, setShow] = useState({ pw: false, pw2: false });
	const [caps, setCaps] = useState(false);
	const [touched, setTouched] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	/** 잠금이 풀리는 시각 (ms) — 모드별 */
	const [lockUntil, setLockUntil] = useState<Record<Mode, number>>({ login: 0, signup: 0 });
	const [, tick] = useState(0);

	const dark = useSyncExternalStore(onThemeApplied, isDarkNow);
	const refs = {
		code: useRef<HTMLInputElement>(null),
		user: useRef<HTMLInputElement>(null),
		pw: useRef<HTMLInputElement>(null),
	};

	const su = mode === "signup";
	const lockLeft = Math.max(0, Math.ceil((lockUntil[mode] - Date.now()) / 1000));
	const locked = lockLeft > 0;

	// 잠금 카운트다운 — 1초마다 다시 그린다
	useEffect(() => {
		if (!locked) return;
		const id = setInterval(() => tick((n) => n + 1), 1000);
		return () => clearInterval(id);
	}, [locked]);

	const touch = (k: string): void => setTouched((t) => (t.has(k) ? t : new Set(t).add(k)));

	// ── 검증 (가입만 — 로그인은 둘 다 채웠는지만) ──
	const codeOk = CODE_RE.test(code);
	const userOk = NAME_RE.test(user);
	const pwOk = pw.length >= PW_MIN && pw.length <= PW_MAX;
	const same = pw2.length > 0 && pw2 === pw;
	const ready = su ? codeOk && userOk && pwOk && same : Boolean(user && pw);

	const hints: Record<"code" | "user" | "pw" | "pw2", Hint> = !su
		? { code: null, user: null, pw: null, pw2: null }
		: {
				code:
					code && !codeOk && touched.has("code")
						? { text: "XXXX-XXXX-XXXX 형식의 12자리입니다", tone: "err" }
						: codeOk && prefilled
							? { text: "초대 링크에서 코드를 채웠습니다", tone: "ok" }
							: { text: "관리자에게 받은 1회용 코드입니다" },
				user: /[^a-z0-9_]/.test(user)
					? { text: "영문 소문자·숫자·_만 쓸 수 있습니다", tone: "err" }
					: user && !userOk && touched.has("user")
						? { text: user.length < 3 ? "3자 이상이어야 합니다" : "20자 이하여야 합니다", tone: "err" }
						: { text: "영문 소문자·숫자·_ 3~20자 · 로그인할 때 씁니다" },
				pw:
					pw.length > PW_MAX
						? { text: `${PW_MAX}자 이하여야 합니다`, tone: "err" }
						: pwOk
							? { text: `${pw.length}자 · 충분한 길이입니다`, tone: "ok" }
							: pw && touched.has("pw")
								? { text: `${PW_MIN}자 이상이어야 합니다 · 지금 ${pw.length}자`, tone: "err" }
								: { text: pw ? `${PW_MIN}자 이상 · 지금 ${pw.length}자` : `${PW_MIN}자 이상` },
				pw2:
					pw2 && !same && (touched.has("pw2") || pw2.length >= pw.length)
						? { text: "비밀번호가 서로 다릅니다", tone: "err" }
						: same && pwOk
							? { text: "일치합니다", tone: "ok" }
							: null,
			};

	function setMode(next: Mode): void {
		setModeState(next);
		setTouched(new Set());
		setPw("");
		setPw2("");
		setShow({ pw: false, pw2: false });
		setCaps(false);
		setError(null);
		if (next === "signup") setUser((u) => u.toLowerCase());
		history.replaceState(null, "", next === "signup" ? "#signup" : location.pathname + location.search);
		requestAnimationFrame(() => (next === "signup" ? (code ? refs.user : refs.code) : user ? refs.pw : refs.user).current?.focus());
	}

	async function submit(e: FormEvent): Promise<void> {
		e.preventDefault();
		if (busy || done || locked || !ready) return;
		setBusy(true);
		setError(null);
		try {
			const token = su ? await signup(code, user, pw) : await login(user.trim(), pw);
			await setToken(token);
			setDone(true);
			history.replaceState(null, "", location.pathname + location.search);
			onSuccess();
		} catch (err) {
			if (err instanceof ApiError && err.retryAfterSec) {
				setLockUntil((l) => ({ ...l, [mode]: Date.now() + (err.retryAfterSec ?? 0) * 1000 }));
			} else {
				setError(err instanceof Error ? err.message : su ? "가입 실패" : "로그인 실패");
				if (!su) {
					setPw("");
					refs.pw.current?.focus();
				}
			}
		} finally {
			setBusy(false);
		}
	}

	const onCapsKey = (e: KeyboardEvent<HTMLInputElement>): void => setCaps(e.getModifierState("CapsLock"));

	const errorText = locked ? `${su ? "시도가" : "로그인 시도가"} 너무 많습니다. ${mmss(lockLeft)} 뒤에 다시 시도하세요.` : error;

	return (
		<div className="auth">
			<aside className="auth-intro" aria-label="AlphaFolio 소개">
				<div className="brandline">
					<Logo />
					AlphaFolio
				</div>
				<div className="main-copy">
					<p className="eyebrow-on">개인 금융 에이전트</p>
					<h1>
						자산 조회부터 주문 준비까지,
						<br />
						대화 한 번으로
					</h1>
					<p className="lede">증권사·거래소 계좌를 한곳에 모아 보고, 실제 주문은 내가 확인 카드를 눌렀을 때만 나갑니다.</p>
					<ul className="auth-caps">
						<li>
							<span className="ic">
								<ChatIcon size={17} />
							</span>
							<div>
								<b>챗</b>
								<span>시세 조회 · 주문 준비 · 리밸런싱 점검 · 조건 감시</span>
							</div>
						</li>
						<li>
							<span className="ic">
								<TrendingIcon size={17} />
							</span>
							<div>
								<b>투자</b>
								<span>여러 계좌를 합친 총자산과 보유 자산</span>
							</div>
						</li>
						<li>
							<span className="ic">
								<WalletIcon size={17} />
							</span>
							<div>
								<b>가계부</b>
								<span>함께 쓰는 월 지출과 카테고리 예산</span>
							</div>
						</li>
					</ul>
				</div>
				<div className="foot">
					<ShieldIcon size={15} />
					초대받은 사람만 가입할 수 있습니다
					<span className="mono">v{__APP_VERSION__}</span>
				</div>
				<svg className="auth-mark" viewBox="0 0 512 512" aria-hidden="true">
					<path d="M256 134 127 398M256 134 385 398" stroke="oklch(1 0 0 / 0.06)" strokeWidth="48" fill="none" />
					<rect x="189" y="271" width="135" height="44" fill="var(--logo-bar)" opacity="0.2" />
				</svg>
			</aside>

			<main className="auth-side">
				<div className="top">
					<button
						type="button"
						className="icon-btn"
						onClick={() => setThemeMode(dark ? "light" : "dark")}
						aria-label="테마 전환"
						title="테마 전환"
					>
						{dark ? <SunIcon /> : <MoonIcon />}
					</button>
				</div>

				<div className="mid">
					<form className="auth-form" onSubmit={(e) => void submit(e)} noValidate>
						<div className="m-brand">
							<Logo />
							<div>
								<b>AlphaFolio</b>
								<small>개인 금융 에이전트</small>
							</div>
						</div>

						<div className="form-h">
							<h2>{su ? "초대 코드로 가입" : "로그인"}</h2>
							<p>{su ? "관리자에게 받은 1회용 코드가 필요합니다. 가입하면 바로 로그인됩니다." : "AlphaFolio 계정으로 계속합니다."}</p>
						</div>

						<div className="auth-fields">
							{su && (
								<div className="field">
									<label htmlFor="af-code">초대 코드</label>
									<input
										ref={refs.code}
										id="af-code"
										className="input code"
										placeholder="XXXX-XXXX-XXXX"
										autoComplete="one-time-code"
										autoCapitalize="characters"
										autoCorrect="off"
										spellCheck={false}
										maxLength={14}
										value={code}
										aria-invalid={hints.code?.tone === "err"}
										aria-describedby="af-code-hint"
										onChange={(e) => {
											setCode(formatCode(e.target.value));
											setPrefilled(false);
											setError(null);
										}}
										onBlur={() => code && touch("code")}
									/>
									<FieldHint id="af-code-hint" hint={hints.code} />
								</div>
							)}

							<div className="field">
								<label htmlFor="af-user">{su ? "사용할 ID" : "아이디"}</label>
								<input
									ref={refs.user}
									id="af-user"
									className="input"
									autoComplete="username"
									autoCapitalize="none"
									autoCorrect="off"
									spellCheck={false}
									value={user}
									aria-invalid={hints.user?.tone === "err"}
									aria-describedby="af-user-hint"
									onChange={(e) => {
										setUser(su ? e.target.value.toLowerCase() : e.target.value);
										setError(null);
									}}
									onBlur={() => user && touch("user")}
								/>
								<FieldHint id="af-user-hint" hint={hints.user} />
							</div>

							<div className="field">
								<label htmlFor="af-pw">비밀번호</label>
								<div className="pw-wrap">
									<input
										ref={refs.pw}
										id="af-pw"
										className="input"
										type={show.pw ? "text" : "password"}
										autoComplete={su ? "new-password" : "current-password"}
										value={pw}
										aria-invalid={hints.pw?.tone === "err"}
										aria-describedby="af-pw-hint af-caps"
										onChange={(e) => {
											setPw(e.target.value);
											setError(null);
										}}
										onKeyDown={onCapsKey}
										onKeyUp={onCapsKey}
										onBlur={() => {
											setCaps(false);
											if (pw) touch("pw");
										}}
									/>
									<EyeButton on={show.pw} onToggle={() => setShow((s) => ({ ...s, pw: !s.pw }))} />
								</div>
								<FieldHint id="af-pw-hint" hint={hints.pw} />
								{caps && (
									<small className="auth-hint warn" id="af-caps">
										<AlertIcon size={13} />
										Caps Lock이 켜져 있습니다
									</small>
								)}
							</div>

							{su && (
								<div className="field">
									<label htmlFor="af-pw2">비밀번호 확인</label>
									<div className="pw-wrap">
										<input
											id="af-pw2"
											className="input"
											type={show.pw2 ? "text" : "password"}
											autoComplete="new-password"
											value={pw2}
											aria-invalid={hints.pw2?.tone === "err"}
											aria-describedby="af-pw2-hint"
											onChange={(e) => {
												setPw2(e.target.value);
												setError(null);
											}}
											onKeyDown={onCapsKey}
											onKeyUp={onCapsKey}
											onBlur={() => {
												setCaps(false);
												if (pw2) touch("pw2");
											}}
										/>
										<EyeButton on={show.pw2} onToggle={() => setShow((s) => ({ ...s, pw2: !s.pw2 }))} />
									</div>
									<FieldHint id="af-pw2-hint" hint={hints.pw2} />
								</div>
							)}
						</div>

						{errorText && (
							<div className="notice bad" role="alert">
								<AlertIcon size={16} />
								<span className="num">{errorText}</span>
							</div>
						)}

						<button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || locked || !ready || done}>
							{done ? (
								<>
									<CheckIcon size={17} />
									{su ? "가입했습니다" : "로그인했습니다"}
								</>
							) : busy ? (
								<>
									<span className="spin" />
									확인 중…
								</>
							) : locked ? (
								"잠시 후 다시 시도하세요"
							) : su ? (
								"가입하고 시작하기"
							) : (
								"로그인"
							)}
						</button>

						{!su && <p className="auth-forgot">비밀번호를 잊었다면 관리자에게 재설정을 요청하세요.</p>}
						<div className="auth-divider" />
						<p className="auth-aux">
							{su ? "이미 계정이 있나요? " : "초대 코드를 받으셨나요? "}
							<button type="button" className="text-link" onClick={() => setMode(su ? "login" : "signup")}>
								{su ? "로그인" : "가입하기"}
							</button>
						</p>
					</form>
				</div>
			</main>
		</div>
	);
}

function FieldHint({ id, hint }: { id: string; hint: Hint }) {
	if (!hint) return null;
	return (
		<small className={`auth-hint ${hint.tone ?? ""}`} id={id}>
			{hint.text}
		</small>
	);
}

function EyeButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			className="icon-btn"
			onClick={onToggle}
			aria-pressed={on}
			aria-label={on ? "비밀번호 숨기기" : "비밀번호 보기"}
			title={on ? "숨기기" : "보기"}
		>
			{on ? <EyeOffIcon /> : <EyeIcon />}
		</button>
	);
}
