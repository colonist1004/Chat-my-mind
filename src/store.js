// 서버 API 클라이언트. 데이터는 모두 서버(DB)에 저장됩니다.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(method, path, body) {
  const res = await fetch("/api" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(res.status, data.error || `요청 실패 (${res.status})`);
    if (res.status === 401) window.dispatchEvent(new CustomEvent("auth-required"));
    throw err;
  }
  return data;
}

export const api = {
  config: () => call("GET", "/config"),
  register: (b) => call("POST", "/auth/register", b),
  login: (b) => call("POST", "/auth/login", b),
  logout: () => call("POST", "/auth/logout"),
  changePassword: (b) => call("POST", "/auth/password", b),
  me: () => call("GET", "/me"),
  saveSettings: (s) => call("PUT", "/settings", s),

  listCharacters: () => call("GET", "/characters"),
  getCharacter: (id) => call("GET", "/characters/" + id),
  createCharacter: (c) => call("POST", "/characters", c),
  updateCharacter: (id, c) => call("PUT", "/characters/" + id, c),
  deleteCharacter: (id) => call("DELETE", "/characters/" + id),
  suggestCharacter: (b) => call("POST", "/characters/suggest", b),

  listChats: (charId) => call("GET", `/characters/${charId}/chats`),
  newChat: (charId) => call("POST", `/characters/${charId}/chats`),
  latestChat: (charId) => call("GET", `/characters/${charId}/latest-chat`),
  getChat: (id) => call("GET", "/chats/" + id),
  updateChat: (id, b) => call("PATCH", "/chats/" + id, b),
  deleteChat: (id) => call("DELETE", "/chats/" + id),
  editMessage: (chatId, mid, text) => call("PUT", `/chats/${chatId}/messages/${mid}`, { text }),
  deleteMessage: (chatId, mid) => call("DELETE", `/chats/${chatId}/messages/${mid}`),

  exportAll: () => call("GET", "/export"),
  importAll: (json) => call("POST", "/import", json),
};

/**
 * AI 답변 스트리밍. body = { text } 또는 { regenerate: true }
 * 서버가 보내는 이벤트: user(저장된 내 메시지), delta(글자), done(저장된 답변), error
 */
export function streamReply(chatId, body, onEvent) {
  const ctrl = new AbortController();
  const done = (async () => {
    const res = await fetch(`/api/chats/${chatId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      credentials: "same-origin",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) window.dispatchEvent(new CustomEvent("auth-required"));
      throw new ApiError(res.status, data.error || `요청 실패 (${res.status})`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (line) onEvent(JSON.parse(line.slice(6)));
      }
    }
  })();
  return { abort: () => ctrl.abort(), done };
}
