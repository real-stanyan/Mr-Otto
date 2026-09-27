/* 微信式布局 demo 共用的一层（#1386）：图标、像素脸、数据、聊天引擎、时间线。
   桌面和手机两份 demo 读同一份，免得同一句话两处说法不一样。

   数据全是编的（一家卖香薰蜡烛的小店），不是任何人的真实数字。 */

/* ── 图标：lucide，和 app 同一套 ─────────────────────────────────────── */
function ic(name, size = 20, sw = 1.75, cls = "") {
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
}

/* ── 像素脸 ──────────────────────────────────────────────────────────────
   画料就是 src/shared/ottoFace（esbuild 内联进来的 OttoFace）。app 里脸画在圆盘上，
   这里照微信改成圆角方块：盘底色不变，脸按「64 格宽」缩进去，四角多露一点底。 */
const Face = (() => {
  const F = window.OttoFace;
  const CELLS = 63;
  const scratch = document.createElement("canvas");
  scratch.width = F.GRID_W;
  scratch.height = F.GRID_H;
  const sg = scratch.getContext("2d");
  const live = new Set();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");

  function draw(cv, t) {
    const g = cv.getContext("2d");
    if (!g) return;
    const px = cv.width;
    const slot = +cv.dataset.slot;
    const state = cv.dataset.state || "plain";
    const frame = F.composeFrame(slot, state, reduce.matches ? 0 : t);
    sg.clearRect(0, 0, F.GRID_W, F.GRID_H);
    for (const c of frame.cells) {
      const hex = frame.palette[c.key];
      if (!hex) continue;
      sg.fillStyle = hex;
      sg.fillRect(c.x, c.y, 1, 1);
    }
    g.clearRect(0, 0, px, px);
    g.fillStyle = F.DISC_COLOR;
    g.fillRect(0, 0, px, px);
    const cell = px / CELLS;
    g.imageSmoothingEnabled = cell < 1;
    g.imageSmoothingQuality = "high";
    if (frame.dim) g.globalAlpha = 0.45;
    g.drawImage(scratch, px / 2 - F.FACE_ORIGIN_X * cell, px / 2 - F.FACE_ORIGIN_Y * cell + 2 * cell, F.GRID_W * cell, F.GRID_H * cell);
    g.globalAlpha = 1;
  }

  function canvas(slot, state, size) {
    const cv = document.createElement("canvas");
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    cv.width = cv.height = Math.max(8, Math.round(size * dpr));
    cv.dataset.slot = slot;
    cv.dataset.state = state;
    draw(cv, 0);
    if (F.faceAnimates(state)) live.add(cv);
    return cv;
  }

  /* 把 [data-face] 占位换成画布。占位里写好尺寸（data-size），不量 DOM：
     藏着的节点量出来是 0。 */
  function hydrate(root = document) {
    root.querySelectorAll("[data-face]:not([data-hyd])").forEach((el) => {
      el.dataset.hyd = "1";
      const size = +(el.dataset.size || 40);
      el.appendChild(canvas(+el.dataset.face, el.dataset.state || "plain", size));
    });
  }

  function setState(el, state) {
    const cv = el && el.querySelector("canvas");
    if (!cv || cv.dataset.state === state) return;
    cv.dataset.state = state;
    el.dataset.state = state;
    if (F.faceAnimates(state)) live.add(cv);
    else live.delete(cv);
    draw(cv, performance.now());
  }

  let last = 0;
  (function loop(now) {
    requestAnimationFrame(loop);
    if (now - last < 33) return; // 30fps 够了：像素脸本来就是一格一格跳的
    last = now;
    for (const cv of live) {
      if (!cv.isConnected) { live.delete(cv); continue; }
      draw(cv, now);
    }
  })(0);

  return { hydrate, setState, canvas, animates: F.faceAnimates };
})();

