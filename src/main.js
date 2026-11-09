import "./style.css";
import { api, streamReply } from "./store.js";
import { SAMPLE_CHARACTERS } from "./samples.js";

const app = document.getElementById("app");
let me = null; // { username, isAdmin, settings, models, usage }
let current = null; // 스트리밍 중인 요청 { abort }

// ---------- 유틸 ----------
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// *행동* → 기울임, **강조**, 줄바꿈 유지
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

const go = (hash) => (location.hash = hash);

// 이미지를 정사각형 256px JPEG 로 줄여 용량을 아낍니다.
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

// ---------- 로그인 / 가입 ----------
async function viewLogin(mode = "login") {
  const cfg = await api.config().catch(() => ({ signup: true, inviteRequired: false }));
  const isSignup = mode === "signup";
  app.innerHTML = `
    <div class="auth">
      <form class="auth-card" id="authForm">
        <div class="auth-logo">💬</div>
        <h1>Chat My Mind</h1>
        <p class="hint center">나만의 캐릭터를 만들고 AI와 대화하세요</p>
        <label class="field"><span>아이디</span><input name="username" autocomplete="username" required></label>
        <label class="field"><span>비밀번호${isSignup ? " (8자 이상)" : ""}</span>
          <input name="password" type="password" autocomplete="${isSignup ? "new-password" : "current-password"}" required></label>
        ${isSignup && cfg.inviteRequired ? `<label class="field"><span>초대 코드</span><input name="inviteCode" required></label>` : ""}
        <button class="btn primary block" type="submit">${isSignup ? "가입하기" : "로그인"}</button>
        ${
          cfg.signup
            ? `<button class="btn ghost block" type="button" id="switch">${isSignup ? "이미 계정이 있어요 · 로그인" : "처음이에요 · 회원가입"}</button>`
            : ""
        }
      </form>
    </div>`;
  const form = app.querySelector("#authForm");
  app.querySelector("#switch")?.addEventListener("click", () => viewLogin(isSignup ? "login" : "signup"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { username: form.username.value, password: form.password.value, inviteCode: form.inviteCode?.value };
    try {
      await (isSignup ? api.register(body) : api.login(body));
      me = await api.me();
      if (location.hash === "" || location.hash === "#/") route();
      else go("#/");
    } catch (err) {
      toast(err.message);
    }
  });
}
// 사용 중 세션이 만료된 경우에만 로그인 화면으로 (첫 로딩 때는 라우터가 처리)
window.addEventListener("auth-required", () => {
  if (!me) return;
  me = null;
  viewLogin();
});

