/**
 * 사용자별 시크릿 저장소 — 앱에서 키를 입력받아 D1에 암호화해 보관한다.
 *
 * 왜 필요한가: 브로커 키를 env로 주면 프로세스 전역이라 사람마다 다른 증권 계정을
 * 쓸 수 없다. 이것이 원래 사람 수만큼 컨테이너를 띄우게 만든 근본 원인이다 (PLAN.md §15).
 *
 * 저장 위치 = D1 (`user_secrets` 테이블):
 *   - D1 접속 정보 자체는 **서버 env** 로만 받는다. 앱에서 D1 설정을 입력받는 구조는
 *     "DB가 있어야 앱이 도는데 그 DB 설정을 앱에서 넣는" 닭-달걀이 된다.
 *   - 가계부와 같은 DB를 쓰므로 저장소가 파일과 D1로 갈라지지 않는다
 *     (`/data` 볼륨에는 대화 세션만 남는다).
 *
 * 값은 **행 단위로** AES-256-GCM 암호화하며 키는 AF_AUTH_SECRET 에서 HKDF 로 파생한다.
 * (env 에 남는 시크릿은 마스터 하나 — 나머지는 그것이 감싼다)
 *
 * 해석 우선순위: 사용자별 저장값 > process.env > 없음
 * **화이트리스트 밖의 이름은 저장하지 않는다.** 임의 이름을 허용하면 PATH·NODE_OPTIONS
 * 같은 값을 앱에서 심을 수 있어 원격 코드 실행 통로가 된다.
 * 읽기 API는 원문을 절대 돌려주지 않는다 (설정 여부 + 마스킹된 미리보기만).
 */
import { d1Query, type D1Config } from "@alphafolio/ledger";
import { decryptValue, deriveKey, encryptValue } from "./crypto.ts";

// ── 카탈로그 ────────────────────────────────────────────────────────────

export interface SecretSpec {
	/** env 이름 그대로 쓴다 — 기존 pi-* 패키지가 이 이름을 하드코딩으로 읽는다 */
	name: string;
	label: string;
	group: string;
	hint?: string;
}

/**
 * 저장 가능한 키 목록. 전부 **사용자별**이다.
 * (가계부 D1 은 서버 env 전용이므로 여기 없다)
 */
export const SECRET_CATALOG: readonly SecretSpec[] = [
	{ name: "KIS_APP_KEY", label: "한국투자 App Key", group: "증권 (KIS)" },
	{ name: "KIS_APP_SECRET", label: "한국투자 App Secret", group: "증권 (KIS)" },
	{ name: "KIS_ACCOUNT_NO", label: "한국투자 계좌번호", group: "증권 (KIS)" },

	{ name: "TOSS_CLIENT_ID", label: "토스증권 Client ID", group: "증권 (토스)" },
	{ name: "TOSS_CLIENT_SECRET", label: "토스증권 Client Secret", group: "증권 (토스)" },

	// 입력하면 내 계정으로 과금된다. 비워두면 서버 기본 로그인(auth.json·env)을 쓴다.
	{ name: "OPENROUTER_API_KEY", label: "OpenRouter API 키", group: "LLM", hint: "비우면 서버 기본 계정" },
	{ name: "ANTHROPIC_API_KEY", label: "Anthropic API 키", group: "LLM", hint: "비우면 서버 기본 계정" },

	// 해외·코인 데이터 (data_find·data_call, PLAN §35) — 사용자별
	{ name: "FINNHUB_API_KEY", label: "Finnhub API 키", group: "데이터 (해외)", hint: "finnhub.io 무료 가입 → Dashboard" },
	{ name: "TWELVE_API_KEY", label: "Twelve Data API 키", group: "데이터 (해외)", hint: "twelvedata.com 무료 가입 (분당 8회)" },
	{ name: "COINGECKO_API_KEY", label: "CoinGecko Demo API 키", group: "데이터 (해외)", hint: "없어도 공개 한도로 동작" },
	{
		name: "BINANCE_API_KEY",
		label: "Binance API Key",
		group: "코인 (Binance)",
		hint: "⚠️ 출금 권한 없이 발급 (조회·현물 거래만). 시세는 키 없이도 된다",
	},
	{ name: "BINANCE_API_SECRET", label: "Binance Secret Key", group: "코인 (Binance)" },
	{ name: "BINANCE_ENV", label: "Binance 환경", group: "코인 (Binance)", hint: "testnet 이라고 넣으면 테스트넷, 비우면 실계좌" },
	{
		name: "NCP_APIGW_API_KEY_ID",
		label: "네이버 API Key ID",
		group: "뉴스 (네이버)",
		hint: "NCP 콘솔 → NAVER API HUB 구독 → Application",
	},
	{ name: "NCP_APIGW_API_KEY", label: "네이버 API Key", group: "뉴스 (네이버)" },

	// 알림 채널 (PLAN §40) — 사용자마다 자기 봇. 서버 env 값은 쓰지 않는다 (notify/index.ts)
	{ name: "TELEGRAM_BOT_TOKEN", label: "텔레그램 봇 토큰", group: "알림 (텔레그램)", hint: "@BotFather → /newbot" },
	{ name: "TELEGRAM_CHAT_ID", label: "텔레그램 채팅 id", group: "알림 (텔레그램)", hint: "비우면 연결 테스트 때 자동으로 찾는다" },
];

