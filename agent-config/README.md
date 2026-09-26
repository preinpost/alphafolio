# agent-config

pi 에이전트 디렉터리에 올라가는 설정. 읽기 전용이면 되므로 데이터 볼륨(`/data`)과 분리한다.

- 컨테이너: `AF_AGENT_DIR=/app/agent-config` (Dockerfile의 `COPY agent-config/ /app/agent-config/`)
- 로컬 개발: `AF_AGENT_DIR` 미지정 시 `.data/agent` 를 쓰므로, 이 설정을 적용하려면
  `AF_AGENT_DIR=./agent-config` 를 `.env` 에 넣는다

## models.json — OpenRouter 라우팅 가드

간헐적으로 잡히는 느린/비싼 프로바이더를 회피한다.
호스트 개발 환경의 `~/.pi/agent/models.json` 과 같은 역할이다.

> `ModelRuntime` 은 에이전트 디렉터리를 자동으로 보지 않는다. `packages/agent/src/runtime.ts` 가
> `modelsPath` 를 명시적으로 넘겨야 이 파일이 적용된다 (PLAN.md §14).

`modelOverrides.compat.openRouterRouting` 객체는 OpenRouter 요청의 `provider` 필드로 그대로
전달된다 (pi `docs/models.md` — Per-model Overrides / openRouterRouting).

| 키 | 의미 |
|---|---|
| `sort: "throughput"` | 처리량 높은 프로바이더 우선 선택 |
| `preferred_min_throughput` | 토큰/초 하한 (p50, 소프트 선호) |
| `preferred_max_latency` | 첫 토큰 지연 상한 초 (p90, 소프트 선호) |
| `max_price` | $/1M 토큰 상한 (하드 필터 — 비싼 프로바이더 배제) |
| `allow_fallbacks: true` | 조건을 만족하는 프로바이더가 없으면 일반 라우팅으로 폴백 (false면 요청 자체가 실패) |

### 주의

- 이 오버라이드는 **openrouter 프로바이더 경유**로 쓸 때만 적용된다
  (`DEEPSEEK_API_KEY` 직결은 해당 없음).
- `AF_DEFAULT_MODEL` 은 `openrouter/openai/gpt-6-luna` 형식(프로바이더/모델)으로 쓴다 — 현재 기본값.
  모델 ID가 유일하면 프로바이더 접두어 없이 `openai/gpt-6-luna` 로 써도 openrouter로 해석된다.
- deepseek 항목들은 기본 모델을 바꿔도 남겨둔다 (UI 모델 선택 대비).
