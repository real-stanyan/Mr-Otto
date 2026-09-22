// PNG → ottoFace 角色数据包。
//
//   node scripts/extract-face-sprite.mjs <图片> [--id 名字] [--cols 48] [--out 路径]
//
// 为什么要这个脚本：智能体头像是用户自选的（`avatar_slot`，迁移 0027 / #1007），
// 今天 13 张内置、以后还会加。第一个角色（Otto）是手工考古出来的——找网格周期、
// 对相位、清边缘抗锯齿、量五官坐标，前后十几轮。第二个角色再来一遍就该写脚本了，
// 第十三个角色手工做完人会开始糊弄。
//
// **不引新依赖**：PNG 用内置 zlib 现解现编（这批图都是 8bit 非隔行，够用了）。
// 在这个仓里加一个 npm 包要动 package.json + lockfile 并说明白为什么，而这里的
// 需求是「一次性读几个 128×128 的小图」——不值。
//
// ## 三步
//
// 1. **背景**：亮且与画面边界连通的像素。不用「透明」判——这批图的底色是带噪点的近白
//    （#F4F3F3~#FAFAFA，单图三千多种颜色），alpha 全是 255。
// 2. **网格**：在目标列数附近搜 (格宽, 相位) 使重建误差最小。逐格多数投票天然抗噪，
//    这也是这批带噪图能直接进管线的原因。**不搜全局最小**——误差指标单调偏向更细的
//    网格，放开搜必然收敛到 1 像素 1 格，那不是网格是原图。
// 3. **清边**：非透明但四邻里非透明 ≤1 的格子抹掉。Otto 那次手工清的「凭空多出一条
//    1 格宽的竖条」就是这一类，成因是逐行取样在最外缘多采了一列抗锯齿。
//
// 五官坐标只**提议**不决定：脚本按连通块给候选，人对着 `--preview` 出的对照图确认。
// 猜错的代价（眼睛歪一格）肉眼一秒看得出来，自动判对的收益不值得那套启发式。

import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

