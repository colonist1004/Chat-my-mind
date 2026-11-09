import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, noteBlock, fill } from "./prompt.js";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (기본 · 가장 똑똑함)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (빠르고 균형)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (가장 빠르고 저렴)" },
];

// 서버 측 거절 대체 모델(fallbacks)을 지원하는 모델
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

/**
 * 캐릭터 답변을 스트리밍합니다.
 * @returns {{ abort: () => void, done: Promise<{ text: string, refused: boolean, truncated: boolean }> }}
 */
export function streamReply({ char, chat, settings, history, onText }) {
  const client = new Anthropic({
    apiKey: settings.apiKey,
    // 사용자가 직접 입력한 본인 키를 본인 기기 브라우저에서만 사용합니다.
    dangerouslyAllowBrowser: true,
  });

  // API 는 user 메시지로 시작해야 하므로, 첫 인사말(assistant)이 맨 앞이면 장면 시작 메시지를 둡니다.
  const messages = history.map((m) => ({ role: m.role, content: m.text }));
  if (messages[0]?.role === "assistant") messages.unshift({ role: "user", content: "(대화 시작)" });

  // 유저 노트는 마지막 user 메시지 앞에 붙입니다.
  const note = noteBlock(chat, char, settings);
  if (note) {
    const last = messages.findLastIndex((m) => m.role === "user");
    if (last >= 0) messages[last] = { ...messages[last], content: note + messages[last].content };
  }

  const useFallback = FALLBACK_MODELS.has(settings.model);
  const stream = client.beta.messages.stream({
    model: settings.model,
    max_tokens: Number(settings.maxTokens) || 4000,
    output_config: { effort: settings.effort || "medium" },
    cache_control: { type: "ephemeral" }, // 긴 대화 이력은 캐시되어 비용·속도가 좋아집니다.
    system: buildSystemPrompt(char, settings, chat),
    messages,
    ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  });

  let text = "";
  stream.on("text", (delta) => {
    text += delta;
    onText(text);
  });

  const done = stream.finalMessage().then((msg) => {
    const finalText = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      text: (finalText || text).trim(),
      refused: msg.stop_reason === "refusal",
      truncated: msg.stop_reason === "max_tokens",
    };
  });

  return { abort: () => stream.abort(), done };
}

export function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "API 키가 올바르지 않습니다. 설정에서 키를 확인하세요.";
  if (err instanceof Anthropic.PermissionDeniedError) return "이 API 키로는 선택한 모델을 쓸 수 없습니다.";
  if (err instanceof Anthropic.RateLimitError) return "요청이 너무 많습니다. 잠시 후 다시 시도하세요.";
  if (err instanceof Anthropic.BadRequestError) return "요청 오류: " + (err.error?.error?.message || err.message);
  if (err instanceof Anthropic.APIConnectionError) return "네트워크에 연결할 수 없습니다.";
  if (err instanceof Anthropic.APIError) return `API 오류 (${err.status}): ${err.message}`;
  return String(err?.message || err);
}

export { fill };