// ---------- 레이아웃 ----------
// PC: 왼쪽 캐릭터 목록 + 오른쪽 화면 / 모바일: 한 번에 한 화면
async function shell(mainHTML, { view, activeChar, chars } = {}) {
  chars = chars || (await api.listCharacters());
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
        <div class="side-foot">${esc(me.username)} 님</div>
      </aside>
      <main class="main">${mainHTML}</main>
    </div>`;
  return app.querySelector(".main");
}

// ---------- 홈 ----------
async function viewHome() {
  const chars = await api.listCharacters();
  const main = await shell(
    `
    <header class="topbar">
      <h1>내 캐릭터</h1>
      <div class="spacer"></div>
      <button class="icon-btn" id="import" title="캐릭터 가져오기">📥</button>
      <a href="#/settings" class="icon-btn" title="설정">⚙️</a>
    </header>
    <div class="scroll">
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
      ${chars.length === 0 ? `<div class="empty">아직 캐릭터가 없어요.<br><button class="btn" id="samples">예시 캐릭터 불러오기</button></div>` : ""}
    </div>`,
    { view: "home", chars },
  );

  main.querySelector("#samples")?.addEventListener("click", async () => {
    for (const s of SAMPLE_CHARACTERS) await api.createCharacter(s);
    route();
  });
  main.querySelector("#import").addEventListener("click", importFile);
}

async function importFile() {
  const f = await pickFile("application/json,.json");
  if (!f) return;
  try {
    const r = await api.importAll(JSON.parse(await f.text()));
    toast(`캐릭터 ${r.imported}개를 가져왔어요.`);
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
  const c = isNew ? { emoji: "🙂", tags: [] } : await api.getCharacter(id);

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
  let avatar = c.avatar || "";
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

  const collect = () => {
    const data = { emoji: form.emoji.value || "🙂", avatar, tags: form.tags.value.split(",").map((t) => t.trim()).filter(Boolean) };
    for (const [k] of FIELDS) data[k] = form[k].value;
    data.name = data.name.trim();
    return data;
  };

  main.querySelector("#save").addEventListener("click", async (e) => {
    const data = collect();
    if (!data.name) {
      form.name.focus();
      return toast("이름을 입력하세요.");
    }
    e.target.disabled = true;
    try {
      const saved = isNew ? await api.createCharacter(data) : await api.updateCharacter(c.id, data);
      toast("저장했어요.");
      location.replace("#/chat/" + saved.id);
    } catch (err) {
      toast(err.message);
      e.target.disabled = false;
    }
  });

  main.querySelector("#export")?.addEventListener("click", () => {
    const { id: _i, updatedAt: _u, lastChatAt: _l, ...rest } = c;
    download(`${c.name || "character"}.json`, { app: "chat-my-mind", character: rest });
  });
  main.querySelector("#delete")?.addEventListener("click", async () => {
    if (!confirm(`'${c.name}' 캐릭터와 모든 대화를 삭제할까요?`)) return;
    await api.deleteCharacter(c.id);
    go("#/");
  });
}

// ---------- 채팅 ----------
async function viewChat(charId, chatId) {
  const [c, chat] = await Promise.all([api.getCharacter(charId), chatId ? api.getChat(chatId) : api.latestChat(charId)]);

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

  const atBottom = () => msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
  const scrollDown = () => (msgsEl.scrollTop = msgsEl.scrollHeight);

  function msgHTML(m, i) {
    const last = i === chat.messages.length - 1;
    const canRegen = m.role === "assistant" && last && !m.pending && !m.error && chat.messages.some((x) => x.role === "user");
    const saved = m.id && !m.pending && !m.error;
    return `
      <div class="msg ${m.role}" data-i="${i}">
        ${m.role === "assistant" ? avatarHTML(c, "xs") : ""}
        <div class="bubble-wrap">
          ${m.role === "assistant" ? `<div class="who">${esc(c.name)}</div>` : ""}
          <div class="bubble ${m.error ? "error" : ""}">${m.text ? renderText(m.text) : '<span class="typing"><i></i><i></i><i></i></span>'}</div>
          <div class="msg-actions">
            ${canRegen ? `<button data-act="regen" title="다시 생성">↻ 다시</button>` : ""}
            ${saved ? `<button data-act="edit" title="수정">✎ 수정</button><button data-act="del" title="삭제">✕ 삭제</button>` : ""}
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

  async function generate(body, optimisticUser) {
    chat.messages = chat.messages.filter((m) => !m.error);
    if (optimisticUser) chat.messages.push(optimisticUser);
    const reply = { role: "assistant", text: "", pending: true };
    chat.messages.push(reply);
    render();
    setBusy(true);

    const bubble = () => msgsEl.querySelector(`.msg[data-i="${chat.messages.indexOf(reply)}"] .bubble`);
    const req = streamReply(chat.id, body, (ev) => {
      if (ev.type === "user") Object.assign(optimisticUser, ev.message);
      else if (ev.type === "delta") {
        reply.text += ev.text;
        const stick = atBottom();
        const b = bubble();
        if (b) b.innerHTML = renderText(reply.text);
        if (stick) scrollDown();
      } else if (ev.type === "done") {
        Object.assign(reply, ev.message);
        if (ev.truncated) toast("답변이 최대 길이에 도달해 잘렸어요. 설정에서 최대 토큰을 늘릴 수 있어요.");
      } else if (ev.type === "error") {
        reply.text = ev.error;
        reply.error = true;
      }
    });
    current = req;
    try {
      await req.done;
    } catch (e) {
      if (e.name !== "AbortError") {
        if (optimisticUser && !optimisticUser.id) chat.messages.splice(chat.messages.indexOf(optimisticUser), 1);
        reply.text = e.message;
        reply.error = true;
      }
    } finally {
      current = null;
      setBusy(false);
      delete reply.pending;
      // 멈춘 경우 등은 서버에 저장된 상태와 맞추기 위해 다시 불러옵니다.
      if (!reply.id && !reply.error) {
        await new Promise((r) => setTimeout(r, 300));
        const fresh = await api.getChat(chat.id).catch(() => null);
        if (fresh) chat.messages = fresh.messages;
      }
      chat.messages = chat.messages.filter((m) => m.text);
      render();
    }
  }

  main.querySelector("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (current) return current.abort();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    autosize();
    generate({ text }, { role: "user", text });
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
    try {
      if (act === "regen") {
        chat.messages.splice(i, 1);
        generate({ regenerate: true });
      } else if (act === "del") {
        await api.deleteMessage(chat.id, m.id);
        chat.messages.splice(i, 1);
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
          try {
            if (b.dataset.e === "ok" && ta.value.trim()) {
              await api.editMessage(chat.id, m.id, ta.value.trim());
              m.text = ta.value.trim();
            }
          } catch (err) {
            toast(err.message);
          }
          render();
        });
      }
    } catch (err) {
      toast(err.message);
    }
  });

  // 메뉴
  main.querySelector("#menuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  main.addEventListener("click", () => (menu.hidden = true));
  menu.addEventListener("click", async (e) => {
    const act = e.target.closest("button")?.dataset.act;
    menu.hidden = true;
    try {
      if (act === "new") {
        current?.abort();
        const nc = await api.newChat(c.id);
        go(`#/chat/${c.id}/${nc.id}`);
      } else if (act === "chats") await showChatList(c, chat);
      else if (act === "note") showNote();
      else if (act === "edit") go("#/edit/" + c.id);
      else if (act === "clear") {
        if (!confirm("이 대화를 삭제할까요?")) return;
        current?.abort();
        await api.deleteChat(chat.id);
        const target = "#/chat/" + c.id;
        location.hash === target ? route() : go(target);
      }
    } catch (err) {
      toast(err.message);
    }
  });

  function showNote() {
    modal(
      `<h2>📝 유저 노트</h2>
       <p class="hint">캐릭터가 이 대화에서 항상 기억해야 할 내용을 적어 두세요. (예: 둘은 이미 사귀는 사이, 지금은 여름방학)</p>
       <textarea id="noteText" rows="6">${esc(chat.note)}</textarea>`,
      async (root) => {
        const note = root.querySelector("#noteText").value;
        await api.updateChat(chat.id, { note });
        chat.note = note;
        toast("유저 노트를 저장했어요.");
      },
    );
  }

  render();
  if (!isTouch) input.focus();
}