/* ── 时间 ─────────────────────────────────────────────────────────────── */
const NOW = (() => {
  const d = new Date();
  d.setSeconds(0, 0);
  return d.getTime();
})();
const MIN = 60 * 1000;
const WEEK = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
function dayStart(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function hhmm(ts) { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
/* 列表里那一格：今天报钟点，昨天写「昨天」，一周内写星期几，再早写月/日（照微信） */
function listTime(ts) {
  const today = dayStart(Date.now());
  const d = dayStart(ts);
  const days = Math.round((today - d) / 86400000);
  if (days <= 0) return hhmm(ts);
  if (days === 1) return "昨天";
  if (days < 7) return WEEK[new Date(ts).getDay()];
  const x = new Date(ts);
  return `${x.getMonth() + 1}/${x.getDate()}`;
}
/* 时间线里的分隔：同一天只写钟点，其余加上日子 */
function sepTime(ts) {
  const lt = listTime(ts);
  return lt.includes(":") ? lt : `${lt} ${hhmm(ts)}`;
}

/* ── 数据 ─────────────────────────────────────────────────────────────── */
const ME = { id: "me", name: "Stan", email: "stan@example.com", avatar: null };
/* 没设头像就用名字的第一个字（拉丁字母大写） */
function meInitial() { return (ME.name.trim()[0] || "?").toUpperCase(); }

const AGENTS = {
  a_admin: { id: "a_admin", name: "管理员", slot: 6, role: "帮你建新同事、派活", admin: true, voice: "沉稳男声", usage: 4 },
  a_kefu: { id: "a_kefu", name: "客服", slot: 7, role: "回淘宝和小红书的私信，差评先拟好回复给你看", voice: "温柔女声", usage: 24 },
  a_wenan: { id: "a_wenan", name: "文案", slot: 4, role: "写小红书笔记和商品详情页", voice: "清亮女声", usage: 31 },
  a_toufang: { id: "a_toufang", name: "投放", slot: 2, role: "管 Google Ads 的预算和关键词", voice: "干脆男声", usage: 18 },
  a_shuju: { id: "a_shuju", name: "数据", slot: 5, role: "每周一出周报：订单、复购、客单价", voice: "沉稳男声", usage: 12 },
  a_jizhang: { id: "a_jizhang", name: "记账", slot: 8, role: "对流水、整理报销单", voice: "温柔女声", usage: 6 },
  a_xuanpin: { id: "a_xuanpin", name: "选品", slot: 10, role: "盯同行的上新和价格", voice: "清亮女声", usage: 5 },
  /* 小红的智能体：她建的群里有它，干活走她的额度（群主的） */
  t_zhiban: { id: "t_zhiban", name: "值班", slot: 0, role: "盯店里的杂事：备货、摊位、差评", owner: "f_xh" },
};
const MY_AGENTS = ["a_admin", "a_kefu", "a_wenan", "a_toufang", "a_shuju", "a_jizhang", "a_xuanpin"];

const FRIENDS = {
  f_xh: { id: "f_xh", name: "小红", initial: "红", note: "店里的合伙人" },
  f_aj: { id: "f_aj", name: "阿杰", initial: "杰", note: "周末来帮忙" },
  f_lw: { id: "f_lw", name: "老王", initial: "王", note: "蜡和罐子的供货商" },
};
const MY_FRIENDS = ["f_xh", "f_aj", "f_lw"];
const FRIEND_REQUESTS = [{ id: "r1", name: "林小满", initial: "林", text: "我是做干花的，想和你们一起摆摊" }];


function who(id) {
  if (id === "me") return { kind: "me", name: "我", initial: meInitial() };
  if (AGENTS[id]) return { kind: "agent", ...AGENTS[id] };
  if (FRIENDS[id]) return { kind: "human", ...FRIENDS[id] };
  return { kind: "human", name: id, initial: id.slice(0, 1) };
}

/* 消息：[几分钟前, 谁, 正文, 类型?]。类型：sys（居中灰字）/ relay（接力线）/ dispatch（派活线）/ call */
function seed(rows) {
  return rows.map(([ago, from, text, kind, meta], i) => ({ id: "m" + Math.random().toString(36).slice(2, 9) + i, t: NOW - ago * MIN, from, text, kind: kind || "text", meta }));
}

const CHATS = {
  c_wenan: {
    id: "c_wenan", kind: "dm", agent: "a_wenan", unread: 2,
    msgs: seed([
      [1452, "me", "上周那篇白茶的笔记数据怎么样？"],
      [1451, "a_wenan", "收藏 312，比上一篇多一倍。"],
      [1451, "a_wenan", "评论里好几个人问有没有小罐的，我记下了，写雪松的时候可以提一句。"],
      [6, "me", "帮我写一段新品「雪松」蜡烛的小红书笔记，别太硬广"],
      [4, "a_wenan", "写好了，走「下班回家点一支」的路子，不提成分，也不堆形容词："],
      [4, "a_wenan", "【下班后的四十分钟】\n推开门，先点一支雪松。\n木头的味道慢慢铺开，像把一整天关在了门外。\n手机扔远一点，今晚只归自己。\n#香薰蜡烛 #下班仪式感 #山茶小铺"],
      [4, "a_wenan", "要不要再出一版短的，配图的时候用？"],
    ]),
  },
  c_shangxin: {
    id: "c_shangxin", kind: "group", name: "上新小队", owner: "me", humans: [], agents: ["a_wenan", "a_xuanpin", "a_toufang"], unread: 3,
    msgs: seed([
      [1010, "sys", "你建了群聊「上新小队」", "roster", { added: ["a_wenan", "a_xuanpin", "a_toufang"] }],
      [1008, "me", "雪松下周三上新，你们仨对一下节奏"],
      [1007, "a_xuanpin", "这批雪松一共 120 罐。按白茶那次的节奏，头三天能走四成左右。"],
      [1006, "a_wenan", "笔记我周一给初稿。@投放 你那边要几个版本？"],
      [1006, "sys", "", "relay", { from: "a_wenan", to: "a_toufang" }],
      [1005, "a_toufang", "三个就够，一长两短。"],
      [40, "me", "周三几点开卖比较好？"],
      [40, "sys", "", "dispatch", { to: "a_xuanpin" }],
      [39, "a_xuanpin", "晚上八点。"],
      [39, "a_xuanpin", "同行上周三款新品都是八点上的，那个点收藏和加购最高。"],
      [12, "a_toufang", "预算我先按每天 ¥300 跑两天，看点击再调。"],
      [11, "a_wenan", "收到，笔记里写「周三晚八点」。"],
    ]),
  },
  s_shiji: {
    id: "s_shiji", kind: "group", name: "山茶小铺", owner: "f_xh", humans: ["f_xh", "f_aj"], agents: ["t_zhiban"], unread: 3, mention: true,
    msgs: seed([
      [300, "sys", "小红 建了群聊「山茶小铺」，拉进了你、阿杰和她的智能体「值班」"],
      [290, "f_xh", "@值班 帮我把周六市集的摊位清单列一下"],
      [289, "t_zhiban", "列好了：\n1. 桌布、价签、收款码\n2. 雪松、白茶、无花果各 20 罐\n3. 试香纸两盒、纸袋 50 个"],
      [289, "t_zhiban", "周六下午有阵雨，要不要带把大伞？"],
      [26, "f_aj", "我九点到，帮忙搬货"],
      [21, "f_xh", "带伞 +1"],
      [20, "f_xh", "@Stan 你那边能带收款码的立牌吗"],
    ]),
  },
  s_chaping: {
    id: "s_chaping", kind: "group", name: "差评处理", owner: "f_xh", humans: ["f_xh"], agents: ["t_zhiban"], unread: 0,
    msgs: seed([
      [2910, "t_zhiban", "淘宝那条说「味道太淡」的差评，我拟了个回复，放在「差评回复.md」里，你们看一眼再发。"],
      [2890, "f_xh", "可以，发吧"],
      [2889, "t_zhiban", "发了。"],
    ]),
  },
  c_xh: {
    id: "c_xh", kind: "friend", friend: "f_xh", unread: 2,
    msgs: seed([
      [2600, "me", "周六市集你几点到？"],
      [2590, "f_xh", "八点半，先去仓库拿货"],
      [58, "f_xh", "新包装的样品到了"],
      [57, "f_xh", "瓶盖换成木头的了，手感好很多，明天拿给你看"],
    ]),
  },
  c_kefu: {
    id: "c_kefu", kind: "dm", agent: "a_kefu", unread: 0,
    msgs: seed([
      [1310, "a_kefu", "今天 14 条私信都回了。"],
      [1310, "a_kefu", "有 2 条要你看一眼：一个问能不能开发票，一个说收到的罐子有裂。"],
      [1296, "me", "裂的那个直接补发，发票可以开"],
      [1295, "a_kefu", "好，补发单建好了，单号已经发给她。"],
    ]),
  },
  c_shuju: {
    id: "c_shuju", kind: "dm", agent: "a_shuju", unread: 0,
    msgs: seed([
      [2020, "a_shuju", "上周的周报：订单 186 单，客单价 ¥128，复购率 18%，比前一周高 3 个点。"],
      [2020, "a_shuju", "白茶那篇笔记带来的新客最多，差不多三成。"],
    ]),
  },
  c_zhoubao: {
    id: "c_zhoubao", kind: "group", name: "周报", owner: "me", humans: [], agents: ["a_shuju", "a_jizhang"], unread: 0,
    msgs: seed([
      [4400, "sys", "你建了群聊「周报」", "roster", { added: ["a_shuju", "a_jizhang"] }],
      [2900, "a_jizhang", "本周流水对完了，和后台差 ¥36，是一笔退款还没到账。"],
      [2890, "a_shuju", "周报里我按到账前的数算，脚注写一句。"],
    ]),
  },
  c_admin: {
    id: "c_admin", kind: "dm", agent: "a_admin", unread: 0,
    msgs: seed([
      [5802, "me", "帮我建一个管广告的"],
      [5801, "a_admin", "建好了，叫「投放」，职责是「管 Google Ads 的预算和关键词」。"],
      [5801, "a_admin", "要不要先跟它打个招呼？"],
    ]),
  },
  c_toufang: {
    id: "c_toufang", kind: "dm", agent: "a_toufang", unread: 0,
    msgs: seed([
      [5790, "a_toufang", "你好，我是投放。以后 Google Ads 的事交给我。"],
      [5760, "me", "先把每天预算控制在 300 以内"],
      [5759, "a_toufang", "记下了，超过 300 我会先停再问你。"],
    ]),
  },
  c_aj: {
    id: "c_aj", kind: "friend", friend: "f_aj", unread: 0,
    msgs: seed([[8100, "me", "周六能来帮忙吗？"], [8000, "f_aj", "好的，周六我九点到"]]),
  },
  c_jizhang: {
    id: "c_jizhang", kind: "dm", agent: "a_jizhang", unread: 0,
    msgs: seed([[9050, "a_jizhang", "九月的报销单整理好了，一共 11 张，放在「报销/九月」里。"]]),
  },
  c_xuanpin: {
    id: "c_xuanpin", kind: "dm", agent: "a_xuanpin", unread: 0,
    msgs: seed([[11200, "a_xuanpin", "同行「木屿」这周降价了，雪松那款从 ¥89 调到 ¥79。"]]),
  },
};

/* 群聊不分有没有真人（维护者 2026-09-27）：一个群 = 你 + 几只智能体 + 几个朋友，谁都可以没有。
   群主是建群的那个人；群里的智能体归群主管，干活走群主的额度（今天团队的规矩原样搬过来）。 */
function groupMembers(c) { return [...(c.humans || []), ...c.agents]; }
function chatTitle(c) {
  if (c.kind === "dm") return AGENTS[c.agent].name;
  if (c.kind === "friend") return FRIENDS[c.friend].name;
  if (c.kind === "group") return c.name || groupMembers(c).map((id) => who(id).name).join("、");
  return "";
}
function chatHeadcount(c) { return c.kind === "group" ? groupMembers(c).length + 1 : 0; }
function chatParticipants(c) {
  if (c.kind === "dm") return [c.agent];
  if (c.kind === "friend") return [c.friend];
  if (c.kind === "group") return groupMembers(c);
  return [];
}
function lastMsg(c) {
  for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].kind !== "relay") return c.msgs[i];
  return null;
}
function chatUpdated(c) { const m = c.msgs[c.msgs.length - 1]; return m ? m.t : 0; }

