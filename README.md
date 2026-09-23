# AlphaFolio

pi agent core(SDK)를 임베드한 개인 금융 에이전트 — 투자 분석 + 가계부.

설계 문서: [PLAN.md](PLAN.md)

## 구조

```
apps/server/       node:http + ws, pi 세션 임베드, /api/ledger REST  (런타임 의존성: ws)
apps/web/          React 19 + Vite + Tailwind v4 + Base UI (PWA, 데스크탑·모바일 공용)
packages/agent/    pi SDK 접촉면 격리 — 런타임 생성/교체, persona
packages/broker/   증권 도메인 — KIS·토스 REST(자격증명 주입식)
                   시세·지표·랭킹·뉴스·잔고·주문 툴 + 순수 계산(지표·주문검증)
packages/ledger/   가계부 도메인 — D1 클라이언트·스키마·repo·ledger_* 툴
packages/protocol/ 서버↔클라이언트 공용 타입 (UI 메시지, 카드 계약)
agent-config/      models.json (OpenRouter 라우팅 가드)
infra/             Dockerfile, compose 템플릿
spike/             Phase 0 검증 스크립트
```

**이중 경로**가 핵심이다. 에이전트(자연어)와 REST(화면)가 같은 D1을 본다.

```
              ┌── 에이전트: "어제 김밥천국 8천원" ──┐
  D1 (원장) ←─┤                                    ├─→ 동일 데이터
              └── /api/ledger: 목록·수정·예산 ─────┘
```

증권도 같은 구조다 — 챗(`market_price`/`portfolio_holdings`)과 화면(`/api/portfolio`)이
같은 계좌를 본다. **증권 키는 사용자별**이라 한 서버를 함께 써도 각자 자기 계좌를 쓴다.

## 개발

```bash
task setup              # 의존성 + pi 확장(web_search 등) + .env 생성
task agent:web-config   # (선택) 로컬 pi 의 웹 검색 설정 복사

task dev                # 서버 + 웹 HMR (접속: http://localhost:5173)
task up / down          # 백그라운드 실행·중지 (단일 포트 8080)
task test               # 단위 테스트 (주문 검증·확인 토큰 — 실제 주문 없이)
task check              # 타입체크 + 테스트 + 빌드 + 스모크
```

`agent-config/` 가 pi 에이전트 디렉터리다 — `models.json`(라우팅 가드),
`settings.json`(확장 목록), `npm/node_modules/`(확장 패키지)가 여기 있다.
웹 검색 설정(`web-search.json`)과 `auth.json` 은 시크릿이라 gitignore 대상이다.

빌드 스텝은 웹(Vite)뿐이다. 서버·패키지는 Node 24 타입 스트리핑으로 `.ts`를 직접 실행한다
(`erasableSyntaxOnly` — enum·파라미터 프로퍼티 등 런타임 의미가 있는 TS 문법 금지).

## 배포 (Docker)

```bash
cp infra/compose.example.yaml infra/compose.yaml   # 키 입력 (compose.yaml 은 gitignore)
docker compose -f infra/compose.yaml up -d --build
```

- 리버스 프록시 뒤에 두는 전제다 (TLS·도메인은 프록시 담당, 컨테이너는 평문 HTTP).
- **여러 명이 한 컨테이너를 공유한다.** 계정은 `AF_USERS`(scrypt 해시)로 주고,
  사용자마다 독립 세션을 쓴다. 가계부만 가구 공유(기록자 `member` 로 구분).

```bash
node apps/server/scripts/hash-password.mjs '비밀번호'   # AF_USERS 값 생성
```

### 키 입력

브로커·시세·LLM 키는 **앱 설정 화면에서 입력**한다 (env 는 기본값으로만 쓰인다).

- 증권·LLM 키는 **사용자별** — 같은 서버를 써도 각자 자기 계정을 쓴다
- 가계부 D1 키는 **가구 공용** — 가계부 자체가 공유이기 때문
- 저장 위치는 `/data/secrets.enc` (AES-256-GCM, `AF_AUTH_SECRET` 에서 파생한 키로 암호화)
- 입력한 값은 화면으로 다시 내려오지 않는다 (마스킹만)

> `AF_AUTH_SECRET` 을 바꾸면 저장된 키를 복호화할 수 없다. 반드시 고정할 것.

- `alphafolio-data:/data` 볼륨에 **대화 이력**이 쌓인다. 가계부 데이터는 D1(원격)이라 무관하다.
- `AF_AUTH_SECRET`을 반드시 고정할 것. 비우면 재시작마다 모든 로그인 토큰이 무효화된다.

### LLM 인증 두 가지

| 방식 | 설정 |
|---|---|
| (a) API 키 주입 — 배포 정석 | `OPENROUTER_API_KEY` 등 env |
| (b) 호스트 pi OAuth 재사용 | `auth.json`을 마운트 + `AF_PI_AUTH_PATH` 지정 |

(b)는 서버가 기동 시 auth.json을 쓰기 가능한 `/data`로 복사해서 쓴다 — pi 자격증명 스토어가
파일 옆에 락 디렉터리를 만들기 때문에 읽기 전용 마운트를 직접 쓸 수 없다.

## 스파이크 (Phase 0, 검증 완료)

```bash
pnpm spike:sdk            # pi SDK 인프로세스 세션 + customTool
pnpm spike:d1             # D1 REST 왕복
pnpm spike:agent-ledger   # 자연어 → ledger_* → D1
node spike/00-d1-doctor.ts   # D1 자격증명 진단 (401/403 원인 좁히기)
```

## 환경변수

`.env.example` 참고. 요점:

- `AF_*` — AlphaFolio 자체 설정
- **브로커 키 이름은 변경 금지** (`KIS_APP_KEY`, `TOSS_CLIENT_ID` 등) — 기존 pi-* 패키지가
  이 이름을 하드코딩으로 읽는다
- 모바일(Capacitor) 번들에는 어떤 시크릿도 들어가지 않는다. 앱이 아는 것은 API 기준 URL뿐이다

## 라이선스

[MIT](LICENSE)