async function showChatList(c, active) {
  const chats = await api.listChats(c.id);
  const root = modal(
    `<h2>🗂 ${esc(c.name)}와의 대화</h2>
     <div class="chat-list">
       ${chats
         .map(
           (ch) => `<a href="#/chat/${c.id}/${ch.id}" class="chat-row ${ch.id === active.id ? "active" : ""}">
              <b>${esc(ch.title || "새 대화")}</b>
              <span>${new Date(ch.updatedAt).toLocaleString("ko-KR")} · 메시지 ${ch.messageCount}개</span>
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
      try {
        await onOk(root);
        root.remove();
      } catch (err) {
        toast(err.message);
      }
    }
  });
  document.body.appendChild(root);
  return root;
}

// ---------- 설정 ----------
async function viewSettings() {
  me = await api.me();
  const s = me.settings;
  const usage = me.usage.limit ? `오늘 ${me.usage.today} / ${me.usage.limit}회 사용` : `오늘 ${me.usage.today}회 사용 (무제한)`;
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
        <h3>계정</h3>
        <div class="account">
          <div><b>${esc(me.username)}</b>${me.isAdmin ? ' <i class="badge">관리자</i>' : ""}<br><span class="hint">${usage}</span></div>
          <div class="row">
            <button type="button" class="btn" id="pw">비밀번호 변경</button>
            <button type="button" class="btn ghost" id="logout">로그아웃</button>
          </div>
        </div>

        <h3>AI</h3>
        <label class="field"><span>모델</span>
          <select name="model">${me.models.map((m) => `<option value="${m.id}" ${m.id === s.model ? "selected" : ""}>${m.label}</option>`).join("")}</select>
        </label>
        <label class="field"><span>사고 깊이</span>
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
          <input name="maxTokens" type="number" min="500" max="32000" step="500" value="${esc(s.maxTokens)}">
        </label>

        <h3>내 프로필 (페르소나)</h3>
        <label class="field"><span>내 이름</span><input name="userName" value="${esc(s.userName)}" placeholder="캐릭터가 부를 이름"></label>
        <label class="field"><span>나에 대한 설명</span>
          <textarea name="userPersona" rows="3" placeholder="예) 25살 직장인. 겁이 많지만 호기심이 강하다.">${esc(s.userPersona)}</textarea>
        </label>

        <h3>데이터</h3>
        <p class="hint">캐릭터와 대화는 서버에 저장되어 어느 기기에서 로그인해도 이어서 볼 수 있어요.</p>
        <div class="row">
          <button type="button" class="btn" id="backup">전체 백업 내보내기</button>
          <button type="button" class="btn" id="restore">백업/캐릭터 불러오기</button>
        </div>
      </form>
    </div>`,
    { view: "settings" },
  );

  const form = main.querySelector("#form");
  main.querySelector("#save").addEventListener("click", async () => {
    try {
      me.settings = await api.saveSettings({
        model: form.model.value,
        effort: form.effort.value,
        length: form.length.value,
        maxTokens: Number(form.maxTokens.value),
        userName: form.userName.value,
        userPersona: form.userPersona.value,
      });
      toast("설정을 저장했어요.");
      go("#/");
    } catch (e) {
      toast(e.message);
    }
  });
  main.querySelector("#logout").addEventListener("click", async () => {
    await api.logout().catch(() => {});
    me = null;
    history.replaceState(null, "", location.pathname);
    viewLogin();
  });
  main.querySelector("#pw").addEventListener("click", () =>
    modal(
      `<h2>비밀번호 변경</h2>
       <label class="field"><span>현재 비밀번호</span><input id="pwCur" type="password" autocomplete="current-password"></label>
       <label class="field"><span>새 비밀번호 (8자 이상)</span><input id="pwNext" type="password" autocomplete="new-password"></label>`,
      async (root) => {
        await api.changePassword({ current: root.querySelector("#pwCur").value, next: root.querySelector("#pwNext").value });
        toast("비밀번호를 바꿨어요.");
      },
    ),
  );
  main.querySelector("#backup").addEventListener("click", async () => {
    download(`chat-my-mind-backup-${new Date().toISOString().slice(0, 10)}.json`, await api.exportAll());
  });
  main.querySelector("#restore").addEventListener("click", importFile);
}

// ---------- 라우터 ----------
async function route() {
  if (current) {
    current.abort();
    current = null;
  }
  if (!me) return viewLogin();
  const [, page, a, b] = (location.hash || "#/").split("/");
  try {
    if (page === "chat" && a) return await viewChat(a, b);
    if (page === "edit" && a) return await viewEdit(a);
    if (page === "new") return await viewEdit(null);
    if (page === "settings") return await viewSettings();
    return await viewHome();
  } catch (e) {
    if (e.status === 401) return;
    toast(e.message);
    if (e.status === 404) go("#/");
  }
}

(async function start() {
  window.addEventListener("hashchange", route);
  me = await api.me().catch(() => null);
  await route();
  if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