function previewOf(c) {
  if (c.draft) return { draft: true, text: c.draft };
  const m = lastMsg(c);
  if (!m) return { text: "" };
  if (m.kind === "call") return { text: "[语音通话]" };
  if (m.kind === "sys") return { text: m.text };
  if (m.kind === "roster") return { text: m.text };
  if (m.kind === "dispatch") return { text: `没 @ 谁，${AGENTS[m.meta.to].name}接了` };
  const multi = c.kind === "group";
  const name = m.from === "me" ? "" : multi ? who(m.from).name + ": " : "";
  return { text: name + m.text.replace(/\n+/g, " ") };
}

/* 列表：私聊、群聊、朋友混排，按最近一条排 */
function listRows() {
  return Object.values(CHATS).map((c) => ({ type: "chat", id: c.id, ts: chatUpdated(c), chat: c })).sort((a, b) => b.ts - a.ts);
}
function totalUnread() {
  let n = 0;
  for (const c of Object.values(CHATS)) n += c.unread;
  return n;
}

/* ── 头像 HTML ────────────────────────────────────────────────────────── */
function avatar(id, size = 40, state = "plain") {
  if (id === "me") return ME.avatar
    ? `<span class="av" style="--s:${size}px"><img src="${ME.avatar}" alt=""></span>`
    : `<span class="av human me-av" style="--s:${size}px">${esc(meInitial())}</span>`;
  const a = AGENTS[id];
  if (a) return `<span class="av" style="--s:${size}px" data-face="${a.slot}" data-state="${state}" data-size="${size}" data-agent="${id}"></span>`;
  const f = FRIENDS[id] || { initial: id.slice(0, 1) };
  return `<span class="av human" style="--s:${size}px">${f.initial}</span>`;
}
/* 群头像：微信那种九宫格，不满一行的那一行放在最上面、居中 */
function groupAvatar(ids, size = 40) {
  const n = Math.min(ids.length, 9);
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  const pad = size * 0.06;
  const gap = Math.max(1, size * 0.035);
  const cell = (size - pad * 2 - gap * (cols - 1)) / cols;
  const rows = [];
  let rest = n;
  const first = n % cols || cols;
  rows.push(first);
  rest -= first;
  while (rest > 0) { rows.push(cols); rest -= cols; }
  let k = 0;
  const html = rows.map((cnt) => {
    const cells = [];
    for (let i = 0; i < cnt; i++, k++) {
      const id = ids[k];
      const a = AGENTS[id];
      if (a) cells.push(`<span class="mini" style="width:${cell}px;height:${cell}px" data-face="${a.slot}" data-size="${cell}"></span>`);
      else {
        const w = who(id);
        cells.push(`<span class="mini human" style="width:${cell}px;height:${cell}px;font-size:${cell * 0.5}px">${w.initial}</span>`);
      }
    }
    return `<span style="display:flex;justify-content:center;gap:${gap}px">${cells.join("")}</span>`;
  }).join("");
  return `<span class="av grp" style="--s:${size}px;gap:${gap}px;padding:${pad}px;display:flex;flex-direction:column;justify-content:center">${html}</span>`;
}
function chatAvatar(c, size = 40) {
  if (c.kind === "dm") return avatar(c.agent, size);
  if (c.kind === "friend") return avatar(c.friend, size);
  if (c.kind === "group") return groupAvatar(groupMembers(c).length ? groupMembers(c) : ["me"], size);
  return "";
}

