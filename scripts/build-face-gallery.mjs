// 会动的像素脸的陈列馆（#1345，ADR-0311）：13 个坑位 × 16 个表情，一页看全。
//
// 为什么要这么一个脚本：这套形象**在 app 里看不全**。名册那一墙一律 `plain`，
// 会动的只有正开着的那条私聊头部与通话里那几格，而一个表情要凑齐条件才出得来
// （限流 / 冻结 / 出错各要一次真事故）。没有这一页，改一格眉毛只能靠想象。
//
// 产物是**一个自包含的 html**：把真的 `lib/ottoFace/` 用 esbuild 内联进去，
// 开文件就能看，也发得出去给人挑。inline 而不是引一份 bundle，是因为这页的
// 用法就是「丢给维护者点开」（同 docs/replay-demo.html 的形态）。
//
//   node scripts/build-face-gallery.mjs [输出路径]
//
// 默认写 .demo/face-gallery.html。**它不进门禁**：这一页的判据在
// tests/renderer/ottoFace/，这里只是让人看一眼。

import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = join(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(root, ".demo/face-gallery.html"));

const entry = `
import { FACE_CHARACTERS } from "${join(root, "src/renderer/src/lib/ottoFace/sprites.ts")}";
import { FACE_STATES, faceAnimates } from "${join(root, "src/renderer/src/lib/ottoFace/states.ts")}";
import { paintFace, sizeFaceCanvas } from "${join(root, "src/renderer/src/lib/ottoFace/paint.ts")}";

const STATES = Object.keys(FACE_STATES);
const SIZES = [24, 40, 80];
const live = [];

function face(slot, state, size) {
  const cv = document.createElement("canvas");
  cv.style.width = size + "px";
  cv.style.height = size + "px";
  cv.style.borderRadius = "50%";
  cv.style.imageRendering = "pixelated";
  sizeFaceCanvas(cv, size, window.devicePixelRatio || 1);
  paintFace(cv, slot, state, 0);
  if (faceAnimates(state)) live.push([cv, slot, state]);
  return cv;
}

function cell(label, node, sub) {
  const d = document.createElement("div");
  d.className = "cell";
  d.appendChild(node);
  const t = document.createElement("span");
  t.textContent = label;
  d.appendChild(t);
  if (sub) { const s = document.createElement("i"); s.textContent = sub; d.appendChild(s); }
  return d;
}

function section(title, hint) {
  const h = document.createElement("h2");
  h.textContent = title;
  document.body.appendChild(h);
  if (hint) { const p = document.createElement("p"); p.textContent = hint; document.body.appendChild(p); }
  const g = document.createElement("div");
  g.className = "grid";
  document.body.appendChild(g);
  return g;
}

// ① 13 个坑位并排：一个坑位对一个角色，顺序即坑位（改顺序 = 给所有 agent 换脸）
{
  const g = section("13 个坑位", "顺序即坑位：01 → 0 … 13 → 12。都画 plain（不画角标、静止一帧）。");
  for (let slot = 0; slot < FACE_CHARACTERS.length; slot++) {
    g.appendChild(cell("坑位 " + slot, face(slot, "plain", 120), "= 旧 " + String(slot + 1).padStart(2, "0") + ".png"));
  }
}

// ② 16 个表情：真动的那几档在这一页里是真的在动
{
  const g = section("16 个表情", "会动的那几档这里真的在动。queued 与 plain 一动不动，waiting 是唯一横着摆的。");
  for (const state of STATES) {
    g.appendChild(cell(state, face(4, state, 80), faceAnimates(state) ? "会动" : "静止"));
  }
}

// ③ 三个尺寸：40px 下能不能分出状态，是这套东西成不成立的那一问
{
  const g = section("尺寸", "名册 24–34px / 通话栏 24px / 全屏通话 80px。40px 下靠角标认状态。");
  for (const size of SIZES) {
    for (const state of ["plain", "working", "waiting", "speaking", "failed", "offline"]) {
      g.appendChild(cell(state + " · " + size, face(6, state, size)));
    }
  }
}

// ④ 一墙脸：名册那一屏真实的样子
{
  const g = section("一墙脸（名册）", "名册一律 plain —— 这一栏查不到谁在跑，画一枚恒灰的「空闲」角标是撒谎的勾（#1282）。");
  g.classList.add("wall");
  for (let i = 0; i < 26; i++) g.appendChild(face(i % FACE_CHARACTERS.length, "plain", 30));
}

(function loop() {
  requestAnimationFrame(loop);
  const t = performance.now();
  for (const [cv, slot, state] of live) paintFace(cv, slot, state, t);
})();

document.getElementById("theme").onclick = () => document.body.classList.toggle("dark");
`;

const bundled = await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts" },
  bundle: true,
  format: "iife",
  target: "es2022",
  write: false,
});
const js = bundled.outputFiles[0].text;

const html = `<!doctype html>
<meta charset="utf-8">
<title>Otto 像素脸</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 24px 28px 64px; font: 13px/1.6 -apple-system, "PingFang SC", sans-serif;
         background: #fbfbfc; color: #101012; }
  body.dark { background: #101012; color: #f2f2f3; }
  h1 { font-size: 17px; margin: 0 0 4px; }
  h2 { font-size: 13px; margin: 28px 0 4px; opacity: .55; font-weight: 600; letter-spacing: .04em; }
  p  { margin: 0 0 12px; opacity: .5; max-width: 60ch; }
  .grid { display: flex; flex-wrap: wrap; gap: 14px; }
  .grid.wall { gap: 6px; }
  .cell { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 128px; }
  .cell span { font-size: 11px; opacity: .7; }
  .cell i { font-size: 10px; opacity: .4; font-style: normal; }
  button { position: fixed; top: 16px; right: 20px; font: inherit; padding: 4px 10px;
           border-radius: 8px; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; }
</style>
<h1>Otto 像素脸 <span style="opacity:.4;font-weight:400">#1345 · lib/ottoFace/</span></h1>
<p>圆盘底色两个主题一样（纸白 #f2f2f3）—— 纯黑头发压在纯黑底上会糊成一团，所以不靠描边、靠盘底。点右上角换主题看边缘。</p>
<button id="theme">换主题</button>
<script>${js}</script>
`;

await mkdir(dirname(out), { recursive: true });
await writeFile(out, html);
console.log("build-face-gallery:", out);
