/**
 * 알림 모듈 (PLAN §40) — 트리거·체결기는 `notify(user, msg)` 만 부른다. 채널은 모른다.
 *
 * 채널은 사용자가 설정에서 켠 것만. 지금은 텔레그램 하나 (iOS APNs 는 TestFlight 때).
 * 채널 실패는 던지지 않고 결과로 돌려준다 — 알림이 실패했다고 체결 결과가 바뀌면 안 된다.
 *
 * ⚠️ 자격증명은 **사용자가 직접 저장한 값만** 쓴다. SecretStore.get 은 서버 env 로 대체되는데,
 *    env 에 봇 토큰·채팅 id 가 있으면 모든 사람의 알림이 한 채팅으로 간다.
 */
import type { SecretStore } from "../secrets.ts";
import { escapeHtml, sendMessage, TelegramError, type TelegramDeps } from "./telegram.ts";

export type NotifyLevel = "info" | "important";

export interface NotifyMessage {
	level: NotifyLevel;
	/** 한 줄 제목 — 예: "ETH 손절 체결" */
	title: string;
	/** 본문 줄들 — 잔고·평가금액은 넣지 않는다 (외부 서버를 거친다) */
	lines?: string[];
	/** 앱 안 경로 (예: /c/<대화id>) — AF_PUBLIC_URL 이 있으면 링크로 붙인다 */
	path?: string;
}

export interface ChannelResult {
	channel: "telegram";
	ok: boolean;
	error?: string;
}

export const TELEGRAM_TOKEN = "TELEGRAM_BOT_TOKEN";
export const TELEGRAM_CHAT = "TELEGRAM_CHAT_ID";

export interface NotifierOptions {
	secrets: Pick<SecretStore, "get" | "sourceOf">;
	publicUrl: string | undefined;
	telegram?: TelegramDeps;
}

export class Notifier {
	private readonly opts: NotifierOptions;

	constructor(opts: NotifierOptions) {
		this.opts = opts;
	}

	/** 사용자가 직접 저장한 값만 (env 대체 없음) */
	userSecret(name: string, user: string): string | undefined {
		return this.opts.secrets.sourceOf(name, user) === "user" ? this.opts.secrets.get(name, user) : undefined;
	}

	/** 켜진 채널 — 설정 화면·트리거 준비 때 "알림 받을 곳이 없다" 안내에 쓴다 */
	channels(user: string): Array<"telegram"> {
		return this.userSecret(TELEGRAM_TOKEN, user) && this.userSecret(TELEGRAM_CHAT, user) ? ["telegram"] : [];
	}

	async notify(user: string, msg: NotifyMessage): Promise<ChannelResult[]> {
		const out: ChannelResult[] = [];
		const token = this.userSecret(TELEGRAM_TOKEN, user);
		const chat = this.userSecret(TELEGRAM_CHAT, user);
		if (token && chat) {
			try {
				await sendMessage(token, chat, this.format(msg), this.opts.telegram);
				out.push({ channel: "telegram", ok: true });
			} catch (err) {
				const error = err instanceof TelegramError ? err.message : String(err);
				console.warn(`[notify] 텔레그램 실패 user=${user}: ${error}`);
				out.push({ channel: "telegram", ok: false, error });
			}
		}
		return out;
	}

	/** 텔레그램 HTML — 제목 굵게, 본문 줄, 앱 링크 */
	format(msg: NotifyMessage): string {
		const head = `${msg.level === "important" ? "🔔 " : ""}<b>${escapeHtml(msg.title)}</b>`;
		const body = (msg.lines ?? []).map(escapeHtml);
		const link = msg.path && this.opts.publicUrl ? [`<a href="${escapeHtml(`${this.opts.publicUrl}${msg.path}`)}">AlphaFolio 에서 보기</a>`] : [];
		return [head, ...body, ...link].join("\n");
	}
}
