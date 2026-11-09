import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { buildSystemPrompt, noteBlock, SUGGEST_SYSTEM, SUGGEST_SCHEMA } from "./prompt.js";

// ANTHROPIC_API_KEY 환경 변수에서 키를 읽습니다. 키는 서버에만 있고 브라우저로 가지 않습니다.
const client = new Anthropic();

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (가장 똑똑함)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (빠르고 균형)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (가장 빠르고 저렴)" },
];
export const ALLOWED_MODELS = (process.env.ALLOWED_MODELS || MODELS.map((m) => m.id).join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-5-5";

// 서버 측 거절 대체 모델(fallbacks)을 지원하는 모델
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

/**
 * 캐릭터 답변을 스트리밍합니다.
 * @returns {{ abort: () => void, done: Promise<{ text: string, refused: boolean, truncated: boolean, usage: object }> }}
 */
export function streamReply({ char, chat, settings, personas, history, onText }) {
  // personas: 이 대화에 참여한 내 프로필들. 2명 이상이면 멀티 프로필 모드로, 각 메시지 앞에 [이름] 을 붙입니다.
  const multi = personas.length > 1;
  const nameOf = (id) => (personas.find((p) => p.id === id) || personas[0]).name;
  const messages = history.map((m) => ({
    role: m.role,
    content: multi && m.role === "user" ? `[${nameOf(m.speaker)}] ${m.text}` : m.text,
  }));
  // API 는 user 메시지로 시작해야 하므로, 첫 인사말(assistant)이 맨 앞이면 장면 시작 메시지를 둡니다.
  if (messages[0]?.role === "assistant") messages.unshift({ role: "user", content: "(대화 시작)" });

  // 유저 노트는 시스템 프롬프트 캐시를 깨지 않도록 마지막 user 메시지 앞에 붙입니다.
  const note = noteBlock(chat, char, { ...settings, userName: personas[0].name });
  if (note) {
    const last = messages.findLastIndex((m) => m.role === "user");
    if (last >= 0) messages[last] = { ...messages[last], content: note + messages[last].content };
  }

  const model = ALLOWED_MODELS.includes(settings.model) ? settings.model : DEFAULT_MODEL;
  const stream = client.beta.messages.stream({
    model,
    max_tokens: Math.min(Math.max(Number(settings.maxTokens) || 4000, 500), 32000),
    output_config: { effort: ["low", "medium", "high"].includes(settings.effort) ? settings.effort : "medium" },
    cache_control: { type: "ephemeral" }, // 대화 이력이 캐시되어 비용·속도가 좋아집니다.
    system: buildSystemPrompt(char, settings, personas),
    messages,
    ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  });

  let text = "";
  stream.on("text", (delta) => {
    text += delta;
    onText(delta);
  });

  const done = stream.finalMessage().then((msg) => ({
    text: (
      msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("") || text
    ).trim(),
    refused: msg.stop_reason === "refusal",
    truncated: msg.stop_reason === "max_tokens",
    usage: msg.usage,
  }));

  return { abort: () => stream.abort(), done, partial: () => text };
}

/**
 * 제목(과 선택 힌트)으로 캐릭터 설정을 자동 작성합니다.
 * @returns {Promise<{ fields: object | null, refused: boolean, usage: object }>}
 */
export async function suggestCharacter({ title, hint, settings }) {
  const model = ALLOWED_MODELS.includes(settings.model) ? settings.model : DEFAULT_MODEL;
  const msg = await client.beta.messages.parse({
    model,
    max_tokens: 8000,
    output_config: { effort: "low", format: jsonSchemaOutputFormat(SUGGEST_SCHEMA) },
    system: SUGGEST_SYSTEM,
    messages: [
      {
        role: "user",
        content: `<title>${title}</title>${hint ? `\n<hint>${hint}</hint>` : ""}\n\n이 제목에 어울리는 캐릭터 설정을 작성해 주세요.`,
      },
    ],
    ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  });
  if (msg.stop_reason === "refusal") return { fields: null, refused: true, usage: msg.usage };
  return { fields: msg.parsed_output, refused: false, usage: msg.usage };
}

export function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "서버의 Claude API 키가 올바르지 않습니다. 관리자에게 문의하세요.";
  if (err instanceof Anthropic.PermissionDeniedError) return "서버 API 키로는 선택한 모델을 쓸 수 없습니다.";
  if (err instanceof Anthropic.RateLimitError) return "요청이 너무 많습니다. 잠시 후 다시 시도하세요.";
  if (err instanceof Anthropic.BadRequestError) return "요청 오류: " + (err.error?.error?.message || err.message);
  if (err instanceof Anthropic.APIConnectionError) return "Claude API 에 연결할 수 없습니다.";
  if (err instanceof Anthropic.APIError) return `API 오류 (${err.status})`;
  return "알 수 없는 오류가 발생했습니다.";
}

export { Anthropic };
