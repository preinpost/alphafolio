# AlphaFolio 컨테이너
#
# 리버스 프록시 뒤에 두는 전제 (TLS·도메인은 프록시 담당, 컨테이너는 평문 HTTP).
#
# 빌드 스텝이 있는 것은 웹(Vite)뿐이다. 서버·패키지는 Node 24 타입 스트리핑으로
# .ts 를 그대로 실행하므로 트랜스파일하지 않는다.
#
#   docker build -f infra/Dockerfile -t alphafolio:local .
#   docker compose -f infra/compose.yaml up -d

# ── 1단계: 웹 빌드 ──────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS web

WORKDIR /build
RUN corepack enable

# 의존성 해석에 필요한 매니페스트만 먼저 복사 (레이어 캐시)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/ledger/package.json packages/ledger/
COPY packages/agent/package.json packages/agent/
COPY packages/broker/package.json packages/broker/
COPY packages/mcp/package.json packages/mcp/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @alphafolio/web build

# ── 2단계: 런타임 ───────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

# non-root. node:24 이미지에 uid 1000(node)이 이미 있으므로 1001을 쓴다
# (기존 컨테이너 작업에서 uid 충돌로 권한 거부를 겪은 부분 — CONTAINER-DESIGN.md §3-6)
RUN useradd -u 1001 -m -s /usr/sbin/nologin alpha

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/ledger/package.json packages/ledger/
COPY packages/agent/package.json packages/agent/
COPY packages/broker/package.json packages/broker/
COPY packages/mcp/package.json packages/mcp/
COPY apps/server/package.json apps/server/

# 런타임 의존성만 (웹 빌드 도구 제외)
RUN pnpm install --frozen-lockfile --prod --filter @alphafolio/server...

COPY packages/ packages/
COPY apps/server/ apps/server/
COPY --from=web /build/apps/web/dist apps/web/dist

# 에이전트 설정 — models.json(라우팅 가드) + settings.json(확장 목록) + 확장 패키지.
# 읽기 전용이면 되므로 볼륨(/data)과 분리한다.
COPY agent-config/ /app/agent-config/

# pi 확장 설치 (web_search·fetch_content 등). pi 는 <agentDir>/npm/node_modules 에서 찾는다.
# 락파일이 커밋돼 있어 빌드가 재현 가능하다.
RUN cd /app/agent-config/npm && npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# 세션·에이전트 상태 (볼륨 마운트 지점).
# 가계부 데이터는 D1(원격)에 있으므로 이 볼륨에는 대화 이력만 들어간다.
ENV AF_DATA_DIR=/data
RUN mkdir -p /data && chown -R 1001:1001 /data /app

USER 1001

ENV NODE_ENV=production \
    AF_HOST=0.0.0.0 \
    AF_PORT=8080 \
    AF_WEB_DIR=/app/apps/web/dist \
    AF_AGENT_DIR=/app/agent-config \
    PI_CODING_AGENT_DIR=/app/agent-config

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/src/index.ts"]
