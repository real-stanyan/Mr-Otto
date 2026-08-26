// 登录页背景:有序抖动的波场,静态一帧。
//
// **为什么是预渲染的 PNG,不是 reactbits 那个组件**:那边是 three.js 的
// WebGL shader,每帧在 GPU 上算。RN 里没有 WebGL —— 要有就得装 expo-gl,
// 那是原生模块,意味着一次真机重装。这一屏是登录页,人在上面待十秒,
// 动画换不来十秒的价值,却要押上装机这件事。
//
// 算法照抄那个 shader 的三段:域扭曲的 value-noise fBm 出波场 → 8×8 Bayer
// 有序抖动把连续值压成 N 档 → 按 pixelSize 粗化成方块。抖动必须是**有序**的
// (Bayer 矩阵),不是随机噪点:随机抖动在大面积平缓渐变上会看成脏,
// 有序抖动才出那种 90 年代 256 色的规则网纹。
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const W = 1290, H = 2796;   // iPhone 16 Pro Max 的原生像素;更小的屏 cover 下去
const CELL = 6;             // 一格多大(设备像素)。6 = 3x 屏上的 2pt
const LEVELS = 4;           // 压成几档。再多就看不出是抖动了

/** 8×8 Bayer:阈值矩阵,值域 [0,1)。递归展开比查表更说明它是什么 */
function bayer(n) {
  if (n === 1) return [[0]];
  const s = bayer(n / 2), h = n / 2, m = [];
  for (let y = 0; y < n; y++) {
    m[y] = [];
    for (let x = 0; x < n; x++) {
      const q = (y < h ? 0 : 2) + (x < h ? 0 : 1);
      const base = [0, 2, 3, 1][q];
      m[y][x] = 4 * s[y % h][x % h] + base;
    }
  }
  return m;
}
const BAYER = bayer(8).map((r) => r.map((v) => v / 64));

const hash = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const smooth = (t) => t * t * (3 - 2 * t);
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash(xi, yi), b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a + (b - a) * xf) + ((c - a) + (a - b - c + d) * xf) * yf;
}
function fbm(x, y) {
  let v = 0, amp = 0.5, fx = x, fy = y;
  for (let i = 0; i < 4; i++) { v += amp * noise(fx, fy); fx *= 2; fy *= 2; amp *= 0.5; }
  return v;
}

const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** @param {string} from 底色(0 档) @param {string} to 最深那一档 */
function render(from, to) {
  const A = hex(from), B = hex(to);
  const cols = Math.ceil(W / CELL), rows = Math.ceil(H / CELL);
  const grid = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      // 归一化到 [0,1] 的屏幕坐标,乘频率。y 拉长一点,波才是横着躺的
      const u = (cx / cols) * 3.0, v = (cy / rows) * 6.0;
      // 域扭曲:先用 fbm 把坐标推歪,再取正弦带 —— 直接对 fbm 取值只有云,没有波
      const w = fbm(u, v);
      const band = 0.5 + 0.5 * Math.sin((v + w * 1.2) * 3.6);
      // 上下各留一段更淡的:内容(图标/表单)压在中间,背景不该跟它抢
      const fade = 0.35 + 0.65 * Math.abs(Math.sin((cy / rows) * Math.PI));
      const value = band * fade;
      const t = BAYER[cy % 8][cx % 8];
      grid[cy * cols + cx] = Math.min(LEVELS - 1, Math.floor(value * LEVELS + t));
    }
  }
  // 每行前面那个 0 是 PNG 的 filter type(None)
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const off = y * (1 + W * 3);
    const cy = Math.floor(y / CELL);
    for (let x = 0; x < W; x++) {
      const lv = grid[cy * cols + Math.floor(x / CELL)];
      const [r, g, b] = mix(A, B, lv / (LEVELS - 1));
      raw[off + 1 + x * 3] = r; raw[off + 2 + x * 3] = g; raw[off + 3 + x * 3] = b;
    }
  }
  return raw;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 bit/通道, truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 两端都从主题的 background 出发,只走到 muted/card —— 对比压到最低。
// 背景要是能被读出图案,它就不再是背景了
for (const [name, from, to] of [
  ["assets/dither-light.png", "#efece3", "#ddd8c8"],
  ["assets/dither-dark.png", "#000000", "#23232a"],
]) {
  writeFileSync(name, png(render(from, to)));
  console.log(name);
}
