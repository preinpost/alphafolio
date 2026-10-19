---
name: deploy-mini
description: AlphaFolio 를 맥미니(Tailscale)에 배포한다 — GitHub Actions "Bump & release"(patch)로 이미지를 만들고, 맥미니 compose.yaml 의 이미지 태그를 새 버전으로 바꿔 docker compose up -d. "배포해줘", "미니에 올려줘", "새 버전 배포" 같은 요청에 쓴다.
---

# deploy-mini — 맥미니 배포

순서: **로컬 확인 → Bump & release(patch) → 이미지 빌드 완료까지 대기 → 맥미니 SSH(Tailscale 인증) → compose.yaml 태그 교체 → `docker compose up -d` → healthy 확인**

| 항목 | 값 |
| --- | --- |
| 저장소 | `preinpost/alphafolio` (`gh` 로그인 계정 preinpost) |
| 워크플로 | `.github/workflows/bump.yml` — check → bump(커밋 + `v*` 태그) → image(GHCR 푸시 + GitHub Release) |
| 이미지 | `ghcr.io/preinpost/alphafolio:<X.Y.Z>` (앞에 `v` 없음) |
| 서버 | `mini@100.96.242.67` (macOS, Tailscale SSH) |
| 배포 폴더 | `~/dev/alphafolio/compose.yaml` — 서비스 `app` |

규칙:
- **항상 patch 만 올린다.** minor/major 는 사용자가 따로 말할 때만.
- 이미지 job 이 **끝나기 전에** compose 를 올리면 `ghcr.io/...:X.Y.Z: not found` 로 실패한다. 반드시 워크플로 성공을 확인한 뒤 맥미니로 넘어간다.
- 이 맥(로컬)에는 `timeout` 명령이 없다. 기다릴 때는 `sleep` 루프를 쓴다.
- 맥미니의 원격 명령은 `zsh -lc '…'` 로 감싼다 (로그인 셸이어야 PATH 가 잡힌다). 맥미니는 BSD sed — `sed -i ''`.

## 1. 로컬 확인

```bash
git fetch -q origin && git status -sb | head -1 && git status --short
```

- 워크플로는 **GitHub 의 main** 을 빌드한다. `ahead N` 이면 그 커밋은 배포에 안 들어간다 → 푸시할지 사용자에게 물어본다 (묻지 않고 푸시하지 않는다).
- 커밋 안 한 변경이 있으면 배포에 안 들어간다고 알려준다.
- `behind` 면 `git pull --ff-only` 로 맞춘다.

## 2. Bump & release 실행

```bash
gh workflow run bump.yml --repo preinpost/alphafolio --ref main -f kind=patch
sleep 5
gh run list --repo preinpost/alphafolio --workflow bump.yml --event workflow_dispatch --limit 1 \
  --json databaseId,status,createdAt,headSha
```

방금 만든 run 인지 `createdAt`(방금 전)·`headSha`(origin/main) 로 확인하고 `databaseId` 를 RUN_ID 로 쓴다.

## 3. 끝날 때까지 대기 (보통 3분 안팎)

```bash
gh run watch "$RUN_ID" --repo preinpost/alphafolio --exit-status --interval 15 > /tmp/af-bump-watch.log 2>&1; echo "exit=$?"
tail -20 /tmp/af-bump-watch.log
```

- 실패하면 여기서 멈추고 `gh run view "$RUN_ID" --repo preinpost/alphafolio --log-failed | tail -60` 로 원인을 보여준다. 맥미니는 건드리지 않는다.
- 성공하면 새 버전을 읽는다 (`v` 를 뗀다):

```bash
NEW=$(gh release view --repo preinpost/alphafolio --json tagName --jq .tagName | sed 's/^v//'); echo "$NEW"
git pull --ff-only -q   # 릴리스 커밋(chore: release vX.Y.Z)을 로컬에도 받아 둔다
```

## 4. 맥미니 연결 (Tailscale 인증)

연결 하나를 열어 두고(ControlMaster) 이후 명령은 그 연결을 재사용한다 — 인증은 한 번만.

```bash
SOCK=/tmp/af-mini.sock; HOST=mini@100.96.242.67
ssh -fN -o ControlMaster=auto -o ControlPath=$SOCK -o ControlPersist=15m -o ConnectTimeout=15 $HOST \
  > /tmp/af-mini-ssh.log 2>&1 &
for i in $(seq 1 15); do ssh -O check -o ControlPath=$SOCK $HOST 2>/dev/null && break; sleep 1; done
ssh -O check -o ControlPath=$SOCK $HOST; cat /tmp/af-mini-ssh.log
```

- `Master running` 이면 바로 5단계로.
- 아니고 로그에 `# Tailscale SSH requires an additional check.` 와 `https://login.tailscale.com/a/…` 가 있으면: **그 URL 을 사용자에게 보여주고 브라우저에서 인증해 달라고 한 뒤(ask_user 로 "인증 완료"를 받는다)** 다시 `ssh -O check` 로 확인한다. 백그라운드 ssh 는 인증을 기다리고 있으므로 다시 띄우지 않는다.
- 인증 후에도 연결이 안 되면 로그를 보여주고 멈춘다.

이후 원격 명령은 모두:

```bash
ssh -o ControlPath=$SOCK $HOST 'zsh -lc "…"'
```

## 5. compose.yaml 태그 교체 → 올리기

현재 상태부터 본다:

```bash
ssh -o ControlPath=$SOCK $HOST 'zsh -lc "cd ~/dev/alphafolio && grep -n \"image: ghcr\" compose.yaml && docker compose ps --format \"{{.Service}} {{.Image}} {{.Status}}\""'
```

- 실행 중인 이미지 버전이 `NEW` 의 바로 앞 patch 가 아니면(건너뛰었거나 이미 NEW 면) 사용자에게 알려준다. 계속하는 데 문제는 없다.

태그를 바꾸고 올린다 (`$NEW` 는 로컬에서 펼쳐진다):

```bash
ssh -o ControlPath=$SOCK $HOST "zsh -lc 'cd ~/dev/alphafolio \
  && sed -i \"\" -E \"s#(image: ghcr\\.io/preinpost/alphafolio:)[0-9]+\\.[0-9]+\\.[0-9]+#\\1$NEW#\" compose.yaml \
  && grep -n \"image: ghcr\" compose.yaml \
  && docker compose up -d'"
```

grep 결과가 `:$NEW` 인지 확인한다. 아니면 compose.yaml 형식이 바뀐 것 — 멈추고 보여준다.

## 6. 확인 → 정리

컨테이너가 healthy 가 될 때까지 (최대 2분쯤) 본다:

```bash
for i in $(seq 1 24); do
  S=$(ssh -o ControlPath=$SOCK $HOST 'zsh -lc "cd ~/dev/alphafolio && docker compose ps --format \"{{.Image}} {{.Status}}\""')
  echo "$S"; case "$S" in *"$NEW"*"(healthy)"*) break;; esac; sleep 5
done
```

- `(unhealthy)` 이거나 재시작을 반복하면 `docker compose logs --tail 80 app` 을 보여준다. 이전 버전으로 되돌리기는 사용자에게 물어본 뒤에만 한다 (compose.yaml 태그를 이전 버전으로 → `docker compose up -d`).

끝나면 연결을 닫는다:

```bash
ssh -O exit -o ControlPath=$SOCK $HOST
```

보고: `이전 버전 → NEW`, 워크플로 run URL, 컨테이너 상태.
