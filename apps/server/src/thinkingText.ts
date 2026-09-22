/**
 * 모델이 사고 과정을 본문 텍스트에 섞어 보내는 경우 분리한다.
 *
 * - DeepSeek/Qwen 등: `<think>…</think>`, `<thinking>…</thinking>`
 * - 일부 호환 엔드포인트: `<thought>`, `<redacted_thinking>`
 *
 * 웹챗은 사고 토큰을 사용자에게 노출하지 않는다. 본문에서 태그를 걷어내고
 * thinking 채널 delta는 브로드캐스트하지 않는다.
 */

export type ThinkKind = "text" | "thinking";
export type ThinkPart = { kind: ThinkKind; delta: string };

const TAG = "think(?:ing)?|thought|redacted_thinking";
const OPEN_RE = new RegExp(`<(${TAG})(?:\\s[^>]*)?>`, "i");
const CLOSE_RE = new RegExp(`</(?:${TAG})\\s*>`, "i");

function couldBeThinkTag(tail: string): boolean {
  const t = tail.toLowerCase();
  if (t === "<" || t === "</") return true;
  if (!t.startsWith("<")) return false;
  const body = t.startsWith("</") ? t.slice(2) : t.slice(1);
  if (!body) return true;
  // 속성/공백이 붙은 미완 오프닝 태그 (`<think ` / `<think foo`)
  const name = body.replace(/[\s>].*$/, "");
  return /^(think(?:ing)?|thought|redacted_thinking)/.test(name) ||
    "think".startsWith(name) ||
    "thinking".startsWith(name) ||
    "thought".startsWith(name) ||
    "redacted_thinking".startsWith(name);
}

/** 끝이 미완 think 태그일 수 있으면 그 `<` 위치, 아니면 s.length */
function holdIndex(s: string): number {
  const lt = s.lastIndexOf("<");
  if (lt < 0) return s.length;
  const tail = s.slice(lt);
  if (tail.includes(">")) return s.length;
  return couldBeThinkTag(tail) ? lt : s.length;
}

/**
 * 스트리밍 delta를 text/thinking으로 라우팅. 태그가 청크를 걸쳐 쪼개져도 동작.
 */
export class ThinkTagRouter {
  private inThink = false;
  private hold = "";

  push(delta: string): ThinkPart[] {
    if (!delta && !this.hold) return [];
    let s = this.hold + delta;
    this.hold = "";
    const out: ThinkPart[] = [];

    const emit = (kind: ThinkKind, text: string) => {
      if (text) out.push({ kind, delta: text });
    };

    while (s.length > 0) {
      const holdAt = holdIndex(s);
      if (holdAt < s.length) {
        // 끝의 미완 태그만 보류하고, 앞부분은 태그 파서를 한 번 더 태운다
        // (예: `<think>hidden</th` — `</th`만 hold, `<think>hidden`은 처리)
        this.hold = s.slice(holdAt);
        s = s.slice(0, holdAt);
        if (!s) break;
        continue;
      }

      if (this.inThink) {
        const m = CLOSE_RE.exec(s);
        if (!m || m.index === undefined) {
          emit("thinking", s);
          s = "";
          break;
        }
        emit("thinking", s.slice(0, m.index));
        s = s.slice(m.index + m[0].length);
        this.inThink = false;
        CLOSE_RE.lastIndex = 0;
        continue;
      }

      const m = OPEN_RE.exec(s);
      if (!m || m.index === undefined) {
        emit("text", s);
        s = "";
        break;
      }
      emit("text", s.slice(0, m.index));
      s = s.slice(m.index + m[0].length);
      this.inThink = true;
      OPEN_RE.lastIndex = 0;
    }

    return mergeParts(out);
  }

  /** 메시지 종료 시 미완 버퍼를 현재 모드로 flush */
  flush(): ThinkPart[] {
    if (!this.hold) {
      this.inThink = false;
      return [];
    }
    const kind: ThinkKind = this.inThink ? "thinking" : "text";
    const delta = this.hold;
    this.hold = "";
    this.inThink = false;
    return delta ? [{ kind, delta }] : [];
  }

  reset() {
    this.inThink = false;
    this.hold = "";
  }
}

function mergeParts(parts: ThinkPart[]): ThinkPart[] {
  const out: ThinkPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.kind === p.kind) last.delta += p.delta;
    else out.push({ ...p });
  }
  return out;
}

