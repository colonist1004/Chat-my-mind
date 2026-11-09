// 캐릭터 정보로 시스템 프롬프트를 만듭니다.

// {{char}} → 캐릭터 이름, {{user}} → 내 (대표) 프로필 이름
export function fill(text, char, settings) {
  return (text || "")
    .replaceAll("{{char}}", char.name || "캐릭터")
    .replaceAll("{{user}}", settings.userName || "사용자");
}

const LENGTH_GUIDE = {
  짧게: "Keep each reply short: 1–3 sentences of dialogue with at most one short line of narration.",
  보통: "Keep each reply to a moderate length: about 1–3 short paragraphs mixing dialogue and narration.",
  길게: "Write rich, detailed replies: 3–6 paragraphs with vivid narration, inner thoughts and dialogue.",
};

/**
 * @param personas 이 대화에 참여한 내 프로필들 [{ name, description }] (1명 이상)
 */
export function buildSystemPrompt(char, settings, personas) {
  const userName = personas[0].name;
  const f = (t) => fill(t, char, { ...settings, userName });
  const sec = (title, body) => (body && body.trim() ? `<${title}>\n${f(body).trim()}\n</${title}>\n\n` : "");
  const multi = personas.length > 1;
  const names = personas.map((p) => p.name);
  const userLabel = multi ? names.join(", ") : userName;

  const userSection = multi
    ? `<user_characters>\nThe user plays ${personas.length} characters in this scene and switches between them:\n` +
      personas.map((p) => `- ${p.name}${p.description?.trim() ? `: ${f(p.description).trim()}` : ""}`).join("\n") +
      `\n</user_characters>\n\n`
    : sec("user_persona", personas[0].description);

  const multiRules = multi
    ? `- Each user message begins with the speaker's name in square brackets, e.g. "[${names[0]}] ...". That tells you which of the user's characters is speaking or acting.
- All of ${names.join(" and ")} can be present in the scene. React to whoever just spoke, and let ${char.name} treat each of them according to their own relationship and personality.
- Do not start your own reply with a bracketed name tag.
`
    : "";

  return (
    `You are performing interactive role-play fiction. You play the character "${char.name}" in a chat with the user, who plays ${multi ? "these characters" : `"${userName}"`}: ${userLabel}.\n\n` +
    sec("character_summary", char.tagline) +
    sec("personality", char.personality) +
    sec("speech_style", char.speech) +
    sec("background", char.background) +
    sec("scenario", char.scenario) +
    sec("example_dialogue", char.examples) +
    userSection +
    `<rules>
- Stay fully in character as ${char.name} at all times. Never mention being an AI, a model, or a role-play unless the user steps out of the story and explicitly asks.
- Speak and act consistently with the personality, speech style and background above. Keep established facts, relationships and events consistent across the conversation.
- Write actions, expressions and narration between single asterisks, like *she tilts her head*. Write spoken dialogue as plain text.
- Only control ${char.name} and other side characters. Never write dialogue, actions, thoughts or decisions for ${userLabel}.
${multiRules}- Move the story forward: react to what the user does, show emotion, and give the user something to respond to.
- Reply in the same language the user writes in (default: Korean). Match the register implied by the speech style (e.g. 반말/존댓말).
- ${LENGTH_GUIDE[settings.length] || LENGTH_GUIDE["보통"]}
</rules>`
  );
}

// 대화 중 바뀔 수 있는 '유저 노트'는 캐시를 깨지 않도록 시스템 프롬프트와 분리해 마지막 사용자 메시지 앞에 붙입니다.
export function noteBlock(chat, char, settings) {
  const n = (chat.note || "").trim();
  return n ? `<user_note>\n${fill(n, char, settings)}\n</user_note>\n\n` : "";
}

// ---- 제목 기반 캐릭터 자동 작성 ----
export const SUGGEST_SYSTEM = `You help users create characters for a Korean interactive role-play chat app.
The user gives you a title — the name they want to show for the character or chat room. It may be a person's name, or a story-style title that hints at a genre, setting, relationship or premise.
Infer the genre, setting and premise from the title (and the optional hint), then write a complete, vivid and coherent character sheet that a role-play AI can follow.

Guidelines:
- Write every field in natural Korean.
- If the title is a story-style title rather than a name, invent a fitting main character (with a name) and describe them in background; the scenario sets up the opening situation implied by the title.
- Refer to the player as {{user}} and to the character as {{char}} where natural.
- personality: core traits, likes/dislikes, motivations, contradictions, how they treat {{user}}. 3–6 sentences.
- speech: register (반말/존댓말), verbal habits, catchphrases, tone. 2–4 sentences.
- background: age, job/role, history, relationship to {{user}}. 3–6 sentences.
- scenario: the concrete situation where the chat begins. 2–4 sentences.
- greeting: the character's first message, in character, mixing *action narration in asterisks* with dialogue. 2–5 sentences. Do not speak or act for {{user}}.
- examples: 2–3 short exchanges in the format "{{user}}: ...\\n{{char}}: ...".
- tags: 2–5 short genre/mood tags without '#'.
- emoji: one emoji that fits the character.
- If the title suggests mature or sensitive themes, keep the sheet tasteful and non-explicit while preserving the genre and tone.`;

export const SUGGEST_SCHEMA = {
  type: "object",
  properties: {
    emoji: { type: "string" },
    tagline: { type: "string", description: "한 줄 소개 (40자 이내)" },
    personality: { type: "string" },
    speech: { type: "string" },
    background: { type: "string" },
    scenario: { type: "string" },
    greeting: { type: "string" },
    examples: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["emoji", "tagline", "personality", "speech", "background", "scenario", "greeting", "examples", "tags"],
  additionalProperties: false,
};
