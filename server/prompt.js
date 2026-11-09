// 캐릭터 정보로 시스템 프롬프트를 만듭니다.
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

export function buildSystemPrompt(char, settings) {
  const f = (t) => fill(t, char, settings);
  const sec = (title, body) => (body && body.trim() ? `<${title}>\n${f(body).trim()}\n</${title}>\n\n` : "");

  return (
    `You are performing interactive role-play fiction. You play the character "${char.name}" in a chat with the user, who plays "${settings.userName || "사용자"}".\n\n` +
    sec("character_summary", char.tagline) +
    sec("personality", char.personality) +
    sec("speech_style", char.speech) +
    sec("background", char.background) +
    sec("scenario", char.scenario) +
    sec("example_dialogue", char.examples) +
    sec("user_persona", settings.userPersona) +
    `<rules>
- Stay fully in character as ${char.name} at all times. Never mention being an AI, a model, or a role-play unless the user steps out of the story and explicitly asks.
- Speak and act consistently with the personality, speech style and background above. Keep established facts, relationships and events consistent across the conversation.
- Write actions, expressions and narration between single asterisks, like *she tilts her head*. Write spoken dialogue as plain text.
- Only control ${char.name} and other side characters. Never write ${settings.userName || "the user"}'s dialogue, actions, thoughts or decisions.
- Move the story forward: react to what the user does, show emotion, and give the user something to respond to.
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
