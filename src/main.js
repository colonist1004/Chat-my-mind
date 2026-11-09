import "./style.css";
import Anthropic from "@anthropic-ai/sdk";
import * as db from "./store.js";
import { MODELS, streamReply, friendlyError, fill } from "./ai.js";
import { SAMPLE_CHARACTERS } from "./samples.js";

const app = document.getElementById("app");
let settings;
let current = null; // 스트리밍 중인 요청 { abort }

// ---------- 유틸 ----------
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// *행동* → 기울임, "대사" 강조, 줄바꿈 유지
function renderText(text) {
  return esc(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, '<em class="act">$1</em>')
    .replace(/\n/g, "<br>");
}

function avatarHTML(c, cls = "") {
  return c.avatar
    ? `<img class="avatar ${cls}" src="${esc(c.avatar)}" alt="">`
    : `<div class="avatar emoji ${cls}">${esc(c.emoji || "🙂")}</div>`;
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function go(hash) {
  location.hash = hash;
}

// 이미지를 정사각형 256px JPEG 로 줄여서 저장 용량을 아낍니다.
function resizeImage(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function download(name, obj) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const i = document.createElement("input");
    i.type = "file";
    i.accept = accept;
    i.onchange = () => resolve(i.files[0]);
    i.click();
  });
}

// ---------- 레이아웃 ----------
// PC: 왼쪽 캐릭터 목록 + 오른쪽 화면 / 모바일: 한 번에 한 화면
async function shell(mainHTML, { view, activeChar } = {}) {
  const chars = await db.listCharacters();
  app.innerHTML = `
    <div class="layout view-${view}">
      <aside class="sidebar">
        <div class="side-head">
          <a href="#/" class="brand">💬 Chat My Mind</a>
          <a href="#/settings" class="icon-btn" title="설정">⚙️</a>
        </div>
        <a href="#/new" class="btn primary block">＋ 새 캐릭터 만들기</a>
        <div class="side-list">
          ${chars
            .map(
              (c) => `
            <a href="#/chat/${c.id}" class="side-item ${c.id === activeChar ? "active" : ""}">
              ${avatarHTML(c, "sm")}
              <div class="side-meta"><b>${esc(c.name)}</b><span>${esc(c.tagline)}</span></div>
            </a>`,
            )
            .join("")}
        </div>
      </aside>
      <main class="main">${mainHTML}</main>
    </div>`;
  return app.querySelector(".main");
}

// ---------- 홈 ----------
async function viewHome() {
  const chars = await db.listCharacters();
  const main = await shell(
    `
    <header class="topbar">
      <h1>내 캐릭터</h1>
      <div class="spacer"></div>
      <button class="icon-btn" id="import" title="캐릭터 가져오기">📥</button>
      <a href="#/settings" class="icon-btn" title="설정">⚙️</a>
    </header>
    <div class="scroll">
      ${
        !settings.apiKey
          ? `<div class="notice">시작하려면 <a href="#/settings">설정</a>에서 Claude API 키를 입력하세요.</div>`
          : ""
      }
      <div class="grid">
        <a href="#/new" class="card new-card"><div class="plus">＋</div><b>새 캐릭터</b><span>성격·말투·세계관을 마음대로</span></a>
        ${chars
          .map(
            (c) => `
          <a href="#/chat/${c.id}" class="card">
            ${c.avatar ? `<img class="card-img" src="${esc(c.avatar)}" alt="">` : `<div class="card-img emoji">${esc(c.emoji || "🙂")}</div>`}
            <div class="card-body">
              <b>${esc(c.name)}</b>
              <span>${esc(c.tagline)}</span>
              <div class="tags">${(c.tags || []).map((t) => `<i>#${esc(t)}</i>`).join("")}</div>
            </div>
          </a>`,
          )
          .join("")}
      </div>
      ${
        chars.length === 0
          ? `<div class="empty">아직 캐릭터가 없어요.<br><button class="btn" id="samples">예시 캐릭터 불러오기</button></div>`
          : ""
      }
    </div>`,
    { view: "home" },
  );

  main.querySelector("#samples")?.addEventListener("click", async () => {
    for (const s of SAMPLE_CHARACTERS) await db.saveCharacter({ ...db.blankCharacter(), ...s, id: db.uid() });
    route();
  });
  main.querySelector("#import").addEventListener("click", importCharacter);
}