function esc(s) { return String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]); }
function richText(s) {
  return esc(s).replace(/@([一-龥A-Za-z0-9_]+)/g, '<span class="mention">@$1</span>');
}

/* ── 时间线 ───────────────────────────────────────────────────────────── */
function namesLine(ids) {
  return ids.map((id) => `<span class="who">${avatar(id, 14)}${esc(who(id).name)}</span>`).join("<span>、</span>");
}
function timelineHTML(c, opts = {}) {
  const multi = c.kind === "group";
  const av = opts.avatar || 36;
  let out = "";
  let prevT = 0;
  for (const m of c.msgs) {
    if (!prevT || m.t - prevT > 5 * MIN) out += `<div class="tl-time">${sepTime(m.t)}</div>`;
    prevT = m.t;
    const fresh = opts.fresh && opts.fresh.has(m.id) ? " fresh" : "";
    if (m.kind === "sys") { out += `<div class="tl-sys${fresh}">${esc(m.text)}</div>`; continue; }
    if (m.kind === "roster") { out += `<div class="tl-sys${fresh}"><span>${esc(m.text)}，拉进了</span>${namesLine(m.meta.added)}</div>`; continue; }
    if (m.kind === "rosterchg") { out += `<div class="tl-sys${fresh}"><span>${esc(m.text)}</span>${namesLine(m.meta.ids)}</div>`; continue; }
    if (m.kind === "relay") { out += `<div class="tl-sys${fresh}">${namesLine([m.meta.from])}<span>把话递给了</span>${namesLine([m.meta.to])}</div>`; continue; }
    if (m.kind === "dispatch") { out += `<div class="tl-sys${fresh}"><span>没 @ 谁，</span>${namesLine([m.meta.to])}<span>接了</span></div>`; continue; }
    if (m.kind === "call" && multi) {
      out += `<div class="tl-sys link${fresh}" data-call="${m.id}">${ic("phone", 13, 2)}<span>语音通话 ${esc(m.meta.dur)} · ${m.meta.lines.length} 句</span></div>`;
      continue;
    }
    const mine = m.from === "me";
    const w = who(m.from);
    const nameRow = multi && !mine ? `<div class="name">${esc(w.name)}</div>` : "";
    let bubble;
    if (m.kind === "call") bubble = `<div class="bubble call" data-call="${m.id}">${ic("phone", 15, 2)}<span>通话时长 ${esc(m.meta.dur)}</span></div>`;
    else if (m.meta && m.meta.voice) bubble = `<div class="bubble voice-note"><span class="vmark">${ic("mic", 14, 2)}</span>${richText(m.text)}</div>`;
    else bubble = `<div class="bubble">${richText(m.text)}</div>`;
    out += `<div class="msg ${mine ? "me" : "them"}${fresh}" data-from="${m.from}">${avatar(m.from, av)}<div class="body">${nameRow}${bubble}</div></div>`;
  }
  if (c.pending) {
    const p = c.pending;
    const nameRow = multi ? `<div class="name">${esc(who(p.agent).name)}</div>` : "";
    out += `<div class="msg them pending">${avatar(p.agent, av, p.phase === "typing" ? "composing" : "working")}<div class="body">${nameRow}<div class="bubble typing" aria-label="${esc(who(p.agent).name)}正在回复"><i></i><i></i><i></i></div></div></div>`;
  }
  if (c.onboarding) {
    out += `<div class="role-chips">${ROLE_CHIPS.map((r) => `<button class="chip" data-chip="${esc(r)}">${esc(r)}</button>`).join("")}</div>`;
  }
  return out;
}

