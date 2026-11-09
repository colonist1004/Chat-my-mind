// 모든 데이터는 이 기기의 IndexedDB 에만 저장됩니다.
import { get, set, del, keys } from "idb-keyval";

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "medium",
  maxTokens: 4000,
  length: "보통", // 짧게 | 보통 | 길게
  userName: "나",
  userPersona: "",
};

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...((await get("settings")) || {}) };
}
export async function saveSettings(s) {
  await set("settings", s);
}

// ---- 캐릭터 ----
export function blankCharacter() {
  return {
    id: uid(),
    name: "",
    avatar: "", // dataURL 또는 비어 있으면 이모지
    emoji: "🙂",
    tagline: "",
    personality: "",
    speech: "",
    background: "",
    scenario: "",
    greeting: "",
    examples: "",
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export async function listCharacters() {
  const ids = (await get("characters")) || [];
  const list = await Promise.all(ids.map((id) => get("char:" + id)));
  return list.filter(Boolean).sort((a, b) => (b.lastChatAt || b.updatedAt) - (a.lastChatAt || a.updatedAt));
}
export const getCharacter = (id) => get("char:" + id);
export async function saveCharacter(c) {
  c.updatedAt = Date.now();
  await set("char:" + c.id, c);
  const ids = (await get("characters")) || [];
  if (!ids.includes(c.id)) await set("characters", [...ids, c.id]);
}
export async function touchCharacter(id) {
  const c = await getCharacter(id);
  if (c) {
    c.lastChatAt = Date.now();
    await set("char:" + id, c);
  }
}
export async function deleteCharacter(id) {
  for (const chat of await listChats(id)) await del("chat:" + chat.id);
  await del("chats:" + id);
  await del("char:" + id);
  const ids = (await get("characters")) || [];
  await set("characters", ids.filter((x) => x !== id));
}

// ---- 대화 ----
// chat = { id, charId, title, note, messages: [{id, role:'user'|'assistant', text, at}] }
export async function listChats(charId) {
  const ids = (await get("chats:" + charId)) || [];
  const list = await Promise.all(ids.map((id) => get("chat:" + id)));
  return list.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}
export const getChat = (id) => get("chat:" + id);
export async function saveChat(chat) {
  chat.updatedAt = Date.now();
  await set("chat:" + chat.id, chat);
  const ids = (await get("chats:" + chat.charId)) || [];
  if (!ids.includes(chat.id)) await set("chats:" + chat.charId, [...ids, chat.id]);
}
export async function deleteChat(chat) {
  await del("chat:" + chat.id);
  const ids = (await get("chats:" + chat.charId)) || [];
  await set("chats:" + chat.charId, ids.filter((x) => x !== chat.id));
}

// ---- 백업 ----
export async function exportAll() {
  const data = {};
  for (const k of await keys()) if (k !== "settings") data[k] = await get(k);
  return { app: "chat-my-mind", version: 1, exportedAt: new Date().toISOString(), data };
}
export async function importAll(json) {
  if (json?.app !== "chat-my-mind" || !json.data) throw new Error("Chat My Mind 백업 파일이 아닙니다.");
  // 목록 키는 합쳐서 기존 데이터가 지워지지 않게 합니다.
  for (const [k, v] of Object.entries(json.data)) {
    if (k === "characters" || k.startsWith("chats:")) {
      const cur = (await get(k)) || [];
      await set(k, [...new Set([...cur, ...v])]);
    } else await set(k, v);
  }
}