async function importCharacter() {
  const f = await pickFile("application/json,.json");
  if (!f) return;
  try {
    const json = JSON.parse(await f.text());
    const c = json.character || json;
    if (!c.name) throw new Error("캐릭터 파일이 아닙니다.");
    await db.saveCharacter({ ...db.blankCharacter(), ...c, id: db.uid() });
    toast(`'${c.name}' 캐릭터를 가져왔어요.`);
    route();
  } catch (e) {
    toast("가져오기 실패: " + e.message);
  }
}

// ---------- 캐릭터 만들기/수정 ----------
const FIELDS = [
  ["name", "이름", "input", "예) 윤서아", true],
  ["tagline", "한 줄 소개", "input", "예) 무뚝뚝하지만 속은 따뜻한 옆집 대학생"],
  ["personality", "성격", "textarea", "예) 겉으로는 시크하고 말수가 적지만 친해지면 장난이 많다. 고양이를 좋아하고 거짓말을 싫어한다."],
  ["speech", "말투", "textarea", "예) 반말. 짧게 끊어 말한다. 당황하면 '…뭐, 됐어.' 라고 얼버무린다."],
  ["background", "배경 · 설정", "textarea", "예) 22살, 미대생. {{user}}와는 같은 빌라 이웃으로 3개월째 인사만 하는 사이."],
  ["scenario", "상황 · 세계관", "textarea", "예) 장마철 밤, 엘리베이터가 고장 나 {{user}}와 계단에 갇혔다."],
  ["greeting", "첫 메시지", "textarea", "예) *젖은 우산을 털며 너를 힐끗 본다* …너도 계단이야? 엘리베이터 또 고장 났대."],
  ["examples", "예시 대화 (선택)", "textarea", "{{user}}: 안녕?\n{{char}}: *고개만 까딱인다* …응."],
];

async function viewEdit(id) {
  const isNew = !id;
  const c = isNew ? db.blankCharacter() : await db.getCharacter(id);
  if (!c) return go("#/");

  const main = await shell(
    `
    <header class="topbar">
      <button class="icon-btn back" onclick="history.back()">←</button>
      <h1>${isNew ? "새 캐릭터" : "캐릭터 수정"}</h1>
      <div class="spacer"></div>
      <button class="btn primary" id="save">저장</button>
    </header>
    <div class="scroll">
      <form class="form" id="form" onsubmit="return false">
        <div class="avatar-row">
          <div id="avatarPreview">${avatarHTML(c, "lg")}</div>
          <div class="avatar-actions">
            <button type="button" class="btn" id="pickImg">사진 선택</button>
            <button type="button" class="btn ghost" id="clearImg">사진 지우기</button>
            <label class="inline">이모지 <input name="emoji" maxlength="4" value="${esc(c.emoji)}" class="emoji-input"></label>
          </div>
        </div>
        ${FIELDS.map(
          ([k, label, type, ph, req]) => `
          <label class="field"><span>${label}${req ? " *" : ""}</span>
            ${
              type === "input"
                ? `<input name="${k}" value="${esc(c[k])}" placeholder="${esc(ph)}" ${req ? "required" : ""}>`
                : `<textarea name="${k}" rows="${k === "examples" ? 5 : 3}" placeholder="${esc(ph)}">${esc(c[k])}</textarea>`
            }
          </label>`,
        ).join("")}
        <label class="field"><span>태그 (쉼표로 구분)</span>
          <input name="tags" value="${esc((c.tags || []).join(", "))}" placeholder="예) 로맨스, 일상, 츤데레">
        </label>
        <p class="hint"><code>{{char}}</code> 는 캐릭터 이름, <code>{{user}}</code> 는 설정의 내 이름으로 바뀝니다.</p>
        ${
          isNew
            ? ""
            : `<div class="danger-zone">
                <button type="button" class="btn" id="export">캐릭터 내보내기</button>
                <button type="button" class="btn danger" id="delete">캐릭터 삭제</button>
              </div>`
        }
      </form>
    </div>`,
    { view: "edit", activeChar: c.id },
  );

  const form = main.querySelector("#form");
  let avatar = c.avatar;
  const refreshPreview = () => {
    main.querySelector("#avatarPreview").innerHTML = avatarHTML({ avatar, emoji: form.emoji.value }, "lg");
  };
  form.emoji.addEventListener("input", refreshPreview);
  main.querySelector("#pickImg").addEventListener("click", async () => {
    const f = await pickFile("image/*");
    if (f) {
      avatar = await resizeImage(f);
      refreshPreview();
    }
  });
  main.querySelector("#clearImg").addEventListener("click", () => {
    avatar = "";
    refreshPreview();
  });

  main.querySelector("#save").addEventListener("click", async () => {
    if (!form.name.value.trim()) {
      form.name.focus();
      return toast("이름을 입력하세요.");
    }
    for (const [k] of FIELDS) c[k] = form[k].value;
    c.name = c.name.trim();
    c.emoji = form.emoji.value || "🙂";
    c.avatar = avatar;
    c.tags = form.tags.value.split(",").map((t) => t.trim()).filter(Boolean);
    await db.saveCharacter(c);
    toast("저장했어요.");
    location.replace("#/chat/" + c.id);
  });

  main.querySelector("#export")?.addEventListener("click", () => {
    const { id: _id, lastChatAt: _l, ...rest } = c;
    download(`${c.name || "character"}.json`, { app: "chat-my-mind", character: rest });
  });
  main.querySelector("#delete")?.addEventListener("click", async () => {
    if (!confirm(`'${c.name}' 캐릭터와 모든 대화를 삭제할까요?`)) return;
    await db.deleteCharacter(c.id);
    go("#/");
  });
}

