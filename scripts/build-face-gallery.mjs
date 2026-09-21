// ottoFace 陈列馆 → 一张自包含 HTML。
//
//   node scripts/build-face-gallery.mjs [--out docs/otto-face/index.html]
//
// 为什么单独出一张 HTML 而不是挂进应用：数据源还没到位（#1282），接进花名册就只能
// 看到「空闲」一格；而验收这个库要的恰恰是十五格摆在一起对着看——哪两格撞脸、
// 40px 下哪个角标糊了，只有并排才看得出来。
//
// 自包含（脚本与样式全内联）的理由是它要能发给人看：双击打开即可，不用起服务，
// 也不用先装一遍 Electron。

import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const out = resolve(ROOT, outIdx >= 0 && argv[outIdx + 1] !== undefined ? argv[outIdx + 1] : "out/otto-face/index.html");

const bundle = await build({
  entryPoints: [resolve(ROOT, "src/renderer/src/lib/ottoFace/gallery/main.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  write: false,
  logLevel: "warning",
});
const js = bundle.outputFiles[0]?.text ?? "";

const html = `<!doctype html>
<html lang="zh-CN" data-theme="light">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Otto Face · 智能体状态形象</title>
<style>
:root{--bg:#FBFBFA;--fg:#1B1D20;--sub:#6B7076;--line:#E3E3E0;--card:#FFFFFF;--panel:#15181A}
[data-theme=dark]{--bg:#111314;--fg:#EDEEEF;--sub:#8A8F98;--line:#2A2D30;--card:#191C1E;--panel:#0B0D0E}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 system-ui,-apple-system,"PingFang SC",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:44px 24px 80px}
h1{font-size:26px;font-weight:600;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:17px;font-weight:600;margin:44px 0 6px}
p.lede{color:var(--sub);margin:0 0 4px;max-width:62ch}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:22px 0 26px;
  padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.bar label{font-size:12.5px;color:var(--sub)}
select,button{font:inherit;font-size:13px;padding:5px 11px;border-radius:8px;border:1px solid var(--line);
  background:transparent;color:var(--fg);cursor:pointer;transition:transform .16s cubic-bezier(.23,1,.32,1),background .16s}
button:active{transform:scale(.97)}
button[data-on="1"]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.seg{display:flex;gap:4px}
#cast{display:grid;grid-template-columns:repeat(auto-fill,minmax(138px,1fr));gap:14px;justify-items:center}
#wall{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:14px}
.card{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:14px 14px 12px;overflow:hidden}
.stage{display:flex;justify-content:center;align-items:flex-end;min-height:132px;margin-bottom:10px}
.meta{display:flex;align-items:center;gap:7px;margin-bottom:3px}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.zh{font-size:13.5px;font-weight:500}
.key{font-size:11px;color:var(--sub);font-family:ui-monospace,Menlo,monospace;margin-left:auto}
.origin{font-size:11px;line-height:1.5;color:var(--sub);word-break:break-word}
#roster{display:flex;flex-wrap:wrap;gap:12px;padding:18px;border-radius:12px;background:var(--panel)}
.rcell{display:flex;flex-direction:column;align-items:center;gap:5px;width:62px}
.rlabel{font-size:10px;color:#8A8F98;white-space:nowrap}
pre{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:16px 18px;overflow:auto;
  font:12.5px/1.75 ui-monospace,Menlo,monospace;color:var(--fg)}
.note{font-size:12.5px;color:var(--sub);max-width:70ch}
</style>
<div class="wrap">
  <h1>Otto Face</h1>
  <p class="lede">智能体状态形象。角色是产品自己的 logo —— 不是另画一个吉祥物，是让 logo 自己动起来。
     头部品牌锁死不变形，会动的只有眉毛、眼睛、嘴；位移只走整格，因为像素画做亚像素平滑会立刻糊掉。</p>

  <div class="bar">
    <label for="character">角色</label><select id="character"></select>
    <label style="margin-left:10px">尺寸</label>
    <span class="seg">
      <button data-scale="1">1×</button>
      <button data-scale="2">2×</button>
      <button data-scale="3" data-on="1">3×</button>
      <button data-scale="4">4×</button>
    </span>
    <button id="theme" style="margin-left:auto">☾ 暗色</button>
  </div>

  <h2>状态陈列墙</h2>
  <p class="note">十五个状态，与仓里已有的枚举一一对上。卡片右下角写的就是它对应哪一个。
     「空闲」跟指针，其余各有各的驱动。</p>
  <div id="wall" style="margin-top:14px"></div>

  <h2>角色墙</h2>
  <p class="note">同一套引擎，八份纯数据。引擎不认角色是谁 —— 换脸只换一个 <code>FaceCharacter</code>，
     状态表、角标、呼吸、眨眼全共用。鼠标移到脸上，眼睛会跟。</p>
  <div id="cast" style="margin-top:14px"></div>

  <h2>并行墙</h2>
  <p class="note">八只 agent 同屏，各是各的角色、各是各的状态，按 52px 取整缩放（真实花名册尺寸）。这是这套东西真正要解的场景：
     脸负责近看，角标负责扫一眼 —— 先按色收敛（蓝＝在干活 / 琥珀＝要你 / 绿＝成了 / 红＝崩了），再看是哪一格。</p>
  <div id="roster" style="margin-top:14px"></div>

  <h2>接进去</h2>
  <pre><code>import { createFace, faceStateFor, OTTO } from "@/lib/ottoFace"

const face = createFace(el, { character: OTTO, scale: 2 })

// agentPhase() / orbState() 一个字不改，适配层调它们、读它们的返回值
face.setState(faceStateFor({
  running,
  openTurn,        // turnLedger.openTurns() 里这只 agent 的那一行
  voice,           // 通话中的 speaking / thinking / listening
  background,      // backgroundRuns 的 ready / failed
  errorClass,      // rate-limit / retryable / fatal
  dormant,         // taskSync frozen 或 MCP 连不上
  phase,           // 喂给 agentPhase() 的那份投影
}))

face.destroy()     // 花名册一屏十几个实例，别忘了这一行</code></pre>

  <h2>加一个角色</h2>
  <pre><code>node scripts/extract-face-sprite.mjs 头像.png --id 名字 --cols 48 --preview /tmp/看一眼.png
# 出 characters/名字.ts + 对照图，然后：
#   1. 对着对照图填 erase 与 anchors（脚本按深色连通块给了候选，写在文件注释里）
#   2. 在 characters/index.ts 的 FACE_CHARACTERS 里加一行</code></pre>
  <p class="note"><b>擦除框和五官锚点是人定的</b>，脚本只提议。猜错的代价（眼睛歪一格）肉眼一秒
     看得出来，自动判对的收益不值得那套启发式。戴眼镜的角色<b>只抹镜片内腔</b>，镜框归脸；
     五官长在别的东西上的（大胡子的嘴），擦除框写第五项指定填什么色。</p>
</div>
<script>${js}</script>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`✓ 陈列馆 ${out}（${(html.length / 1024).toFixed(0)} KB，自包含）`);
