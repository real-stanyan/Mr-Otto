// 陈列馆的入口。**不进应用包**——由 scripts/build-face-gallery.mjs 单独 esbuild 成一张
// 自包含 HTML，打开文件即可看，不用起服务、不用装 Electron。
//
// 它是这个库的验收面：十五个状态、并行墙、明暗主题、尺寸切换、集成片段全在一页上。
// 之所以值得单独做而不是挂进应用里：数据源还没到位（#1282），接进花名册就只能看到
// 「空闲」一格；而这一页可以把十五格同时摆出来，对着看才知道哪两格撞脸。

import { createFace, FACE_CHARACTERS, scaleForHeight, FACE_STATES, FACE_STATE_LIST, OTTO, type FaceCharacter, type FaceHandle, type FaceState } from "../index.js";

const CHARACTERS: readonly FaceCharacter[] = FACE_CHARACTERS;
/** 并行墙演示的取样：覆盖五类强调色，因为一墙头像的第一眼是按色收敛的 */
const WALL: readonly FaceState[] = ["waiting", "queued", "thinking", "searching", "working", "answering", "done", "failed"];

const live: FaceHandle[] = [];
let character: FaceCharacter = CHARACTERS[0] ?? OTTO;
let scale = 3;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function mount(host: HTMLElement, state: FaceState, s: number, pointer: boolean, who: FaceCharacter = character): void {
  live.push(createFace(host, { character: who, state, scale: s, followPointer: pointer }));
}

function render(): void {
  for (const h of live.splice(0)) h.destroy();

  const wall = document.getElementById("wall");
  if (wall !== null) {
    wall.replaceChildren();
    for (const state of FACE_STATE_LIST) {
      const def = FACE_STATES[state];
      const card = el("div", "card");
      const stage = el("div", "stage");
      card.append(stage);
      const meta = el("div", "meta");
      const dot = el("span", "dot");
      dot.style.background = def.accent ?? "transparent";
      if (def.accent === undefined) dot.style.boxShadow = "inset 0 0 0 1px var(--line)";
      meta.append(dot, el("span", "zh", def.zh), el("code", "key", state));
      card.append(meta, el("div", "origin", def.origin));
      wall.append(card);
      mount(stage, state, scale, def.look === "pointer");
    }
  }

  const cast = document.getElementById("cast");
  if (cast !== null) {
    cast.replaceChildren();
    for (const who of CHARACTERS) {
      const cell = el("div", "rcell");
      const stage = el("div");
      cell.append(stage, el("span", "rlabel", who.name));
      cast.append(cell);
      mount(stage, "idle", scaleForHeight(who, 112), true, who);
    }
  }

  const roster = document.getElementById("roster");
  if (roster !== null) {
    roster.replaceChildren();
    // 一人一状态，不是同一张脸摆八遍——花名册上本来就是八个不同的 agent 各干各的，
    // 同脸摆八遍会把「角标够不够一眼分得开」这件事问漏
    for (const [i, state] of WALL.entries()) {
      const who = CHARACTERS[i % CHARACTERS.length] ?? OTTO;
      const cell = el("div", "rcell");
      const stage = el("div");
      cell.append(stage, el("span", "rlabel", `${who.name} · ${FACE_STATES[state].zh}`));
      roster.append(cell);
      mount(stage, state, scaleForHeight(who, 52), false, who);
    }
  }
}

function boot(): void {
  const pick = document.getElementById("character") as HTMLSelectElement | null;
  if (pick !== null) {
    pick.replaceChildren(...CHARACTERS.map((c) => {
      const o = el("option");
      o.value = c.id;
      o.textContent = `${c.name}（${c.w}×${c.h}）`;
      return o;
    }));
    pick.addEventListener("change", () => {
      character = CHARACTERS.find((c) => c.id === pick.value) ?? OTTO;
      render();
    });
  }

  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-scale]")) {
    btn.addEventListener("click", () => {
      scale = Number(btn.dataset["scale"] ?? "3");
      for (const b of document.querySelectorAll<HTMLButtonElement>("[data-scale]")) {
        b.dataset["on"] = b === btn ? "1" : "0";
      }
      render();
    });
  }

  const theme = document.getElementById("theme");
  theme?.addEventListener("click", () => {
    const next = document.documentElement.dataset["theme"] === "dark" ? "light" : "dark";
    document.documentElement.dataset["theme"] = next;
    theme.textContent = next === "dark" ? "☀ 亮色" : "☾ 暗色";
  });

  render();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