// ---------- 채팅 ----------
function newChat(c) {
  const chat = { id: db.uid(), charId: c.id, title: "", note: "", messages: [], createdAt: Date.now() };
  if (c.greeting?.trim()) chat.messages.push({ id: db.uid(), role: "assistant", text: fill(c.greeting, c, settings), at: Date.now() });
  return chat;
}

async function viewChat(charId, chatId) {
  const c = await db.getCharacter(charId);
  if (!c) return go("#/");

  let chat = chatId ? await db.getChat(chatId) : (await db.listChats(charId))[0];
  if (!chat) {
    chat = newChat(c);
    await db.saveChat(chat);
  }

  const main = await shell(
    `
    <header class="topbar chat-top">
      <a href="#/" class="icon-btn back">←</a>
      ${avatarHTML(c, "sm")}
      <div class="chat-title"><b>${esc(c.name)}</b><span>${esc(c.tagline)}</span></div>
      <div class="spacer"></div>
      <button class="icon-btn" id="menuBtn" title="메뉴">⋯</button>
      <div class="menu" id="menu" hidden>
        <button data-act="new">＋ 새 대화 시작</button>
        <button data-act="chats">🗂 대화 목록</button>
        <button data-act="note">📝 유저 노트</button>
        <button data-act="edit">✏️ 캐릭터 수정</button>
        <button data-act="clear" class="danger">🗑 이 대화 삭제</button>
      </div>
    </header>
    <div class="scroll messages" id="msgs"></div>
    <form class="composer" id="composer">
      <textarea id="input" rows="1" placeholder="메시지 입력 · *행동*은 별표"></textarea>
      <button class="send" id="send" type="submit" title="보내기">➤</button>
    </form>`,
    { view: "chat", activeChar: c.id },
  );

  const msgsEl = main.querySelector("#msgs");
  const input = main.querySelector("#input");
  const sendBtn = main.querySelector("#send");
  const menu = main.querySelector("#menu");

  const save = () => db.saveChat(chat);
  const atBottom = () => msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
  const scrollDown = () => (msgsEl.scrollTop = msgsEl.scrollHeight);

  function msgHTML(m, i) {
    const isLastAI = m.role === "assistant" && i === chat.messages.length - 1 && chat.messages.some((x) => x.role === "user");
    return `
      <div class="msg ${m.role}" data-i="${i}">
        ${m.role === "assistant" ? avatarHTML(c, "xs") : ""}
        <div class="bubble-wrap">
          ${m.role === "assistant" ? `<div class="who">${esc(c.name)}</div>` : ""}
          <div class="bubble ${m.error ? "error" : ""}">${m.text ? renderText(m.text) : '<span class="typing"><i></i><i></i><i></i></span>'}</div>
          <div class="msg-actions">
            ${isLastAI && !m.pending ? `<button data-act="regen" title="다시 생성">↻ 다시</button>` : ""}
            ${!m.pending ? `<button data-act="edit" title="수정">✎ 수정</button><button data-act="del" title="삭제">✕ 삭제</button>` : ""}
          </div>
        </div>
      </div>`;
  }

  function render() {
    msgsEl.innerHTML =
      `<div class="chat-intro">${avatarHTML(c, "lg")}<b>${esc(c.name)}</b><span>${esc(c.tagline)}</span></div>` +
      chat.messages.map(msgHTML).join("");
    scrollDown();
  }

  function setBusy(b) {
    sendBtn.textContent = b ? "■" : "➤";
    sendBtn.title = b ? "멈추기" : "보내기";
    sendBtn.classList.toggle("stop", b);
  }

  async function generate() {
    if (!settings.apiKey) {
      toast("설정에서 API 키를 먼저 입력하세요.");
      return go("#/settings");
    }
    const history = chat.messages.filter((m) => !m.error && m.text);
    if (!history.some((m) => m.role === "user")) return;

    const reply = { id: db.uid(), role: "assistant", text: "", at: Date.now(), pending: true };
    chat.messages.push(reply);
    render();
    setBusy(true);

    const bubble = () => msgsEl.querySelector(`.msg[data-i="${chat.messages.length - 1}"] .bubble`);
    const req = streamReply({
      char: c,
      chat,
      settings,
      history,
      onText: (t) => {
        reply.text = t;
        const stick = atBottom();
        const b = bubble();
        if (b) b.innerHTML = renderText(t);
        if (stick) scrollDown();
      },
    });
    current = req;
    try {
      const r = await req.done;
      reply.text = r.text;
      if (r.refused) {
        reply.text = "이 요청에는 답변할 수 없었어요. 내용을 바꿔 다시 시도해 주세요.";
        reply.error = true;
      } else if (r.truncated) toast("답변이 최대 길이에 도달해 잘렸어요. 설정에서 최대 토큰을 늘릴 수 있어요.");
    } catch (e) {
      if (e instanceof Anthropic.APIUserAbortError) {
        if (!reply.text) chat.messages.pop();
      } else {
        reply.text = friendlyError(e);
        reply.error = true;
      }
    } finally {
      delete reply.pending;
      current = null;
      setBusy(false);
      chat.messages = chat.messages.filter((m) => m.text);
      if (!chat.title) chat.title = (chat.messages.find((m) => m.role === "user")?.text || "").slice(0, 30);
      await save();
      await db.touchCharacter(c.id);
      render();
    }
  }

  main.querySelector("#composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (current) return current.abort();
    const text = input.value.trim();
    if (!text) return;
    // 이전 오류 메시지는 지우고 진행
    chat.messages = chat.messages.filter((m) => !m.error);
    chat.messages.push({ id: db.uid(), role: "user", text, at: Date.now() });
    input.value = "";
    autosize();
    await save();
    generate();
  });

  // PC: Enter 전송, Shift+Enter 줄바꿈 / 모바일: 엔터는 줄바꿈, 버튼으로 전송
  const isTouch = matchMedia("(pointer: coarse)").matches;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !isTouch && !e.isComposing) {
      e.preventDefault();
      main.querySelector("#composer").requestSubmit();
    }
  });
  const autosize = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  };
  input.addEventListener("input", autosize);

  msgsEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn || current) return;
    const i = Number(btn.closest(".msg").dataset.i);
    const m = chat.messages[i];
    const act = btn.dataset.act;
    if (act === "regen") {
      chat.messages.splice(i, 1);
      generate();
    } else if (act === "del") {
      chat.messages.splice(i, 1);
      await save();
      render();
    } else if (act === "edit") {
      const bubbleEl = btn.closest(".bubble-wrap").querySelector(".bubble");
      bubbleEl.innerHTML = `<textarea class="edit-area">${esc(m.text)}</textarea>
        <div class="edit-actions"><button class="btn ghost" data-e="cancel">취소</button><button class="btn primary" data-e="ok">저장</button></div>`;
      const ta = bubbleEl.querySelector("textarea");
      ta.style.height = Math.max(ta.scrollHeight, 80) + "px";
      ta.focus();
      bubbleEl.addEventListener("click", async (ev) => {
        const b = ev.target.closest("button[data-e]");
        if (!b) return;
        ev.stopPropagation();
        if (b.dataset.e === "ok" && ta.value.trim()) {
          m.text = ta.value.trim();
          delete m.error;
          await save();
        }
        render();
      });
    }
  });

  // 메뉴
  main.querySelector("#menuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", () => (menu.hidden = true), { once: true });
  menu.addEventListener("click", async (e) => {
    const act = e.target.closest("button")?.dataset.act;
    menu.hidden = true;
    if (current && act !== "edit") current.abort();
    if (act === "new") {
      const nc = newChat(c);
      await db.saveChat(nc);
      go(`#/chat/${c.id}/${nc.id}`);
    } else if (act === "chats") showChatList(c, chat);
    else if (act === "note") showNote();
    else if (act === "edit") go("#/edit/" + c.id);
    else if (act === "clear") {
      if (!confirm("이 대화를 삭제할까요?")) return;
      await db.deleteChat(chat);
      const target = "#/chat/" + c.id;
      location.hash === target ? route() : go(target);
    }
  });

  function showNote() {
    modal(
      `<h2>📝 유저 노트</h2>
       <p class="hint">캐릭터가 이 대화에서 항상 기억해야 할 내용을 적어 두세요. (예: 둘은 이미 사귀는 사이, 지금은 여름방학)</p>
       <textarea id="noteText" rows="6">${esc(chat.note)}</textarea>`,
      async (root) => {
        chat.note = root.querySelector("#noteText").value;
        await save();
        toast("유저 노트를 저장했어요.");
      },
    );
  }

  render();
  if (!isTouch) input.focus();
}

