import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { db, uid, tx } from "./db.js";
import { COOKIE, hashPassword, verifyPassword, createSession, cookieOptions, requireUser, limitAttempts } from "./auth.js";
import { streamReply, friendlyError, MODELS, ALLOWED_MODELS, DEFAULT_MODEL, Anthropic } from "./ai.js";
import { fill } from "./prompt.js";

const PORT = Number(process.env.PORT) || 8787;
const INVITE_CODE = process.env.INVITE_CODE || ""; // 설정하면 가입할 때 초대 코드가 필요합니다.
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP !== "false";
const DAILY_LIMIT = Number(process.env.DAILY_MESSAGE_LIMIT ?? 100); // 사용자당 하루 AI 응답 수 (0 = 무제한, 관리자는 무제한)

const app = express();
app.set("trust proxy", 1); // Caddy 같은 리버스 프록시 뒤에서 https·IP 를 올바르게 인식
app.disable("x-powered-by");
app.use(express.json({ limit: "3mb" }));

const api = express.Router();
app.use("/api", api);

// ---------- 공통 ----------
const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

const DEFAULT_SETTINGS = { model: DEFAULT_MODEL, effort: "medium", length: "보통", maxTokens: 4000, userName: "나", userPersona: "" };
const userSettings = (u) => ({ ...DEFAULT_SETTINGS, ...u.settings });

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
function cleanCharacter(input) {
  const avatar = typeof input.avatar === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(input.avatar) && input.avatar.length < 400_000 ? input.avatar : "";
  return {
    name: str(input.name, 60).trim(),
    emoji: str(input.emoji, 8) || "🙂",
    avatar,
    tagline: str(input.tagline, 200),
    personality: str(input.personality, 8000),
    speech: str(input.speech, 4000),
    background: str(input.background, 8000),
    scenario: str(input.scenario, 8000),
    greeting: str(input.greeting, 4000),
    examples: str(input.examples, 8000),
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 10).map((t) => str(t, 20)).filter(Boolean) : [],
  };
}

