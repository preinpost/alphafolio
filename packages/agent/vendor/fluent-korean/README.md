# fluent-korean (vendored)

- 출처: https://github.com/snflkd/fluent-korean — `plugins/fluent-korean/output-styles/fluent-korean-not-coding.md`
- 커밋: ce8683f0eba8cddb91de4dcd151425ff73e60498 (2026-08-23)
- 라이선스: MIT (같은 폴더의 LICENSE)

에이전트 답변의 한국어 문장 지침으로 시스템 프롬프트 끝에 **원문 그대로** 붙인다 (`src/style.ts`).
원문이 요약을 권하지 않는다 — 조항마다 붙은 예시가 빠지면 지침이 잘 지켜지지 않는다.
pi 스킬로 켜지 않는 이유: 스킬은 끄고(`noSkills`) `read` 툴도 막아 두었다 (PLAN §21).

갱신할 때는 파일을 통째로 바꾸고 위 커밋을 고친다. 내용을 손으로 고치지 않는다.
