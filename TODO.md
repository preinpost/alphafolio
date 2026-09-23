# TODO

기능 개발은 `stock_research`(dda3029)에서 일단 멈춤. 설계·배경은 PLAN.md 해당 절 참고.

## 계정 (PLAN §23)

- [x] 가계부 분리 · 멤버 · 초대 (마이그레이션 0006)
- [ ] **회원가입** — D1 `users`, `AF_SIGNUP_CODE`, ID 형식·비밀번호 길이·시도 제한, 가입 즉시 로그인. 기존 AF_USERS 계정 유지
- [ ] 토큰 무효화 — 사용자별 `token_version` (비밀번호 변경·모든 기기 로그아웃)
- [ ] 비밀번호 변경, 관리자 재설정 코드 (`AF_ADMINS`)
- [ ] 2FA(TOTP) — 완전 선택, 복구 코드
- [ ] 받은 초대 배지를 사이드바·탭에 — 지금은 가계부 화면 맨 위 카드뿐
- [ ] 가계부 화면 실제 조작 확인 (웹·iOS) — 타입·빌드만 확인, 화면은 사람 손
- [ ] `transactions.dedupe_key` 가 전역 UNIQUE — 가계부 간 충돌 가능. 임포트를 만들 때 `(ledger_id, dedupe_key)` 로
- [ ] 구 데이터(`budgets_legacy` 1행, spike 잔여) 삭제

## 대화 (PLAN §24)

- [x] 서버: 대화별 세션, 백그라운드 응답, /api/sessions
- [x] 웹: `/c/<id>` 주소, 사이드바 대화 목록 (응답 중·새 답 표시)
- [ ] 툴 진행 문구(flavor line) 불일치 — ledger_add 에 "종목 목록을 훑어봤어요" 가 붙음
- [ ] 대화 이름 바꾸기·삭제, 서버 재시작 시 진행 중이던 응답은 사라짐 (재개 불가)
- [ ] 백그라운드 완료 푸시 알림 (iOS 푸시 작업 때)

## 이미지 첨부

- [x] 서버: 검증(최대 4장·4MB·매직 바이트), 모델 직접 전달, 못 읽는 모델이면 미리 거절, 이미지 속 지시 무시 규칙
- [x] 웹: 첨부 버튼·붙여넣기·끌어놓기, 1600px JPEG 축소, 말풍선에 첨부 표시
- [ ] iOS 실기기에서 카메라·사진 선택 확인 (권한 문구는 Info.plist 에 추가됨)
- [ ] 매 message_end 가 대화 전체(이미지 base64 포함)를 다시 보낸다 — 이미지가 많아지면 참조 URL 방식으로
- [ ] 스모크 5회 중 1회 실패 — 어느 항목인지 못 잡음 (LLM 응답 의존 항목으로 추정)

## 기능 (보류)

- [ ] **`monthly_report(month)`** — 스킬 툴화의 마지막 (PLAN §21)
  - 가계부: 월 합계, 전월 대비, 카테고리 증감, 예산 대비 — 지금 바로 가능
  - 투자 손익: `SnapshotStore.onOrBefore` 로 월초 기준값 조회. 스냅샷은 2026-09-23 16시부터 쌓이므로
    월초 기준값은 10월 이후 생긴다 → 없으면 "기준 데이터 없음"을 명시하는 구조로
- [ ] 툴 수 관리 — 현재 23개. 더 늘리기 전에 통합 검토
- [ ] `market_timing` 손익비 기준(현재 1.0) — 실사용 후 조정 여부 판단
- [ ] KIS 주문 — hashkey, tr_id 분기 (국내 TTTC0011U/0012U, 해외 TTTT1002U/1006U + 거래소별), 모의계좌로 먼저
- [ ] 토스 정정 주문, OCO 조건주문
- [ ] 사용자별 MCP 서버 설정

## iOS 앱 (Phase 5, PLAN §22)

- [ ] 시뮬레이터에서 실제 로그인 → 채팅·카드·주문 확인 카드 흐름 점검 (사람 손 — 입력이 필요)
- [ ] 실제 앱에서 로그인 후 재실행 시 Keychain 토큰 유지 확인, 로그아웃 시 삭제 확인
- [ ] safe area·키보드 — 다른 세션의 `viewport.ts` 작업과 합친 뒤 실기기 확인
- [ ] 앱 아이콘·스플래시 (지금은 Capacitor 기본 이미지)
- [ ] 번들 ID 확정 (현재 `com.alphafolio.app` — 첫 TestFlight 전에만 바꿀 수 있다고 보면 된다)
- [ ] 앱 번들에서 PWA 서비스워커 빼기 — WKWebView 에서 등록이 실패할 뿐 무해하지만 불필요 (`vite.config.ts`)
- [ ] 실기기 — 서명(팀 ID 는 커밋하지 않는다), HTTPS 서버 주소로 빌드 (`task mobile:build API_BASE=https://...`)
- [ ] Face ID 잠금 → 카메라(영수증) → 푸시 순

## 배포 (Phase 4)

- [x] Docker 이미지 실제 빌드 확인 — 로컬 arm64 빌드·기동 OK (툴 22개, 확장 로드, 코딩툴 미노출, uid 1001, healthy).
      `packageManager` 가 없어 corepack 이 pnpm 12 를 받던 것을 11.0.9 로 고정
- [x] GitHub Actions — `ci.yml` (검사 → arm64 이미지 → GHCR) + `bump.yml` (Bump & release, semver)
- [x] GHCR 패키지 공개 — 공개 저장소에 연결돼 public 으로 생성됨 (익명 pull 확인)
- [ ] iOS 앱 버전(MARKETING_VERSION)을 package.json 버전과 맞출지 — TestFlight 때 결정
- [ ] 이미지 1.16GB — `chown -R /app` 레이어가 node_modules 를 통째로 복제한다 (`COPY --chown` 으로 줄일 수 있음)
- [ ] D1 미설정 서버에서 스냅샷 스케줄러가 기동 때마다 "실패" 로그를 찍는다 — 브로커 미설정처럼 조용히 건너뛰기
- [ ] 컨테이너 안 pi auth 경로 확정 (`AF_PI_AUTH_PATH` / 마운트)
- [ ] 스모크의 `web_search` 를 실제 검색으로

## 공개 전

- [x] LICENSE (MIT)
- [ ] README·PLAN 공개 관점 재검토 (운영 정보 노출 여부)
- [x] 푸시 직전 시크릿 스캔 재실행 + 실계좌 보유·손익 수치를 히스토리에서 제거 — 양성 대조군을 넣어 스캔이 실제로 도는지 확인 (macOS xargs 에 -a 가 없어 첫 스캔이 빈손이었음)
- [x] spike 가 남긴 예산 테스트 행 — 0006 에서 `budgets_legacy` 로 격리됨 (spike 02 는 이제 전용 가계부를 만들고 지운다)

## 사람 손 (사용자)

- [ ] 토스 실주문 검증 — 장외 지정가 주문 → 취소, 이후 1주 체결 (PLAN §18)
- [ ] 네이버 뉴스 키 입력 → `market_news` / `stock_research` 뉴스 섹션 실측
