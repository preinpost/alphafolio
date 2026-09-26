/**
 * 텔레그램 알림 채널 (PLAN §40) — 사용자마다 자기 봇 토큰으로 보낸다.
 *
 * 요청은 고정 주소 api.telegram.org 로만 나간다 (사용자 입력 URL 없음 → SSRF 없음).
 * ⚠️ 봇 토큰은 URL 경로에 들어간다 (`/bot<토큰>/sendMessage`) — 오류 메시지·로그에 URL 이 섞이지 않게 토큰을 지운다.
 */

const API = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;

export class TelegramError extends Error {
	/** 텔레그램 error_code (없으면 HTTP 상태) — 409 = 다른 곳이 이 봇을 읽고 있다 */
	code: number | null = null;
}

export interface TelegramDeps {
	fetch?: typeof fetch;
}

/** 봇 토큰 모양 — "123456789:AA…" (BotFather 발급) */
export function isBotToken(token: string): boolean {
	return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

/**
 * Node fetch 는 네트워크 오류를 "fetch failed" 하나로 감추고 원인을 cause 에 둔다
 * (여러 주소를 시도했으면 cause.errors 에 주소별 원인). 원인 코드가 보여야 고칠 수 있다.
 */
export function describeNetError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	if (err.name === "TimeoutError" || err.name === "AbortError") return "응답 시간 초과 (10초)";
	const cause = err.cause as { code?: string; message?: string; errors?: Array<{ code?: string; address?: string }> } | undefined;
	if (!cause) return err.message;
	const each = cause.errors?.map((e) => [e.code, e.address].filter(Boolean).join(" ")).filter(Boolean);
	const detail = each?.length ? each.join(", ") : (cause.code ?? cause.message ?? "");
	return detail ? `${err.message} (${detail})` : err.message;
}

/** 봇 id = 토큰의 앞 숫자 ("123456789:AA…" → "123456789") */
export function botIdOf(token: string): string {
	return token.trim().split(":")[0] ?? "";
}

function redact(text: string, token: string): string {
	return token ? text.split(token).join("<봇 토큰>") : text;
}

export async function call<T>(token: string, method: string, body: Record<string, unknown>, deps: TelegramDeps = {}, timeoutMs = TIMEOUT_MS): Promise<T> {
	const f = deps.fetch ?? fetch;
	let res: Response;
	try {
		res = await f(`${API}/bot${token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		throw new TelegramError(`텔레그램에 연결하지 못했습니다: ${redact(describeNetError(err), token)}`);
	}
	const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number } | null;
	if (!json?.ok) {
		const code = json?.error_code ?? res.status;
		const hint =
			code === 401 || code === 404
				? " — 봇 토큰이 올바르지 않습니다 (@BotFather 에서 다시 확인)"
				: code === 403
					? /bots? can't send messages to (the )?bots?/i.test(json?.description ?? "")
						? " — 채팅 id 에 봇 자신의 id 가 들어 있습니다. 내 계정 id 가 필요합니다 (채팅 id 를 지우고 연결 테스트를 다시 누르세요)"
						: " — 봇이 막혔거나 대화가 없습니다 (봇에게 먼저 메시지를 보내 주세요)"
					: code === 409
						? " — 이 봇에 웹훅이 설정돼 있어 메시지를 읽을 수 없습니다 (다른 곳에서 쓰는 봇이면 새 봇을 만들어 주세요)"
						: "";
		const e = new TelegramError(`텔레그램 오류 ${code}: ${redact(json?.description ?? "응답 없음", token)}${hint}`);
		e.code = code;
		throw e;
	}
	return json.result as T;
}

/** 봇 이름 (@username) — 토큰 확인용 */
export async function getBotName(token: string, deps?: TelegramDeps): Promise<string> {
	const me = await call<{ username?: string; first_name?: string }>(token, "getMe", {}, deps);
	return me.username ? `@${me.username}` : (me.first_name ?? "봇");
}

interface Update {
	update_id: number;
	message?: { date: number; chat: { id: number; type: string; username?: string; first_name?: string } };
}

/**
 * 채팅 id 찾기 — 사용자가 봇에게 보낸 최근 메시지의 **개인 채팅**.
 * 그룹·채널은 고르지 않는다 (남도 보는 곳으로 체결 알림이 가지 않게). 없으면 null.
 */
export async function findPrivateChat(token: string, deps?: TelegramDeps): Promise<{ id: string; name: string } | null> {
	// 다른 프로그램이 이 봇으로 이미 메시지를 읽어 갔으면 비어 있을 수 있다 (getUpdates 는 한 번 확인한 메시지를 다시 주지 않는다)
	const updates = await call<Update[]>(token, "getUpdates", { limit: 100, allowed_updates: ["message"] }, deps);
	const privates = updates.filter((u) => u.message?.chat.type === "private").sort((a, b) => b.update_id - a.update_id);
	const chat = privates[0]?.message?.chat;
	if (!chat) return null;
	return { id: String(chat.id), name: chat.username ? `@${chat.username}` : (chat.first_name ?? String(chat.id)) };
}

/** HTML parse_mode 용 이스케이프 — 종목명·메시지에 <, & 가 섞여도 깨지지 않게 */
export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 인라인 버튼 — callback_data 는 64바이트까지 */
export type Buttons = Array<Array<{ text: string; callback_data: string }>>;

export async function sendMessage(token: string, chatId: string, html: string, deps?: TelegramDeps, buttons?: Buttons): Promise<void> {
	await call(
		token,
		"sendMessage",
		{ chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) },
		deps,
	);
}

/** 버튼이 달린 메시지를 고쳐 쓴다 (목록 갱신·확인 결과) */
export async function editMessage(token: string, chatId: string, messageId: number, html: string, deps?: TelegramDeps, buttons?: Buttons): Promise<void> {
	await call(
		token,
		"editMessageText",
		{ chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: buttons ?? [] } },
		deps,
	).catch((err: unknown) => {
		// 내용이 같으면 텔레그램이 400 을 준다 — 무시
		if (!(err instanceof TelegramError && /not modified/i.test(err.message))) throw err;
	});
}

/** 버튼 누름에 답한다 (안 하면 버튼이 계속 로딩 중으로 보인다) */
export async function answerCallback(token: string, callbackId: string, text: string, deps?: TelegramDeps): Promise<void> {
	await call(token, "answerCallbackQuery", { callback_query_id: callbackId, text: text.slice(0, 190) }, deps).catch(() => undefined);
}