/** LLM 키 시크릿 → pi 프로바이더 ID. 여기 없는 LLM 키는 런타임에 전달되지 않는다. */
export const LLM_SECRET_PROVIDERS: Readonly<Record<string, string>> = {
	OPENROUTER_API_KEY: "openrouter",
	ANTHROPIC_API_KEY: "anthropic",
};

const BY_NAME = new Map(SECRET_CATALOG.map((s) => [s.name, s]));

export function specFor(name: string): SecretSpec | undefined {
	return BY_NAME.get(name);
}

// ── 암호화 ──────────────────────────────────────────────────────────────

const HKDF_INFO = "user-secret-value";

// ── 스토어 ──────────────────────────────────────────────────────────────

export type SecretSource = "user" | "env" | "none";

export interface SecretStatus extends SecretSpec {
	source: SecretSource;
	/** 마스킹된 미리보기. 원문은 어떤 경우에도 내보내지 않는다. */
	preview: string | null;
}

function mask(value: string): string {
	if (value.length <= 8) return "••••";
	return `${value.slice(0, 4)}••••${value.slice(-2)}`;
}

export class SecretStore {
	private readonly key: Buffer;
	private readonly d1: () => D1Config;
	/**
	 * 메모리 캐시 — 브로커 툴이 동기로 값을 읽어야 하므로 기동 시 한 번 적재하고
	 * 쓰기마다 갱신한다. D1 왕복을 매 호출마다 하지 않는 이유이기도 하다.
	 */
	private cache = new Map<string, Map<string, string>>();
	private loaded = false;
	/** 복호화 실패한 행 수 — 마스터 키가 바뀐 경우 진단용 */
	private undecryptable = 0;

	readonly ephemeralMaster: boolean;

	constructor(d1: () => D1Config, masterSecret: string, ephemeralMaster: boolean) {
		this.d1 = d1;
		this.key = deriveKey(masterSecret, HKDF_INFO);
		this.ephemeralMaster = ephemeralMaster;
	}

	/** 기동 시 1회 적재. D1 미설정이면 조용히 비활성 상태로 둔다. */
	async load(): Promise<void> {
		const rows = await d1Query<{ member: string; name: string; value_enc: string }>(
			this.d1(),
			"SELECT member, name, value_enc FROM user_secrets",
		);

		const next = new Map<string, Map<string, string>>();
		let failed = 0;
		for (const row of rows.results) {
			try {
				const value = decryptValue(row.value_enc, this.key);
				const bucket = next.get(row.member) ?? new Map<string, string>();
				bucket.set(row.name, value);
				next.set(row.member, bucket);
			} catch {
				failed += 1;
			}
		}

		this.cache = next;
		this.loaded = true;
		this.undecryptable = failed;

		if (failed > 0) {
			console.warn(
				`[secrets] ${failed}건을 복호화하지 못했습니다. AF_AUTH_SECRET 이 바뀌었을 가능성이 큽니다.\n` +
					`          해당 키는 '미설정'으로 보이며, 새 값을 저장하면 덮어씁니다.`,
			);
		}
	}

	get ready(): boolean {
		return this.loaded;
	}

	get failedCount(): number {
		return this.undecryptable;
	}

	/** 값 해석 — 사용자별 저장값 > process.env. 동기 호출(캐시 기반). */
	get(name: string, user: string): string | undefined {
		const stored = this.cache.get(user)?.get(name);
		if (stored) return stored;
		const env = process.env[name];
		return env && env.trim() !== "" ? env : undefined;
	}

	sourceOf(name: string, user: string): SecretSource {
		if (this.cache.get(user)?.get(name)) return "user";
		const env = process.env[name];
		return env && env.trim() !== "" ? "env" : "none";
	}

	async set(name: string, value: string, user: string): Promise<void> {
		if (!specFor(name)) throw new Error(`저장할 수 없는 키입니다: ${name}`);
		if (value.trim() === "") throw new Error("값이 비어 있습니다");

		await d1Query(
			this.d1(),
			`INSERT INTO user_secrets (member, name, value_enc, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(member, name) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
			[user, name, encryptValue(value, this.key), new Date().toISOString()],
		);

		const bucket = this.cache.get(user) ?? new Map<string, string>();
		bucket.set(name, value);
		this.cache.set(user, bucket);
	}

	async remove(name: string, user: string): Promise<boolean> {
		if (!specFor(name)) return false;
		const r = await d1Query(this.d1(), "DELETE FROM user_secrets WHERE member = ? AND name = ?", [user, name]);
		this.cache.get(user)?.delete(name);
		return (r.meta.changes ?? 0) > 0;
	}

	/** 카탈로그 전체의 설정 상태. 원문은 포함하지 않는다. */
	status(user: string): SecretStatus[] {
		return SECRET_CATALOG.map((spec) => {
			const source = this.sourceOf(spec.name, user);
			const value = source === "none" ? undefined : this.get(spec.name, user);
			return { ...spec, source, preview: value ? mask(value) : null };
		});
	}
}