/* 通讯录里「智能体」「朋友」两段各自能折叠（维护者 2026-09-27：分得清楚一点）。
   折叠状态记在这台机器上；搜索时一律展开，免得搜到的那一行被折叠藏起来。 */
const Fold = (() => {
  let state = {};
  try { state = JSON.parse(localStorage.getItem("otto-wx-fold") || "{}"); } catch {}
  const save = () => { try { localStorage.setItem("otto-wx-fold", JSON.stringify(state)); } catch {} };
  function html(key, label, count, action, body, forceOpen) {
    const open = forceOpen || !state[key];
    return `<section class="fold-sec"><div class="fold-row"><button class="fold-head" data-fold="${key}" aria-expanded="${open}" aria-controls="fold-${key}">${ic("chevron-down", 14, 2.2)}<span class="fold-t">${label}</span><span class="fold-n">${count}</span></button>${action || ""}</div><div class="fold-body${open ? "" : " closed"}" id="fold-${key}"${open ? "" : " inert"}><div class="fold-inner">${body}</div></div></section>`;
  }
  /* 只切 class，不重画：重画会把高度那一下过渡吃掉 */
  function bind(root) {
    root.querySelectorAll("[data-fold]").forEach((b) => b.addEventListener("click", () => {
      const key = b.dataset.fold;
      const body = root.querySelector("#fold-" + key);
      const open = b.getAttribute("aria-expanded") !== "true";
      b.setAttribute("aria-expanded", String(open));
      body.classList.toggle("closed", !open);
      body.inert = !open;
      state[key] = !open;
      save();
    }));
  }
  return { html, bind };
})();