function getOwnedCharacter(userId, id) {
  const row = db.prepare("SELECT * FROM characters WHERE id = ? AND user_id = ?").get(id, userId);
  return row ? { id: row.id, ...JSON.parse(row.data), updatedAt: row.updated_at, lastChatAt: row.last_chat_at } : null;
}
function getOwnedChat(userId, id) {
  return db.prepare("SELECT * FROM chats WHERE id = ? AND user_id = ?").get(id, userId);
}
function chatMessages(chatId) {
  return db.prepare("SELECT id, role, text, created_at AS at FROM messages WHERE chat_id = ? ORDER BY seq").all(chatId);
}
function addMessage(chatId, role, text) {
  const { m } = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE chat_id = ?").get(chatId);
  const msg = { id: uid(), role, text, at: now() };
  db.prepare("INSERT INTO messages (id, chat_id, seq, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(msg.id, chatId, m + 1, role, text, msg.at);
  db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(msg.at, chatId);
  return msg;
}
function chatJSON(c) {
  return { id: c.id, charId: c.char_id, title: c.title, note: c.note, createdAt: c.created_at, updatedAt: c.updated_at };
}
function createChat(userId, char, settings) {
  const id = uid();
  const t = now();
  db.prepare("INSERT INTO chats (id, user_id, char_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, char.id, t, t);
  if (char.greeting?.trim()) addMessage(id, "assistant", fill(char.greeting, char, settings));
  return getOwnedChat(userId, id);
}

// ---------- 인증 ----------
api.get("/config", (req, res) => {
  res.json({ signup: ALLOW_SIGNUP, inviteRequired: !!INVITE_CODE });
});

api.post("/auth/register", limitAttempts(), (req, res) => {
  if (!ALLOW_SIGNUP) return bad(res, "현재 가입을 받지 않습니다.", 403);
  const username = str(req.body.username, 32).trim();
  const password = str(req.body.password, 200);
  if (INVITE_CODE && req.body.inviteCode !== INVITE_CODE) return bad(res, "초대 코드가 올바르지 않습니다.", 403);
  if (!/^[\w가-힣.-]{2,32}$/.test(username)) return bad(res, "아이디는 2~32자의 한글·영문·숫자·._- 만 쓸 수 있습니다.");
  if (password.length < 8) return bad(res, "비밀번호는 8자 이상이어야 합니다.");
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) return bad(res, "이미 사용 중인 아이디입니다.", 409);
  const isFirst = !db.prepare("SELECT 1 FROM users LIMIT 1").get();
  const id = uid();
  db.prepare("INSERT INTO users (id, username, pass, settings, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    username,
    hashPassword(password),
    JSON.stringify({ userName: username }),
    isFirst ? 1 : 0, // 첫 가입자는 관리자(사용량 무제한)
    now(),
  );
  const s = createSession(id);
  res.cookie(COOKIE, s.token, cookieOptions(req, s.maxAge)).json({ ok: true });
});

api.post("/auth/login", limitAttempts(), (req, res) => {
  const row = db.prepare("SELECT id, pass FROM users WHERE username = ?").get(str(req.body.username, 32).trim());
  if (!row || !verifyPassword(str(req.body.password, 200), row.pass)) return bad(res, "아이디 또는 비밀번호가 올바르지 않습니다.", 401);
  const s = createSession(row.id);
  res.cookie(COOKIE, s.token, cookieOptions(req, s.maxAge)).json({ ok: true });
});

api.use(requireUser); // ↓ 여기부터는 로그인 필요

api.post("/auth/logout", (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(req.sessionToken);
  res.clearCookie(COOKIE, { path: "/" }).json({ ok: true });
});

api.post("/auth/password", (req, res) => {
  const row = db.prepare("SELECT pass FROM users WHERE id = ?").get(req.user.id);
  if (!verifyPassword(str(req.body.current, 200), row.pass)) return bad(res, "현재 비밀번호가 올바르지 않습니다.", 401);
  if (str(req.body.next, 200).length < 8) return bad(res, "새 비밀번호는 8자 이상이어야 합니다.");
  db.prepare("UPDATE users SET pass = ? WHERE id = ?").run(hashPassword(req.body.next), req.user.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(req.user.id, req.sessionToken);
  res.json({ ok: true });
});

api.get("/me", (req, res) => {
  const u = db.prepare("SELECT requests FROM usage WHERE user_id = ? AND day = ?").get(req.user.id, today());
  res.json({
    username: req.user.username,
    isAdmin: req.user.isAdmin,
    settings: userSettings(req.user),
    models: MODELS.filter((m) => ALLOWED_MODELS.includes(m.id)),
    usage: { today: u?.requests || 0, limit: req.user.isAdmin ? 0 : DAILY_LIMIT },
  });
});

api.put("/settings", (req, res) => {
  const b = req.body || {};
  const s = {
    model: ALLOWED_MODELS.includes(b.model) ? b.model : DEFAULT_MODEL,
    effort: ["low", "medium", "high"].includes(b.effort) ? b.effort : "medium",
    length: ["짧게", "보통", "길게"].includes(b.length) ? b.length : "보통",
    maxTokens: Math.min(Math.max(Number(b.maxTokens) || 4000, 500), 32000),
    userName: str(b.userName, 40).trim() || req.user.username,
    userPersona: str(b.userPersona, 4000),
  };
  db.prepare("UPDATE users SET settings = ? WHERE id = ?").run(JSON.stringify(s), req.user.id);
  res.json(s);
});

// ---------- 캐릭터 ----------
api.get("/characters", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM characters WHERE user_id = ? ORDER BY COALESCE(last_chat_at, updated_at) DESC")
    .all(req.user.id);
  res.json(rows.map((r) => ({ id: r.id, ...JSON.parse(r.data), updatedAt: r.updated_at, lastChatAt: r.last_chat_at })));
});

api.post("/characters", (req, res) => {
  const c = cleanCharacter(req.body || {});
  if (!c.name) return bad(res, "이름을 입력하세요.");
  const id = uid();
  db.prepare("INSERT INTO characters (id, user_id, data, updated_at) VALUES (?, ?, ?, ?)").run(id, req.user.id, JSON.stringify(c), now());
  res.json(getOwnedCharacter(req.user.id, id));
});

api.get("/characters/:id", (req, res) => {
  const c = getOwnedCharacter(req.user.id, req.params.id);
  c ? res.json(c) : bad(res, "캐릭터를 찾을 수 없습니다.", 404);
});

api.put("/characters/:id", (req, res) => {
  if (!getOwnedCharacter(req.user.id, req.params.id)) return bad(res, "캐릭터를 찾을 수 없습니다.", 404);
  const c = cleanCharacter(req.body || {});
  if (!c.name) return bad(res, "이름을 입력하세요.");
  db.prepare("UPDATE characters SET data = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(JSON.stringify(c), now(), req.params.id, req.user.id);
  res.json(getOwnedCharacter(req.user.id, req.params.id));
});

api.delete("/characters/:id", (req, res) => {
  db.prepare("DELETE FROM characters WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- 대화 ----------
api.get("/characters/:id/chats", (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS count
       FROM chats c WHERE c.char_id = ? AND c.user_id = ? ORDER BY c.updated_at DESC`,
    )
    .all(req.params.id, req.user.id);
  res.json(rows.map((r) => ({ ...chatJSON(r), messageCount: r.count })));
});

api.post("/characters/:id/chats", (req, res) => {
  const char = getOwnedCharacter(req.user.id, req.params.id);
  if (!char) return bad(res, "캐릭터를 찾을 수 없습니다.", 404);
  const chat = createChat(req.user.id, char, userSettings(req.user));
  res.json({ ...chatJSON(chat), messages: chatMessages(chat.id) });
});

// 캐릭터의 최근 대화(없으면 새로 만듦)
api.get("/characters/:id/latest-chat", (req, res) => {
  const char = getOwnedCharacter(req.user.id, req.params.id);
  if (!char) return bad(res, "캐릭터를 찾을 수 없습니다.", 404);
  const chat =
    db.prepare("SELECT * FROM chats WHERE char_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1").get(char.id, req.user.id) ||
    createChat(req.user.id, char, userSettings(req.user));
  res.json({ ...chatJSON(chat), messages: chatMessages(chat.id) });
});

api.get("/chats/:id", (req, res) => {
  const chat = getOwnedChat(req.user.id, req.params.id);
  if (!chat) return bad(res, "대화를 찾을 수 없습니다.", 404);
  res.json({ ...chatJSON(chat), messages: chatMessages(chat.id) });
});

api.patch("/chats/:id", (req, res) => {
  const chat = getOwnedChat(req.user.id, req.params.id);
  if (!chat) return bad(res, "대화를 찾을 수 없습니다.", 404);
  const note = req.body.note !== undefined ? str(req.body.note, 8000) : chat.note;
  const title = req.body.title !== undefined ? str(req.body.title, 100) : chat.title;
  db.prepare("UPDATE chats SET note = ?, title = ? WHERE id = ?").run(note, title, chat.id);
  res.json({ ok: true });
});

api.delete("/chats/:id", (req, res) => {
  db.prepare("DELETE FROM chats WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

api.put("/chats/:id/messages/:mid", (req, res) => {
  if (!getOwnedChat(req.user.id, req.params.id)) return bad(res, "대화를 찾을 수 없습니다.", 404);
  const text = str(req.body.text, 20000).trim();
  if (!text) return bad(res, "내용을 입력하세요.");
  db.prepare("UPDATE messages SET text = ? WHERE id = ? AND chat_id = ?").run(text, req.params.mid, req.params.id);
  res.json({ ok: true });
});

api.delete("/chats/:id/messages/:mid", (req, res) => {
  if (!getOwnedChat(req.user.id, req.params.id)) return bad(res, "대화를 찾을 수 없습니다.", 404);
  db.prepare("DELETE FROM messages WHERE id = ? AND chat_id = ?").run(req.params.mid, req.params.id);
  res.json({ ok: true });
});

// ---------- AI 답변 (Server-Sent Events 스트리밍) ----------
const busy = new Set(); // 같은 대화에서 동시에 두 번 생성되지 않도록

function checkQuota(user) {
  if (user.isAdmin || !DAILY_LIMIT) return true;
  const u = db.prepare("SELECT requests FROM usage WHERE user_id = ? AND day = ?").get(user.id, today());
  return (u?.requests || 0) < DAILY_LIMIT;
}
function recordUsage(userId, usage) {
  db.prepare(
    `INSERT INTO usage (user_id, day, requests, input_tokens, output_tokens) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(user_id, day) DO UPDATE SET requests = requests + 1,
       input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
  ).run(
    userId,
    today(),
    (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0),
    usage?.output_tokens || 0,
  );
}

// body: { text } → 사용자 메시지를 추가하고 답변 생성 / { regenerate: true } → 마지막 AI 답변을 지우고 다시 생성
api.post("/chats/:id/reply", async (req, res) => {
  const chat = getOwnedChat(req.user.id, req.params.id);
  if (!chat) return bad(res, "대화를 찾을 수 없습니다.", 404);
  const char = getOwnedCharacter(req.user.id, chat.char_id);
  if (!char) return bad(res, "캐릭터를 찾을 수 없습니다.", 404);
  if (busy.has(chat.id)) return bad(res, "이미 답변을 생성하고 있습니다.", 409);
  if (!checkQuota(req.user)) return bad(res, `오늘 사용 가능한 횟수(${DAILY_LIMIT}회)를 모두 썼습니다. 내일 다시 이용해 주세요.`, 429);

  const settings = userSettings(req.user);
  const text = str(req.body.text, 20000).trim();
  let userMsg = null;
  if (req.body.regenerate) {
    const last = db.prepare("SELECT id, role FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT 1").get(chat.id);
    if (last?.role === "assistant") db.prepare("DELETE FROM messages WHERE id = ?").run(last.id);
  } else {
    if (!text) return bad(res, "메시지를 입력하세요.");
    userMsg = addMessage(chat.id, "user", text);
    if (!chat.title) db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(text.slice(0, 30), chat.id);
  }

  const history = chatMessages(chat.id);
  if (!history.some((m) => m.role === "user")) return bad(res, "먼저 메시지를 보내 주세요.");

  busy.add(chat.id);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  if (userMsg) send({ type: "user", message: userMsg });

  const gen = streamReply({ char, chat, settings, history, onText: (t) => send({ type: "delta", text: t }) });
  let finished = false;
  res.on("close", () => {
    if (!finished) gen.abort(); // 사용자가 멈추기를 누르거나 연결이 끊김
  });

  try {
    const r = await gen.done;
    recordUsage(req.user.id, r.usage);
    if (r.refused) {
      send({ type: "error", error: "이 요청에는 답변할 수 없었어요. 내용을 바꿔 다시 시도해 주세요." });
    } else {
      const msg = addMessage(chat.id, "assistant", r.text);
      send({ type: "done", message: msg, truncated: r.truncated });
    }
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError) {
      // 멈춘 경우: 지금까지 받은 부분을 저장
      const partial = gen.partial().trim();
      if (partial) addMessage(chat.id, "assistant", partial);
    } else {
      console.error("[reply]", e);
      send({ type: "error", error: friendlyError(e) });
    }
  } finally {
    finished = true;
    busy.delete(chat.id);
    db.prepare("UPDATE characters SET last_chat_at = ? WHERE id = ?").run(now(), char.id);
    res.end();
  }
});

// ---------- 백업 ----------
api.get("/export", (req, res) => {
  const chars = db.prepare("SELECT * FROM characters WHERE user_id = ?").all(req.user.id);
  const chats = db.prepare("SELECT * FROM chats WHERE user_id = ?").all(req.user.id);
  res.json({
    app: "chat-my-mind",
    version: 2,
    exportedAt: new Date().toISOString(),
    characters: chars.map((c) => ({
      ...JSON.parse(c.data),
      chats: chats
        .filter((ch) => ch.char_id === c.id)
        .map((ch) => ({ title: ch.title, note: ch.note, messages: chatMessages(ch.id).map(({ role, text, at }) => ({ role, text, at })) })),
    })),
  });
});

api.post("/import", (req, res) => {
  const list = Array.isArray(req.body?.characters) ? req.body.characters : req.body?.character ? [req.body.character] : null;
  if (!list) return bad(res, "Chat My Mind 백업/캐릭터 파일이 아닙니다.");
  let count = 0;
  tx(() => {
    for (const raw of list.slice(0, 200)) {
      const c = cleanCharacter(raw);
      if (!c.name) continue;
      const id = uid();
      const t = now();
      db.prepare("INSERT INTO characters (id, user_id, data, updated_at) VALUES (?, ?, ?, ?)").run(id, req.user.id, JSON.stringify(c), t);
      for (const ch of Array.isArray(raw.chats) ? raw.chats.slice(0, 100) : []) {
        const chatId = uid();
        db.prepare("INSERT INTO chats (id, user_id, char_id, title, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          chatId, req.user.id, id, str(ch.title, 100), str(ch.note, 8000), t, t,
        );
        let seq = 0;
        for (const m of Array.isArray(ch.messages) ? ch.messages : []) {
          if (!["user", "assistant"].includes(m.role) || !m.text) continue;
          db.prepare("INSERT INTO messages (id, chat_id, seq, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
            uid(), chatId, ++seq, m.role, str(m.text, 20000), Number(m.at) || t,
          );
        }
      }
      count++;
    }
  });
  res.json({ imported: count });
});

api.use((req, res) => bad(res, "없는 API 입니다.", 404));

// ---------- 화면(빌드된 프론트엔드) ----------
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(join(dist, "index.html")));
}

app.listen(PORT, () => {
  console.log(`Chat My Mind server → http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("⚠️  ANTHROPIC_API_KEY 가 설정되지 않았습니다. AI 답변이 동작하지 않습니다.");
  if (!INVITE_CODE && ALLOW_SIGNUP) console.warn("⚠️  INVITE_CODE 가 없어 누구나 가입할 수 있습니다. 공개 서버라면 설정을 권장합니다.");
});
