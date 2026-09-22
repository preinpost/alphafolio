/**
 * 네이버 뉴스 검색 — 국내 증권·종목 뉴스.
 *
 * pi-naver-news 확장을 쓰지 않고 직접 구현한 이유: 그 확장은 키를 `process.env` 에서
 * 읽어 **프로세스 전역**이다. 우리는 키를 사용자별로 저장하므로 같은 문제(§15)가 재발한다.
 *
 * 모드 (2026-07-31 개발자센터 신규 신청 종료 이후):
 *   - hub (기본): NAVER API HUB — naverapihub.apigw.ntruss.com,
 *     X-NCP-APIGW-API-KEY-ID / X-NCP-APIGW-API-KEY (NCP 콘솔 발급)
 *   - legacy: 개발자센터 키 — openapi.naver.com, X-Naver-Client-Id/Secret
 *     (2026-07-31 이전 발급분만 2027-06-30까지)
 */

export interface NaverCredentials {
	clientId: string;
	clientSecret: string;
	/** hub(기본) | legacy — 키 발급처가 다르면 엔드포인트·헤더가 달라진다. */
	mode?: "hub" | "legacy";
}

export class NaverCredentialsMissingError extends Error {
	constructor() {
		super(
			"네이버 뉴스 키가 없습니다. 설정 화면의 '뉴스' 에서 API Key ID/Secret 을 입력하세요. " +
				"(NCP 콘솔 → NAVER API HUB 구독 → Application 생성)",
		);
		this.name = "NaverCredentialsMissingError";
	}
}

const HUB = {
	base: "https://naverapihub.apigw.ntruss.com",
	path: "/search/v1/news",
	headers: (id: string, secret: string): Record<string, string> => ({
		"X-NCP-APIGW-API-KEY-ID": id,
		"X-NCP-APIGW-API-KEY": secret,
	}),
	extraQuery: { format: "json" } as Record<string, string>,
};

const LEGACY = {
	base: "https://openapi.naver.com",
	path: "/v1/search/news.json",
	headers: (id: string, secret: string): Record<string, string> => ({
		"X-Naver-Client-Id": id,
		"X-Naver-Client-Secret": secret,
	}),
	extraQuery: {} as Record<string, string>,
};

export interface NewsItem {
	title: string;
	summary: string;
	link: string;
	/** ISO 8601 (YYYY-MM-DD) */
	date: string;
	publishedAt: string;
}

/** 네이버는 검색어 강조를 `<b>` 로 감싸고 HTML 엔티티를 그대로 준다 — 화면·프롬프트용으로 정리한다. */
function clean(html: string): string {
	return html
		.replace(/<\/?b>/g, "")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&apos;|&#39;/g, "'")
		.trim();
}

interface RawItem {
	title?: string;
	description?: string;
	link?: string;
	originallink?: string;
	pubDate?: string;
}

export interface NewsOptions {
	/** 가져올 개수 (기본 10, 최대 100) */
	display?: number;
	/** sim=정확도순(기본), date=최신순 */
	sort?: "sim" | "date";
	/**
	 * 최근 N일 이내만. 네이버 API 에 날짜 필터가 없어 **클라이언트에서 거른다**
	 * (그래서 요청 개수보다 결과가 적을 수 있다). 0이면 필터 없음.
	 */
	days?: number;
}

export async function searchNews(
	creds: NaverCredentials,
	query: string,
	opts: NewsOptions = {},
): Promise<NewsItem[]> {
	const cfg = (creds.mode ?? "hub") === "legacy" ? LEGACY : HUB;
	const display = Math.min(Math.max(opts.display ?? 10, 1), 100);

	const url = new URL(cfg.path, cfg.base);
	url.searchParams.set("query", query);
	url.searchParams.set("display", String(display));
	url.searchParams.set("sort", opts.sort ?? "sim");
	for (const [k, v] of Object.entries(cfg.extraQuery)) url.searchParams.set(k, v);

	const res = await fetch(url, { headers: cfg.headers(creds.clientId, creds.clientSecret) });
	const text = await res.text();

	let json: { items?: RawItem[]; errorMessage?: string; error?: { message?: string } };
	try {
		json = JSON.parse(text) as typeof json;
	} catch {
		throw new Error(`네이버 뉴스 응답을 파싱할 수 없습니다 (HTTP ${res.status}): ${text.slice(0, 200)}`);
	}

	if (!res.ok) {
		// 평면형 { errorMessage } 과 중첩형 { error: { message } } 둘 다 온다
		const msg = json.errorMessage ?? json.error?.message ?? text.slice(0, 200);
		throw new Error(`네이버 뉴스 검색 실패 (HTTP ${res.status}): ${msg}`);
	}

	const cutoff = opts.days && opts.days > 0 ? Date.now() - opts.days * 86_400_000 : null;
	const out: NewsItem[] = [];

	for (const it of json.items ?? []) {
		const published = it.pubDate ? new Date(it.pubDate) : null;
		const ts = published && !Number.isNaN(published.getTime()) ? published.getTime() : null;
		if (cutoff !== null && ts !== null && ts < cutoff) continue;

		out.push({
			title: clean(it.title ?? ""),
			summary: clean(it.description ?? ""),
			link: it.originallink || it.link || "",
			date: ts !== null ? new Date(ts + 9 * 3600_000).toISOString().slice(0, 10) : "",
			publishedAt: it.pubDate ?? "",
		});
	}

	return out;
}