/* 换头像：从相册挑一张，居中裁成正方形、缩到 256px。demo 里只留在这一页的内存里，不上传 */
function pickAvatarFile(onDone) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.style.display = "none";
  document.body.appendChild(input);
  input.addEventListener("change", () => {
    const f = input.files && input.files[0];
    input.remove();
    if (!f) return;
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const cv = document.createElement("canvas");
      cv.width = cv.height = 256;
      const g = cv.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
      URL.revokeObjectURL(url);
      onDone(cv.toDataURL("image/jpeg", 0.88));
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  });
  input.click();
}

/* 改密码那张卡的判据：两个 demo 共用，免得两边提示说法不一样 */
function passwordProblem(cur, next, again) {
  if (next && next.length < 8) return "新密码至少 8 位";
  if (again && next !== again) return "两次输的新密码不一样";
  if (next && cur && next === cur) return "新密码和现在的一样";
  return "";
}
function passwordReady(cur, next, again) { return !!cur && next.length >= 8 && next === again && next !== cur; }

const ROLE_CHIPS = ["回客人的私信", "写小红书笔记", "每天盯订单", "整理报销单", "做每周的周报", "查同行的价格"];

/* ── 聊天引擎 ─────────────────────────────────────────────────────────── */
const Sim = (() => {
  const subs = new Set();
  const fresh = new Set();
  let open = null; // 此刻开着的那条（开着的不记未读）
  const emit = (id) => subs.forEach((f) => f(id));
  const later = (ms) => new Promise((r) => setTimeout(r, ms));

  function push(c, from, text, kind = "text", meta) {
    const m = { id: "m" + Math.random().toString(36).slice(2, 10), t: Date.now(), from, text, kind, meta };
    c.msgs.push(m);
    fresh.add(m.id);
    if (from !== "me" && c.id !== open && kind !== "relay") c.unread++;
    emit(c.id);
    return m;
  }

  /* 一条回复按空行拆成几张气泡（ADR-0266），一张一张落 */
  async function reply(c, agentId, parts, voice) {
    c.pending = { agent: agentId, phase: "working" };
    emit(c.id);
    await later(900 + Math.random() * 700);
    c.pending = { agent: agentId, phase: "typing" };
    emit(c.id);
    await later(700 + Math.random() * 400);
    for (let i = 0; i < parts.length; i++) {
      if (i === parts.length - 1) c.pending = null;
      push(c, agentId, parts[i]);
      if (i < parts.length - 1) await later(650);
    }
    c.pending = null;
    emit(c.id);
  }


  function pickByRole(ids, text) {
    const hit = ids.find((id) => (KEYWORDS[id] || []).some((k) => text.includes(k)));
    return hit || ids[0];
  }

  async function send(c, text, meta) {
    text = text.trim();
    if (!text) return;
    c.draft = "";
    push(c, "me", text, "text", meta);
    if (c.onboarding) {
      const a = AGENTS[c.agent];
      a.role = text.split("\n")[0].slice(0, 40);
      c.onboarding = false;
      await reply(c, c.agent, [`好，记下了：「${a.role}」。`, "以后这类活直接丢给我。想改职责的话，点右上角随时能改。"]);
      return;
    }
    if (c.kind === "dm") return reply(c, c.agent, replyFor(c.agent, text));
    if (c.kind === "friend") {
      await later(2600);
      push(c, c.friend, FRIEND_REPLIES[c.friend] || "好");
      return;
    }
    /* 群：@ 了谁谁接；只 @ 了人就只有人回，不起任何一只智能体（ADR-0252）；
       谁都没 @ 时智能体按职责自己接（ADR-0270），群里没有智能体就等朋友回 */
    const humans = c.humans || [];
    const atAgents = c.agents.filter((id) => text.includes("@" + AGENTS[id].name));
    const atHumans = humans.filter((id) => text.includes("@" + FRIENDS[id].name));
    if (!atAgents.length && !atHumans.length) {
      if (c.agents.length) {
        const t = pickByRole(c.agents, text);
        push(c, "sys", "", "dispatch", { to: t });
        await reply(c, t, replyFor(t, text));
      } else if (humans.length) {
        await later(2600);
        push(c, humans[0], FRIEND_REPLIES[humans[0]] || "好");
      }
      return;
    }
    for (const t of atAgents) await reply(c, t, replyFor(t, text));
    for (const h of atHumans) { await later(2200); push(c, h, FRIEND_REPLIES[h] || "好"); }
  }

  return {
    on: (f) => (subs.add(f), () => subs.delete(f)),
    send,
    push,
    setOpen(id) {
      open = id;
      if (id && CHATS[id]) { CHATS[id].unread = 0; CHATS[id].mention = false; }
      emit(id);
    },
    get open() { return open; },
    fresh,
    emit,
  };
})();

