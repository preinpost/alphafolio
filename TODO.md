# TODO

기능 개발은 `stock_research`(dda3029)에서 일단 멈춤. 설계·배경은 PLAN.md 해당 절 참고.

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

- [ ] Docker 이미지 실제 빌드 확인 — 확장 설치 단계(`agent-config/npm` 의 `npm ci`) 추가 후 한 번도 안 돌려봄
- [ ] 컨테이너 안 pi auth 경로 확정 (`AF_PI_AUTH_PATH` / 마운트)
- [ ] 스모크의 `web_search` 를 실제 검색으로

## 공개 전

- [x] LICENSE (MIT)
- [ ] README·PLAN 공개 관점 재검토 (운영 정보 노출 여부)
- [x] 푸시 직전 시크릿 스캔 재실행 + 실계좌 보유·손익 수치를 히스토리에서 제거 — 양성 대조군을 넣어 스캔이 실제로 도는지 확인 (macOS xargs 에 -a 가 없어 첫 스캔이 빈손이었음)
- [ ] spike 가 남긴 예산 테스트 행 삭제

## 사람 손 (사용자)

- [ ] 토스 실주문 검증 — 장외 지정가 주문 → 취소, 이후 1주 체결 (PLAN §18)
- [ ] 네이버 뉴스 키 입력 → `market_news` / `stock_research` 뉴스 섹션 실측