async function showChatList(c, active) {
  const chats = await db.listChats(c.id);
  const root = modal(
    `<h2>🗂 ${esc(c.name)}와의 대화</h2>
     <div class="chat-list">
       ${chats
         .map(
           (ch) => `<a href="#/chat/${c.id}/${ch.id}" class="chat-row ${ch.id === active.id ? "active" : ""}">
              <b>${esc(ch.title || "새 대화")}</b>
              <span>${new Date(ch.updatedAt).toLocaleString("ko-KR")} · 메시지 ${ch.messages.length}개</span>
            </a>`,
         )
         .join("")}
     </div>`,
  );
  root.addEventListener("click", (e) => e.target.closest("a") && root.remove());
}

function modal(inner, onOk) {
  const root = document.createElement("div");
  root.className = "modal-bg";
  root.innerHTML = `<div class="modal">${inner}
    <div class="modal-actions">
      <button class="btn ghost" data-m="close">${onOk ? "취소" : "닫기"}</button>
      ${onOk ? `<button class="btn primary" data-m="ok">저장</button>` : ""}
    </div></div>`;
  root.addEventListener("click", async (e) => {
    if (e.target === root || e.target.dataset.m === "close") root.remove();
    if (e.target.dataset.m === "ok") {
      await onOk(root);
      root.remove();
    }
  });
  document.body.appendChild(root);
  return root;
}