/** 완성된 문자열에서 think 태그 구간을 걷어낸 본문만 반환 */
export function stripThinkTags(input: string): string {
  const router = new ThinkTagRouter();
  const parts = [...router.push(input), ...router.flush()];
  return parts
    .filter((p) => p.kind === "text")
    .map((p) => p.delta)
    .join("")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

// ---------------------------------------------------------------------------
// 태그 없는 사고 독백 (DeepSeek 등이 thinking 채널 대신 본문에 씀)
// ---------------------------------------------------------------------------

const COT_OPENER =
  /^(?:the user\b|wait\b|actually\b|hmm\b|let me\b|let's\b|i need to\b|i['’]ll\b|i will\b|first(?:\s+i|\s*,|\s+let)\b|so(?:,)?\s+(?:the user|let me|i need)\b|looking at\b|ok(?:ay)?[,.]?\s+let me\b|this is\b.{0,80}\b(?:request|skill))/i;

const COT_PLAN =
  /\b(?:let me (?:check|start|read|use|get|also|confirm|do|be|try|look|see)|need to (?:check|find|get|use|read)|be efficient|skill (?:first|approach)|related research)\b/i;

const TOOL_ID =
  /\b(?:broker_price|broker_chart|market_status|toss_[a-z][a-z0-9_]*|kis_[a-z][a-z0-9_]*|naver_news_search|finnhub_[a-z][a-z0-9_]*|twelve_[a-z][a-z0-9_]*|coingecko_[a-z][a-z0-9_]*|binance_[a-z][a-z0-9_]*|web_access|kis-stock-research|kis-sector-research|kis-timing|kis-trading|binance-trading)\b/;

function latinRatio(s: string): number {
  const letters = s.replace(/[^A-Za-z가-힣]/g, "");
  if (!letters) return 0;
  return letters.replace(/[^A-Za-z]/g, "").length / letters.length;
}

export function isCotChunk(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (COT_OPENER.test(t)) return true;
  const latin = latinRatio(t);
  if (TOOL_ID.test(t) && latin >= 0.35) return true;
  if (COT_PLAN.test(t) && latin >= 0.45) return true;
  return false;
}

/** 문장/줄 단위로 쪼개되 구분자는 청크에 붙인다 */
function splitChunks(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j < s.length) {
      const ch = s[j]!;
      if (ch === "\n") {
        j += 1;
        while (j < s.length && s[j] === "\n") j += 1;
        break;
      }
      if ((ch === "." || ch === "!" || ch === "?" || ch === "。") && (j + 1 >= s.length || /\s/.test(s[j + 1]!))) {
        j += 1;
        while (j < s.length && /[ \t]/.test(s[j]!)) j += 1;
        break;
      }
      j += 1;
    }
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

function isCompleteChunk(c: string): boolean {
  return /(?:[\n.!?。]\s*)$/.test(c);
}

function collapseBlanks(s: string): string {
  return s.replace(/[^\S\n]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\s+/, "").replace(/\s+$/, "");
}

/** 태그 없는 사고 독백 문장을 본문에서 제거 */
export function stripCotText(input: string): string {
  if (!input) return "";
  let out = "";
  for (const c of splitChunks(input)) {
    if (!isCotChunk(c)) out += c;
  }
  return collapseBlanks(out);
}

/** think 태그 + 사고 독백을 모두 걷어낸 사용자 표시용 본문 */
export function sanitizeAssistantText(input: string): string {
  return stripCotText(stripThinkTags(input));
}

/** 스트리밍 중 문장이 완성되기 전에 독백을 내보내지 않는다 */
export class CotStreamFilter {
  private buf = "";

  push(delta: string): string {
    if (!delta) return "";
    this.buf += delta;
    const chunks = splitChunks(this.buf);
    if (chunks.length === 0) return "";
    let out = "";
    let rest = "";
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      const isLast = i === chunks.length - 1;
      if (isLast && !isCompleteChunk(c)) {
        rest = c;
        break;
      }
      if (!isCotChunk(c)) out += c;
    }
    this.buf = rest;
    return out;
  }

  flush(): string {
    const s = this.buf;
    this.buf = "";
    if (!s || isCotChunk(s)) return "";
    return s;
  }

  reset() {
    this.buf = "";
  }
}
