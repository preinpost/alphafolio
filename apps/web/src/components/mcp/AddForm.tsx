import { useEffect, useRef, useState, type FormEvent } from "react";
import type { McpAddInput } from "../../lib/api.ts";
import { checkUrl, type AuthChoice } from "./helpers.ts";

export function AddForm({ busy, serverError, onAdd, onCancel }: { busy: boolean; serverError: string | null; onAdd: (i: McpAddInput) => void; onCancel: () => void }) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [auth, setAuth] = useState<AuthChoice>("oauth");
	const [token, setToken] = useState("");
	const [errors, setErrors] = useState<{ name?: string; url?: string; token?: string }>({});
	const refs = { name: useRef<HTMLInputElement>(null), url: useRef<HTMLInputElement>(null), token: useRef<HTMLInputElement>(null) };

	useEffect(() => refs.name.current?.focus(), []);

	function submit(e: FormEvent): void {
		e.preventDefault();
		const urlError = url.trim() ? checkUrl(url.trim()) : "주소를 입력하세요.";
		const next = {
			...(name.trim() ? {} : { name: "이름을 입력하세요." }),
			...(urlError ? { url: urlError } : {}),
			...(auth === "bearer" && !token.trim() ? { token: "토큰을 입력하세요." } : {}),
		};
		setErrors(next);
		const first = (["name", "url", "token"] as const).find((k) => next[k]);
		if (first) return refs[first].current?.focus();
		onAdd(auth === "bearer" ? { name: name.trim(), url: url.trim(), auth, token: token.trim() } : { name: name.trim(), url: url.trim(), auth });
	}

	return (
		<form className="add-form" onSubmit={submit} noValidate>
			<div className="form-grid">
				<label className="field">
					<span>이름</span>
					<input ref={refs.name} className="input" autoComplete="off" placeholder="예: 사내 문서 검색" value={name} aria-invalid={!!errors.name} onChange={(e) => setName(e.target.value)} />
					{errors.name && <span className="field-err">{errors.name}</span>}
				</label>
				<label className="field">
					<span>주소</span>
					<input
						ref={refs.url}
						className="input mono"
						inputMode="url"
						autoComplete="off"
						placeholder="https://…/mcp"
						value={url}
						aria-invalid={!!errors.url}
						onChange={(e) => setUrl(e.target.value)}
					/>
					{errors.url && <span className="field-err">{errors.url}</span>}
				</label>
				<label className="field">
					<span>인증</span>
					<select className="input" value={auth} onChange={(e) => setAuth(e.target.value as AuthChoice)}>
						<option value="oauth">OAuth 로그인</option>
						<option value="bearer">Bearer 토큰</option>
						<option value="none">인증 없음</option>
					</select>
				</label>
				{auth === "bearer" && (
					<label className="field">
						<span>토큰</span>
						<input ref={refs.token} className="input mono" type="password" autoComplete="off" value={token} aria-invalid={!!errors.token} onChange={(e) => setToken(e.target.value)} />
						{errors.token && <span className="field-err">{errors.token}</span>}
					</label>
				)}
			</div>
			<div className="form-actions">
				{serverError && <span className="msg bad">{serverError}</span>}
				<button className="btn btn-ghost" type="button" onClick={onCancel}>
					취소
				</button>
				<button className="btn btn-primary" type="submit" disabled={busy}>
					{busy ? "추가하는 중…" : "추가"}
				</button>
			</div>
		</form>
	);
}