// ---------- 설정 ----------
async function viewSettings() {
  const s = settings;
  const main = await shell(
    `
    <header class="topbar">
      <button class="icon-btn back" onclick="history.back()">←</button>
      <h1>설정</h1>
      <div class="spacer"></div>
      <button class="btn primary" id="save">저장</button>
    </header>
    <div class="scroll">
      <form class="form" id="form" onsubmit="return false">
        <h3>AI 연결</h3>
        <label class="field"><span>Claude API 키</span>
          <input name="apiKey" type="password" autocomplete="off" value="${esc(s.apiKey)}" placeholder="sk-ant-...">
        </label>
        <p class="hint">키는 <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">Claude Console</a>에서 발급받을 수 있어요. 키는 이 기기에만 저장되고 Anthropic API 외에는 어디에도 전송되지 않습니다.</p>
        <label class="field"><span>모델</span>
          <select name="model">${MODELS.map((m) => `<option value="${m.id}" ${m.id === s.model ? "selected" : ""}>${m.label}</option>`).join("")}</select>
        </label>
        <label class="field"><span>사고 깊이 (effort)</span>
          <select name="effort">
            ${[
              ["low", "낮음 – 빠른 답변"],
              ["medium", "보통 (기본)"],
              ["high", "높음 – 더 깊이 생각"],
            ]
              .map(([v, l]) => `<option value="${v}" ${v === s.effort ? "selected" : ""}>${l}</option>`)
              .join("")}
          </select>
        </label>
        <label class="field"><span>답변 길이</span>
          <select name="length">${["짧게", "보통", "길게"].map((v) => `<option ${v === s.length ? "selected" : ""}>${v}</option>`).join("")}</select>
        </label>
        <label class="field"><span>최대 토큰 (답변 상한)</span>
          <input name="maxTokens" type="number" min="500" max="64000" step="500" value="${esc(s.maxTokens)}">
        </label>

        <h3>내 프로필 (페르소나)</h3>
        <label class="field"><span>내 이름</span><input name="userName" value="${esc(s.userName)}" placeholder="캐릭터가 부를 이름"></label>
        <label class="field"><span>나에 대한 설명</span>
          <textarea name="userPersona" rows="3" placeholder="예) 25살 직장인. 겁이 많지만 호기심이 강하다.">${esc(s.userPersona)}</textarea>
        </label>

        <h3>데이터</h3>
        <p class="hint">캐릭터와 대화는 모두 이 기기(브라우저)에만 저장됩니다. 다른 기기로 옮기려면 백업 파일을 사용하세요.</p>
        <div class="row">
          <button type="button" class="btn" id="backup">전체 백업 내보내기</button>
          <button type="button" class="btn" id="restore">백업 불러오기</button>
        </div>
      </form>
    </div>`,
    { view: "settings" },
  );

  const form = main.querySelector("#form");
  main.querySelector("#save").addEventListener("click", async () => {
    settings = {
      ...settings,
      apiKey: form.apiKey.value.trim(),
      model: form.model.value,
      effort: form.effort.value,
      length: form.length.value,
      maxTokens: Math.max(500, Number(form.maxTokens.value) || 4000),
      userName: form.userName.value.trim() || "나",
      userPersona: form.userPersona.value,
    };
    await db.saveSettings(settings);
    toast("설정을 저장했어요.");
    history.length > 1 ? history.back() : go("#/");
  });
  main.querySelector("#backup").addEventListener("click", async () => {
    download(`chat-my-mind-backup-${new Date().toISOString().slice(0, 10)}.json`, await db.exportAll());
  });
  main.querySelector("#restore").addEventListener("click", async () => {
    const f = await pickFile("application/json,.json");
    if (!f) return;
    try {
      await db.importAll(JSON.parse(await f.text()));
      toast("백업을 불러왔어요.");
      go("#/");
    } catch (e) {
      toast("불러오기 실패: " + e.message);
    }
  });
}

// ---------- 라우터 ----------
async function route() {
  if (current) {
    current.abort();
    current = null;
  }
  const [, page, a, b] = (location.hash || "#/").split("/");
  if (page === "chat" && a) return viewChat(a, b);
  if (page === "edit" && a) return viewEdit(a);
  if (page === "new") return viewEdit(null);
  if (page === "settings") return viewSettings();
  return viewHome();
}

(async function start() {
  settings = await db.getSettings();
  window.addEventListener("hashchange", route);
  await route();
  if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