const KEYWORDS = {
  a_wenan: ["文案", "笔记", "标题", "写"],
  a_xuanpin: ["价格", "同行", "几点", "上新", "卖"],
  a_toufang: ["广告", "预算", "投", "点击"],
  a_shuju: ["数据", "周报", "复购", "订单"],
  a_jizhang: ["账", "流水", "报销", "钱"],
  t_zhiban: ["摊位", "备货", "差评", "伞", "立牌"],
};

const FRIEND_REPLIES = { f_xh: "好呀，明天店里见", f_aj: "收到", f_lw: "没问题，下周二发货" };

function replyFor(agentId, text) {
  const pick = (arr) => arr;
  switch (agentId) {
    case "a_wenan":
      if (/短|简|配图/.test(text)) return pick(["短版：", "下班，先点一支雪松。\n今晚只归自己。\n#山茶小铺"]);
      if (/标题/.test(text)) return pick(["给你三个挑：\n1. 下班后的四十分钟\n2. 把一整天关在门外\n3. 今晚只点一支雪松"]);
      return pick(["好，我改一下。", "改完了：把「仪式感」这个词拿掉了，读起来不那么像广告。你看行不行？"]);
    case "a_kefu":
      return pick(["收到，我去回。", "回完了。那位客人问能不能周五前到，我说周四发顺丰。"]);
    case "a_toufang":
      return pick(["好。", "关键词我加了「送女朋友 香薰」和「助眠 蜡烛」，预算不变，明早看数据。"]);
    case "a_shuju":
      return pick(["我拉一下后台。", "这周到目前 97 单，比上周同期多 12 单，主要是雪松的预售。"]);
    case "a_jizhang":
      return pick(["收到。", "流水对上了，这周没有对不上的。"]);
    case "a_xuanpin":
      return pick(["我去看一眼同行。", "「木屿」和「小森林」这周都没动价格，我们维持 ¥89 没问题。"]);
    case "a_admin":
      if (/建|新/.test(text)) return pick(["可以。想让它叫什么、主要干什么？", "说一句就行，比如「帮我回私信的，叫客服」。"]);
      return pick(["收到，我看看派给谁合适。", "这件事交给「客服」最顺手，我已经跟它说了。"]);
    case "t_zhiban":
      if (/立牌|收款/.test(text)) return pick(["收款码立牌店里有两个，我记在清单第 1 条了。"]);
      return pick(["收到。", "我加进周六的清单里了。"]);
    default:
      return pick(["收到，我去弄。", "弄好了，你看一下有没有要改的。"]);
  }
}

