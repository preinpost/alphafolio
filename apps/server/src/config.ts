/**
 * 설정 — 전부 env에서 온다 (PLAN.md §6).
 *   로컬: 저장소 루트 .env
 *   배포: compose.yaml 의 environment
 *
 * 브로커 키 이름은 기존 pi-* 패키지가 하드코딩으로 읽으므로 여기서 다루지 않는다.
 * (KIS_APP_KEY 등은 process.env 그대로 패키지에 전달)
 */
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCorsOrigins } from "./cors.ts";
import { parseThinkingLevel, type ThinkingLevel } from "@alphafolio/agent";

/** 저장소 루트 (apps/server/src → ../../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** 루트 .env 를 process.env 에 병합한다. 이미 설정된 값이 우선. */
export function loadDotEnv(): string | null {
	const file = join(REPO_ROOT, ".env");
	if (!existsSync(file)) return null;

	for (const raw of readFileSync(file, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = value;
	}
	return file;
}

export interface Config {
	host: string;
	port: number;
	auth: {
		/** 슈퍼관리자 (AF_ADMIN_USER) — 초대 코드 발급·계정 관리. 다른 사용자는 가입으로 들어온다 */
		admin: string;
		adminPassword: string;
		/** AF_ADMIN_PASSWORD 가 비어 임시 비밀번호를 만들었는가 (기동 로그에 찍는다) */
		generatedPassword: boolean;
		secret: string;
		ephemeralSecret: boolean;
	};
	agent: {
		cwd: string;
		agentDir: string;
		sessionsDir: string;
		model: string | undefined;
		/** AF_DEFAULT_THINKING — 기본 high */
		thinking: ThinkingLevel;
		authPath: string | undefined;
	};
	login: { maxAttempts: number; windowSec: number; lockoutSec: number; trustProxy: boolean };
	/** KIS 실전/모의 — 서버 단위 설정. 모의계좌는 별도 앱키가 필요하다. */
	kisEnv: "real" | "paper";
	/** 유휴 런타임 정리 기준(분). 0이면 정리하지 않는다. */
	idleMinutes: number;
	webDir: string;
	dataDir: string;
	/** iOS 앱(Capacitor) 등 크로스 오리진 클라이언트 허용 목록 (cors.ts) */
	corsOrigins: string[];
	/**
	 * AF_PUBLIC_URL — 사람이 브라우저로 여는 공개 주소 (OAuth redirect_uri 의 기준).
	 * 리버스 프록시 뒤라 Host 헤더로 추측하지 않는다. 없으면 MCP OAuth 연결만 막힌다.
	 */
	publicUrl: string | undefined;
	/** AF_MCP_ALLOW_PRIVATE=1 — MCP 서버 주소에 http·사설 IP 허용 (개발 전용. 공유 서버에서 켜면 SSRF) */
	mcpAllowPrivate: boolean;
}

/**
 * pi 자격증명(auth.json) 위치.
 *
 * PI_CODING_AGENT_DIR 을 우리 agentDir 로 바꾸면(확장 설정을 찾게 하려고) pi 의 기본
 * auth.json 경로도 같이 바뀐다 — 그대로 두면 로컬에서 LLM 로그인이 통째로 안 잡힌다.
 * 그래서 명시적으로 고른다:
 *   1. AF_PI_AUTH_PATH (배포에서 마운트 경로 지정)
 *   2. <agentDir>/auth.json
 *   3. ~/.pi/agent/auth.json — 로컬 개발 편의 (기존 pi 로그인 재사용)
 * 셋 다 없으면 undefined → env API 키로 동작한다.
 */
function hasCredentials(path: string): boolean {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return Object.keys(parsed).length > 0;
	} catch {
		return false;
	}
}

function resolveAuthPath(agentDir: string): string | undefined {
	const explicit = process.env.AF_PI_AUTH_PATH?.trim();
	if (explicit) return explicit;

	for (const candidate of [join(agentDir, "auth.json"), join(homedir(), ".pi", "agent", "auth.json")]) {
		// pi 가 빈 auth.json 을 만들어두는 경우가 있어 "존재"만으로 고르면 안 된다
		// (빈 파일이 진짜 로그인 정보를 가려서 조용히 인증이 깨진다)
		if (existsSync(candidate) && hasCredentials(candidate)) return candidate;
	}
	return undefined;
}

/** 슈퍼관리자 ID 규칙 — 가입 계정과 같다 (accounts.ts NAME_RE) */
const ADMIN_NAME_RE = /^[a-z0-9_]{3,20}$/;

/**
 * 없앤 변수 — 조용히 무시하면 관리자 없이(임시 비밀번호로) 서버가 떠서 로그인이 안 되는 이유를 모르게 된다.
 * 옛 설정이 남아 있으면 무엇으로 바꾸라는 안내와 함께 기동을 거부한다.
 */