// ---------------------------------------------------------------- PNG 编解码

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 返回 { w, h, rgba: Uint8Array }（每像素 4 字节）。只认 8bit 非隔行的灰/RGB/RGBA */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let palette = null, trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error("不支持隔行 PNG");
      if (bitDepth !== 8) throw new Error(`不支持 bitDepth=${bitDepth}`);
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) throw new Error(`不支持 colorType=${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const lines = new Uint8Array(h * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      const x = line[i];
      cur[i] =
        filter === 0 ? x : filter === 1 ? (x + a) & 0xff : filter === 2 ? (x + b) & 0xff
        : filter === 3 ? (x + ((a + b) >> 1)) & 0xff : (x + paeth(a, b, c)) & 0xff;
    }
    lines.set(cur, y * stride);
    prev = cur;
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * channels, d = i * 4;
    if (colorType === 0) { rgba[d] = rgba[d + 1] = rgba[d + 2] = lines[s]; rgba[d + 3] = 255; }
    else if (colorType === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = lines[s]; rgba[d + 3] = lines[s + 1]; }
    else if (colorType === 3) {
      const p = lines[s] * 3;
      rgba[d] = palette[p]; rgba[d + 1] = palette[p + 1]; rgba[d + 2] = palette[p + 2];
      rgba[d + 3] = trns && lines[s] < trns.length ? trns[lines[s]] : 255;
    } else {
      rgba[d] = lines[s]; rgba[d + 1] = lines[s + 1]; rgba[d + 2] = lines[s + 2];
      rgba[d + 3] = colorType === 6 ? lines[s + 3] : 255;
    }
  }
  return { w, h, rgba };
}

function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 提取

// 色阶默认 4 档。这批头像的衣服带纹理噪点，5 档会把噪点分到相邻两档上、
// 提取结果里成片麻点；4 档把那对相邻灰并掉，画面立刻干净，而画风本身也只有
// 「黑 / 深灰 / 浅灰 / 白」四层。真需要更细的角色用 --tones 5 开。
const TONE_SETS = {
  3: { tones: ["#", "g", "o"], bands: [90, 200], hex: { "#": "#0A0A0B", g: "#6B7078", o: "#FAFAFA" } },
  4: { tones: ["#", "d", "g", "o"], bands: [70, 150, 215], hex: { "#": "#0A0A0B", d: "#3C3F44", g: "#9AA0A8", o: "#FAFAFA" } },
  5: { tones: ["#", "d", "g", "m", "o"], bands: [60, 120, 180, 225], hex: { "#": "#0A0A0B", d: "#3C3F44", g: "#797E86", m: "#B6BBC2", o: "#FAFAFA" } },
};

function lum(rgba, i) {
  return 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
}

/** 背景 = 亮（或透明）且与画面边界连通。泛洪，不用 alpha 判——这批图 alpha 全是 255 */
function backgroundMask(w, h, rgba) {
  const bg = new Uint8Array(w * h);
  const light = (i) => rgba[i * 4 + 3] < 40 || lum(rgba, i) > 200;
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
  while (stack.length > 0) {
    const i = stack.pop();
    if (bg[i] === 1 || !light(i)) continue;
    bg[i] = 1;
    const x = i % w, y = (i - x) / w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  return bg;
}

function classify(w, h, rgba, bg, bands) {
  const cls = new Int8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (bg[i] === 1) { cls[i] = -1; continue; }
    const L = lum(rgba, i);
    let k = 0;
    while (k < bands.length && L >= bands[k]) k++;
    cls[i] = k;
  }
  return cls;
}

function quantise(cls, w, h, box, cell, ox, oy) {
  const cols = Math.floor((box.w - 1 + ox) / cell) + 1;
  const rows = Math.floor((box.h - 1 + oy) / cell) + 1;
  const NCLS = 7;
  const hist = new Int32Array(cols * rows * NCLS);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const c = cls[(y + box.y) * w + (x + box.x)];
      const gi = Math.floor((x + ox) / cell), gj = Math.floor((y + oy) / cell);
      hist[(gj * cols + gi) * NCLS + (c + 1)]++;
    }
  }
  const grid = new Int8Array(cols * rows);
  for (let k = 0; k < cols * rows; k++) {
    let best = 0, bestN = -1;
    for (let c = 0; c < NCLS; c++) if (hist[k * NCLS + c] > bestN) { bestN = hist[k * NCLS + c]; best = c; }
    grid[k] = best - 1;
  }
  let err = 0;
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const gi = Math.floor((x + ox) / cell), gj = Math.floor((y + oy) / cell);
      if (grid[gj * cols + gi] !== cls[(y + box.y) * w + (x + box.x)]) err++;
    }
  }
  return { grid, cols, rows, err: err / (box.w * box.h) };
}

/** 两道清理，都只打**离群的单格**，不碰成片的结构。
 *
 *  ① 非透明但四邻里非透明 ≤1 → 抹成透明。Otto 那次手工清的「凭空多出一条 1 格宽的
 *     竖条」就是这一类，成因是逐行取样在最外缘多采了一列抗锯齿。
 *  ② 与四邻中 ≥3 个色调都不同 → 归到邻居的多数色。这是噪点纹理的形状。**2 格宽的
 *     眼睛动不了**：它每一格都有至少一个同色邻居，永远凑不满 3 票。这条边界是这道
 *     过滤能开在默认路径上的全部理由——会吃掉五官的清理不能当默认。 */
function despeckle(grid, cols, rows) {
  const out = Int8Array.from(grid);
  const at = (i, j) => (i < 0 || i >= cols || j < 0 || j >= rows ? -2 : grid[j * cols + i]);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = grid[j * cols + i];
      const nb = [at(i, j - 1), at(i, j + 1), at(i - 1, j), at(i + 1, j)];
      if (v >= 0 && nb.filter((n) => n >= 0).length <= 1) { out[j * cols + i] = -1; continue; }
      const diff = nb.filter((n) => n !== -2 && n !== v);
      if (diff.length >= 3) {
        const tally = new Map();
        for (const n of diff) tally.set(n, (tally.get(n) ?? 0) + 1);
        let win = v, most = 0;
        for (const [k, c] of tally) if (c > most) { most = c; win = k; }
        out[j * cols + i] = win;
      }
    }
  }
  return out;
}

/** 最深色调的连通块，给五官坐标当候选 —— 只提议，人对着 preview 确认 */
function darkComponents(grid, cols, rows) {
  const seen = new Uint8Array(cols * rows);
  const comps = [];
  for (let s = 0; s < cols * rows; s++) {
    if (seen[s] === 1 || grid[s] !== 0) continue;
    const stack = [s];
    let x0 = cols, x1 = -1, y0 = rows, y1 = -1, n = 0;
    while (stack.length > 0) {
      const i = stack.pop();
      if (seen[i] === 1 || grid[i] !== 0) continue;
      seen[i] = 1; n++;
      const x = i % cols, y = (i - x) / cols;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0) stack.push(i - 1);
      if (x < cols - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - cols);
      if (y < rows - 1) stack.push(i + cols);
    }
    comps.push({ x0, y0, x1, y1, n, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return comps.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

// ---------------------------------------------------------------- 主流程

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("用法: node scripts/extract-face-sprite.mjs <图片> [--id 名字] [--cols 48] [--out 路径]");
  process.exit(1);
}
const src = argv[0];
const opt = (name, fallback) => {
  const k = argv.indexOf(`--${name}`);
  return k >= 0 && argv[k + 1] !== undefined ? argv[k + 1] : fallback;
};
const id = opt("id", basename(src).replace(/\.[^.]+$/, "").replace(/[^a-z0-9]/gi, "").toLowerCase());
const targetCols = Number(opt("cols", "48"));
const toneSet = TONE_SETS[opt("tones", "4")] ?? TONE_SETS[4];
const TONES = toneSet.tones;
const TONE_HEX = toneSet.hex;
const outPath = opt("out", `src/renderer/src/lib/ottoFace/characters/${id}.ts`);
const previewPath = opt("preview", `/tmp/face-${id}.preview.png`);

const png = decodePng(readFileSync(src));
const bg = backgroundMask(png.w, png.h, png.rgba);
const cls = classify(png.w, png.h, png.rgba, bg, toneSet.bands);

let bx0 = png.w, bx1 = -1, by0 = png.h, by1 = -1;
for (let y = 0; y < png.h; y++) {
  for (let x = 0; x < png.w; x++) {
    if (cls[y * png.w + x] < 0) continue;
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
    if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
}
const box = { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };

// 只在目标列数附近搜 —— 放开搜必然收敛到「1 像素 1 格」，那不是网格是原图
let best = null;
for (let cell = box.w / (targetCols + 1.5); cell <= box.w / Math.max(1, targetCols - 1.5); cell += 0.02) {
  for (let ox = 0; ox < cell; ox += 0.25) {
    for (let oy = 0; oy < cell; oy += 0.25) {
      const q = quantise(cls, png.w, png.h, box, cell, ox, oy);
      if (best === null || q.err < best.q.err) best = { q, cell, ox, oy };
    }
  }
}
const { cols, rows } = best.q;
const grid = despeckle(best.q.grid, cols, rows);

const lines = [];
for (let j = 0; j < rows; j++) {
  let s = "";
  for (let i = 0; i < cols; i++) { const v = grid[j * cols + i]; s += v < 0 ? "." : TONES[v]; }
  lines.push(s);
}

// 对照图：左原图裁剪，右提取结果，各放大到同尺寸
const S = Math.max(2, Math.round(320 / cols));
const outW = cols * S * 2 + 12, outH = rows * S;
const buf = new Uint8Array(outW * outH * 4);
const px = (x, y, r, g, b, a) => {
  if (x < 0 || x >= outW || y < 0 || y >= outH) return;
  const d = (y * outW + x) * 4;
  buf[d] = r; buf[d + 1] = g; buf[d + 2] = b; buf[d + 3] = a;
};
for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) px(x, y, 244, 244, 244, 255);
for (let y = 0; y < outH; y++) {
  for (let x = 0; x < cols * S; x++) {
    const sx = box.x + Math.floor((x / (cols * S)) * box.w);
    const sy = box.y + Math.floor((y / outH) * box.h);
    const i = sy * png.w + sx;
    px(x, y, png.rgba[i * 4], png.rgba[i * 4 + 1], png.rgba[i * 4 + 2], 255);
  }
}
for (let j = 0; j < rows; j++) {
  for (let i = 0; i < cols; i++) {
    const v = grid[j * cols + i];
    if (v < 0) continue;
    const hex = TONE_HEX[TONES[v]];
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(cols * S + 12 + i * S + x, j * S + y, r, g, b, 255);
  }
}
writeFileSync(previewPath, encodePng(outW, outH, buf));

const comps = darkComponents(grid, cols, rows).filter((c) => c.n >= 3 && c.n < cols * rows * 0.1);
const pack = `// ${id} —— 由 scripts/extract-face-sprite.mjs 从 ${basename(src)} 提取。
//
// 矩阵是脚本产物，可以重跑覆盖；**锚点与擦除框是人定的**，改了就别再整段覆盖。
// 提取参数：格宽 ${best.cell.toFixed(3)} / 相位 (${best.ox}, ${best.oy}) / 重建误差 ${(best.q.err * 100).toFixed(1)}%

import { deriveBrows, deriveEyes, deriveMouths, type FaceCharacter } from "../character.js";

export const ${id.toUpperCase()}: FaceCharacter = {
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(id)},
  w: ${cols},
  h: ${rows},
  ink: "#",
  skin: "o",
  palette: ${JSON.stringify(TONE_HEX)},
  base: [
${lines.map((l) => `    ${JSON.stringify(l)},`).join("\n")}
  ],
  // TODO 对着 ${previewPath} 确认，下面是脚本按深色连通块给的候选：
${comps.slice(0, 12).map((c) => `  //   [行 ${c.y0}-${c.y1}, 列 ${c.x0}-${c.x1}]  ${c.w}×${c.h}  ${c.n} 格`).join("\n")}
  erase: [],
  anchors: {
    browL: [0, 0], browR: [0, 0],
    eyeL: [0, 0], eyeR: [0, 0],
    mouth: [0, 0],
  },
  eyes: deriveEyes({ lw: 2, lh: 3, rw: 2, rh: 3 }),
  brows: deriveBrows(3, 3),
  mouths: deriveMouths(7),
};
`;
writeFileSync(outPath, pack);

console.log(`✓ ${basename(src)}`);
console.log(`  网格   ${cols}×${rows}（格宽 ${best.cell.toFixed(3)}，相位 ${best.ox}/${best.oy}，误差 ${(best.q.err * 100).toFixed(1)}%）`);
console.log(`  数据包 ${outPath}`);
console.log(`  对照图 ${previewPath}`);
console.log(`  候选   ${comps.length} 个深色连通块，前几个已写进文件注释`);