/* 通话的台词（demo 里自己演一遍） */
function callScript(agentId) {
  const a = AGENTS[agentId];
  if (agentId === "a_wenan")
    return [
      ["me", "雪松那篇笔记，你念一下开头？"],
      [agentId, "推开门，先点一支雪松。木头的味道慢慢铺开，像把一整天关在了门外。"],
      ["me", "可以，就这么发"],
      [agentId, "好，我现在去发，发完在聊天里告诉你。"],
    ];
  return [
    ["me", `${a.name}，今天有什么要我看的吗？`],
    [agentId, "有一件：昨天那两条私信我已经处理完了，其他都正常。"],
    ["me", "好，辛苦"],
    [agentId, "不客气，有事随时叫我。"],
  ];
}

const EMOJI = "😀😄😂🥹😊😉😍🥰😘😋😎🤔🤨😐😴😷🤒🥳😭😤😡🙏👍👎👏🙌💪👌✌️🤝❤️🔥✨🎉💯✅❌⭐🌙☀️🌧️🕯️🌲🍵🎁📦📌".match(/\p{Extended_Pictographic}️?/gu);

/* 「今天没有的」那张单子：demo 里出现、app 里还不存在的东西 */
const NEW_THINGS = [
  ["每条聊天的未读数", "今天只有有人 @ 你、和好友私聊有；智能体聊天要 runtime 多投影一格消息计数 + 每人一份已读游标（#1282）"],
  ["桌面列表的最后一句", "手机端已经在读 last_ts / last_excerpt；桌面还没接"],
  ["头部「正在输入 / 正在干活」", "按有没有流式碎片分两档；今天只有那枚输入指示器"],
  ["群聊不分有没有真人", "团队和群聊合成一个（维护者 2026-09-27）。今天团队自带一批智能体、你的智能体进不了团队，一个团队下还有好几条会话；落地要改后端：智能体跟着群主进群、额度记在群主头上、旧团队的每条会话变成一个群"],
  ["手机端的朋友，和有真人的群", "今天手机上一个都没有"],
  ["按住说话", "手机端：说完转成文字发出去（通话那套识别已经在，缺一个按住的模式）"],
  ["表情", "只是往输入框里插 emoji，不是贴图"],
  ["额度只按周算", "去掉「5 小时」那扇窗（维护者 2026-09-27）；这次只改设计，真规矩不动，落地时网关、价目表、接力刹车都要跟着改"],
];

const REMOVED_THINGS = [
  "侧栏的「任务」「项目」两栏，以及本机会话的一切",
  "右侧面板：文件 / 终端 / 浏览器 / iOS 模拟器 / 后台任务 / Git Graph",
  "⌘K 会话搜索、SideChat（/btw）、残留清单、发布到团队",
  "设置里 9 个本机分页：工作区 / 模型配置 / Skill 库 / 子智能体 / 连接器(mcp.json) / 权限 / 记忆(本机) / 上下文 / 手机配对",
];