const REMOVED_VARS: Record<string, string> = {
	AF_USERS: "AF_ADMIN_USER / AF_ADMIN_PASSWORD (슈퍼관리자 한 명, 평문). 다른 사람은 초대 코드로 가입한다",
	AF_AUTH_USER: "AF_ADMIN_USER",
	AF_AUTH_PASSWORD: "AF_ADMIN_PASSWORD",
};

export function checkRemovedVars(env: NodeJS.ProcessEnv = process.env): void {
	const found = Object.keys(REMOVED_VARS).filter((k) => env[k] !== undefined);
	if (found.length === 0) return;
	throw new Error(
		"더 이상 쓰지 않는 환경변수가 있습니다:\n" +
			found.map((k) => `  ${k} → ${REMOVED_VARS[k]}`).join("\n") +
			"\n설정을 바꾼 뒤 다시 시작하세요.",
	);
}

/** 끝의 / 를 떼고 http(s) origin(+경로)만. 잘못된 값은 기동 거부 — OAuth 가 조용히 엉뚱한 주소로 돌아오지 않게 */
export function parsePublicUrl(raw: string | undefined): string | undefined {
	const v = raw?.trim();
	if (!v) return undefined;
	let url: URL;
	try {
		url = new URL(v);
	} catch {
		throw new Error(`AF_PUBLIC_URL="${v}" — URL 형식이 아닙니다 (예: https://alphafolio.example.com)`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`AF_PUBLIC_URL 은 http(s) 여야 합니다: ${v}`);
	if (url.search || url.hash) throw new Error(`AF_PUBLIC_URL 에 쿼리·해시를 넣지 않습니다: ${v}`);
	return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export function loadConfig(): Config {
	checkRemovedVars();
	const admin = process.env.AF_ADMIN_USER?.trim() || "admin";
	if (!ADMIN_NAME_RE.test(admin)) {
		throw new Error(`AF_ADMIN_USER="${admin}" — 영문 소문자·숫자·_ 3~20자여야 합니다`);
	}
	const password = process.env.AF_ADMIN_PASSWORD?.trim() ?? "";
	const secret = process.env.AF_AUTH_SECRET?.trim() ?? "";

	// 비밀번호·시크릿이 없으면 생성한다. 시크릿이 매 기동 바뀌면 기존 토큰이 무효화되므로
	// 배포 환경에서는 반드시 env로 고정해야 한다 (로그에 경고).
	const generatedPassword = password === "";
	const ephemeralSecret = secret === "";

	const dataDir = process.env.AF_DATA_DIR ?? join(REPO_ROOT, ".data");
	const agentDir = process.env.AF_AGENT_DIR ?? join(REPO_ROOT, "agent-config");

	return {
		host: process.env.AF_HOST ?? "0.0.0.0",
		port: Number(process.env.AF_PORT ?? 8080),
		auth: {
			admin,
			adminPassword: generatedPassword ? randomBytes(12).toString("base64url") : password,
			secret: ephemeralSecret ? randomBytes(32).toString("hex") : secret,
			generatedPassword,
			ephemeralSecret,
		},
		agent: {
			cwd: process.env.AF_AGENT_CWD ?? join(dataDir, "workspace"),
			// 저장소의 agent-config — models.json·settings.json·확장 패키지가 여기 있다.
			// 예전 기본값(.data/agent)은 비어 있어서 models.json 과 확장이 전혀 적용되지 않았다.
			agentDir,
			sessionsDir: process.env.AF_SESSIONS_DIR ?? join(dataDir, "sessions"),
			model: process.env.AF_DEFAULT_MODEL,
			thinking: parseThinkingLevel(process.env.AF_DEFAULT_THINKING),
			authPath: resolveAuthPath(agentDir),
		},
		login: {
			maxAttempts: Number(process.env.AF_LOGIN_MAX_ATTEMPTS ?? 5),
			windowSec: Number(process.env.AF_LOGIN_WINDOW_SEC ?? 300),
			lockoutSec: Number(process.env.AF_LOGIN_LOCKOUT_SEC ?? 900),
			trustProxy: process.env.AF_TRUST_PROXY === "1",
		},
		kisEnv: process.env.AF_KIS_ENV === "paper" ? "paper" : "real",
		idleMinutes: Number(process.env.AF_IDLE_MINUTES ?? 60),
		webDir: process.env.AF_WEB_DIR ?? join(REPO_ROOT, "apps/web/dist"),
		dataDir,
		corsOrigins: parseCorsOrigins(process.env.AF_CORS_ORIGINS),
		publicUrl: parsePublicUrl(process.env.AF_PUBLIC_URL),
		mcpAllowPrivate: process.env.AF_MCP_ALLOW_PRIVATE === "1",
	};
}

