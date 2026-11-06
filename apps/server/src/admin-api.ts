/**
 * 계정·설정 관리 경로 (인증 필요).
 *
 *   /api/me, /api/me/*, /api/admin/*   내 계정·관리자 (accounts-api.ts)
 *   /api/secrets*                       사용자별 키 — 원문은 어떤 경우에도 내보내지 않는다 (설정 여부 + 마스킹만)
 *   /api/notify/telegram/test           텔레그램 연결 테스트
 */
import { d1Ping, type D1Config } from "@alphafolio/ledger";
import { Type } from "typebox";
import type { AccountStore } from "./accounts.ts";
import { handleAccounts } from "./accounts-api.ts";
import { HttpError, readBody } from "./http.ts";
import type { Notifier } from "./notify/index.ts";
import { TELEGRAM_CHAT, TELEGRAM_TOKEN } from "./notify/index.ts";
import type { TelegramBots } from "./notify/telegram-bot.ts";
import { botIdOf, findPrivateChat, getBotName, isBotToken, sendMessage, TelegramError } from "./notify/telegram.ts";
import { startsWith, type AuthedCtx, type Route } from "./routes.ts";
import type { RuntimeManager } from "./runtimes.ts";
import { LLM_SECRET_PROVIDERS, SECRET_CATALOG, specFor, type SecretStore } from "./secrets.ts";

const SecretBody = Type.Object({ name: Type.String(), value: Type.String() });

export interface AdminApiDeps {
	accounts: AccountStore;
	issueToken: (name: string) => string;
	secrets: SecretStore;
	runtimes: RuntimeManager;
	telegramBots: TelegramBots;
	notifier: Notifier;
	ledgerConfig: () => D1Config;
}

export function adminRoutes(d: AdminApiDeps): Route<AuthedCtx>[] {
	const { secrets } = d;
	return [
		// ── 시크릿 ────────────────────────────────────────
		{
			method: "GET",
			path: "/api/secrets",
			handle: ({ user }) => ({
				items: secrets.status(user),
				ephemeralMaster: secrets.ephemeralMaster,
				storageReady: secrets.ready,
				undecryptable: secrets.failedCount,
			}),
		},
		{
			method: "PUT",
			path: "/api/secrets",
			handle: async ({ req, user }) => {
				const { name, value } = await readBody(req, SecretBody);
				if (!specFor(name)) throw new HttpError(400, `저장할 수 없는 키입니다: ${name}`);
				try {
					await secrets.set(name, value, user);
				} catch (err) {
					throw new HttpError(400, err instanceof Error ? err.message : String(err));
				}
				// LLM 키는 떠 있는 런타임에 바로 반영 (재시작·재로그인 불필요)
				const llmProvider = LLM_SECRET_PROVIDERS[name];
				if (llmProvider) await d.runtimes.applyLlmKey(user, llmProvider, secrets.get(name, user) ?? null);
				if (name.startsWith("TELEGRAM_")) d.telegramBots.refresh(user);
				return { items: secrets.status(user) };
			},
		},
		{
			method: "DELETE",
			path: startsWith("/api/secrets/"),
			handle: async ({ path, user }) => {
				const name = decodeURIComponent(path.slice("/api/secrets/".length));
				if (!specFor(name)) throw new HttpError(400, `알 수 없는 키입니다: ${name}`);
				await secrets.remove(name, user);
				// 제거하면 서버 기본(auth.json·env)으로 되돌아간다
				const llmProvider = LLM_SECRET_PROVIDERS[name];
				if (llmProvider) await d.runtimes.applyLlmKey(user, llmProvider, null);
				if (name.startsWith("TELEGRAM_")) d.telegramBots.refresh(user);
				return { items: secrets.status(user) };
			},
		},
		// 연결 테스트 — 저장된 값으로 실제 호출을 한 번 해본다
		{
			method: "POST",
			path: "/api/secrets/test/d1",
			handle: async () => {
				try {
					const ms = await d1Ping(d.ledgerConfig());
					return { ok: true, message: `연결 성공 (${ms}ms)` };
				} catch (err) {
					return { ok: false, message: err instanceof Error ? err.message : String(err) };
				}
			},
		},
		// 텔레그램 연결 테스트 — 채팅 id 가 없으면 봇에게 온 최근 개인 메시지에서 찾아 저장하고, 테스트 메시지를 보낸다
		{
			method: "POST",
			path: "/api/notify/telegram/test",
			handle: ({ user }) => telegramTest(d, user),
		},
		{
			path: "/api/me",
			handle: ({ user }) => ({
				user,
				groups: [...new Set(SECRET_CATALOG.map((x) => x.group))],
				admin: d.accounts.isAdmin(user),
				/** env = 서버 설정 계정(비밀번호를 앱에서 못 바꾼다), db = 가입 계정 */
				source: d.accounts.sourceOf(user),
			}),
		},
		{
			path: (p) => p.startsWith("/api/me/") || p.startsWith("/api/admin/"),
			handle: ({ req, path, user }) => handleAccounts(req, path, user, d.accounts, d.issueToken),
		},
	];
}

async function telegramTest(d: AdminApiDeps, user: string): Promise<unknown> {
	const token = d.notifier.userSecret(TELEGRAM_TOKEN, user);
	if (!token) return { ok: false, message: "봇 토큰을 먼저 저장하세요 (@BotFather → /newbot)" };
	if (!isBotToken(token)) return { ok: false, message: "봇 토큰 모양이 아닙니다 — 숫자:영문 형태의 토큰 전체를 붙여 넣으세요" };
	// 명령 수신(getUpdates 롱 폴링)과 채팅 찾기가 겹치면 409 — 테스트 동안 멈췄다가 끝나면 다시
	d.telegramBots.refresh(user, { suspend: true });
	try {
		const bot = await getBotName(token);
		let chat = d.notifier.userSecret(TELEGRAM_CHAT, user);
		let found = "";
		// 봇 자신의 id 를 넣은 경우 (웹 텔레그램 주소창의 숫자가 봇 id 다) — 무시하고 다시 찾는다
		const wrongChat = chat === botIdOf(token);
		if (!chat || wrongChat) {
			const hit = await findPrivateChat(token);
			if (!hit) {
				const why = wrongChat ? "채팅 id 칸에 봇 자신의 id 가 들어 있습니다. " : "";
				return {
					ok: false,
					message:
						`${why}텔레그램에서 ${bot} 에게 아무 메시지나 보낸 뒤 다시 눌러 주세요. ` +
						"그래도 안 되면 이 봇을 다른 프로그램이 읽고 있는 것입니다 — 채팅 id 에 내 계정 id(@userinfobot 이 알려 준다)를 직접 넣으세요.",
				};
			}
			await d.secrets.set(TELEGRAM_CHAT, hit.id, user);
			chat = hit.id;
			found = ` → ${hit.name}`;
		}
		await sendMessage(token, chat, "✅ <b>AlphaFolio 알림이 연결됐습니다</b>\n감시·체결 결과를 여기로 보냅니다.");
		return { ok: true, message: `연결됨 · ${bot}${found}`, items: d.secrets.status(user) };
	} catch (err) {
		return { ok: false, message: err instanceof TelegramError ? err.message : String(err) };
	} finally {
		d.telegramBots.refresh(user);
	}
}
