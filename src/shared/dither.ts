// reactbits 的 Dither 背景（https://reactbits.dev/backgrounds/dither）移植成裸
// WebGL2 的**那一份 shader 源码**。桌面（Electron 渲染进程的 canvas）和手机端
// （WKWebView 里的 canvas）import 同一份，不是各抄一份 —— 抄出来的两份会漂，
// 漂了就不是"同一个产品的同一个效果"了。
//
// 原版是 three + @react-three/fiber + postprocessing 两道 pass（先画 fbm 噪声波，
// 再后处理做 Bayer 抖动）。这里合成一道 pass：片元先把坐标按 pixelSize 吸附，
// 在吸附后的坐标上算噪声，再叠 8x8 Bayer 阈值量化到 colorNum 级——画面一样，
// 少 ~1MB 依赖。参数按原版默认值钉死，不暴露成 props。
//
// 这一层是纯字符串：不许 import 任何东西，不碰 DOM / node / electron
// （tests/architecture.test.ts 钉着 shared 层的边界）。

/** 波场参数。逐个是 reactbits 原版的默认值 */
export const DITHER_WAVE = {
  speed: 0.05,
  frequency: 3,
  amplitude: 0.3,
  colorNum: 4,
  /** 一格多大，单位是 **CSS 像素**（两端都按 dpr=1 画：抖动点就是要看得见颗粒） */
  pixelSize: 2,
  mouseRadius: 1,
} as const;

/** 一个盖满裁剪空间的大三角，不用顶点缓冲 */
export const DITHER_VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * 片元。两个颜色 uniform 而不是一个 invert 开关：深浅色在原版里是"黑底灰波"
 * 翻成"白底深波"，等价于把两端的颜色对调；做成 uniform 之后，手机端还能把
 * 它压到主题那两档很淡的颜色上，而不必另写一份 shader。
 */
export const DITHER_FRAG = `#version 300 es
precision highp float;
uniform vec2 resolution;
uniform float time;
uniform vec2 mousePos;
uniform float mouseOn;
uniform vec3 fromColor;
uniform vec3 toColor;
out vec4 outColor;

const float waveSpeed = ${DITHER_WAVE.speed.toFixed(3)};
const float waveFrequency = ${DITHER_WAVE.frequency.toFixed(3)};
const float waveAmplitude = ${DITHER_WAVE.amplitude.toFixed(3)};
const float colorNum = ${DITHER_WAVE.colorNum.toFixed(1)};
const float pixelSize = ${DITHER_WAVE.pixelSize.toFixed(1)};
const float mouseRadius = ${DITHER_WAVE.mouseRadius.toFixed(3)};

vec4 mod289(vec4 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec2 fade(vec2 t) { return t*t*t*(t*(t*6.0-15.0)+10.0); }

float cnoise(vec2 P) {
  vec4 Pi = floor(P.xyxy) + vec4(0.0,0.0,1.0,1.0);
  vec4 Pf = fract(P.xyxy) - vec4(0.0,0.0,1.0,1.0);
  Pi = mod289(Pi);
  vec4 ix = Pi.xzxz;
  vec4 iy = Pi.yyww;
  vec4 fx = Pf.xzxz;
  vec4 fy = Pf.yyww;
  vec4 i = permute(permute(ix) + iy);
  vec4 gx = fract(i * (1.0/41.0)) * 2.0 - 1.0;
  vec4 gy = abs(gx) - 0.5;
  vec4 tx = floor(gx + 0.5);
  gx = gx - tx;
  vec2 g00 = vec2(gx.x, gy.x);
  vec2 g10 = vec2(gx.y, gy.y);
  vec2 g01 = vec2(gx.z, gy.z);
  vec2 g11 = vec2(gx.w, gy.w);
  vec4 norm = taylorInvSqrt(vec4(dot(g00,g00), dot(g01,g01), dot(g10,g10), dot(g11,g11)));
  g00 *= norm.x; g01 *= norm.y; g10 *= norm.z; g11 *= norm.w;
  float n00 = dot(g00, vec2(fx.x, fy.x));
  float n10 = dot(g10, vec2(fx.y, fy.y));
  float n01 = dot(g01, vec2(fx.z, fy.z));
  float n11 = dot(g11, vec2(fx.w, fy.w));
  vec2 fade_xy = fade(Pf.xy);
  vec2 n_x = mix(vec2(n00, n01), vec2(n10, n11), fade_xy.x);
  return 2.3 * mix(n_x.x, n_x.y, fade_xy.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amp = 1.0;
  for (int i = 0; i < 4; i++) {
    value += amp * abs(cnoise(p));
    p *= waveFrequency;
    amp *= waveAmplitude;
  }
  return value;
}

float pattern(vec2 p) {
  vec2 p2 = p - time * waveSpeed;
  return fbm(p + fbm(p2));
}

const float bayer[64] = float[64](
  0.0/64.0, 48.0/64.0, 12.0/64.0, 60.0/64.0,  3.0/64.0, 51.0/64.0, 15.0/64.0, 63.0/64.0,
  32.0/64.0,16.0/64.0, 44.0/64.0, 28.0/64.0, 35.0/64.0,19.0/64.0, 47.0/64.0, 31.0/64.0,
  8.0/64.0, 56.0/64.0,  4.0/64.0, 52.0/64.0, 11.0/64.0,59.0/64.0,  7.0/64.0, 55.0/64.0,
  40.0/64.0,24.0/64.0, 36.0/64.0, 20.0/64.0, 43.0/64.0,27.0/64.0, 39.0/64.0, 23.0/64.0,
  2.0/64.0, 50.0/64.0, 14.0/64.0, 62.0/64.0,  1.0/64.0,49.0/64.0, 13.0/64.0, 61.0/64.0,
  34.0/64.0,18.0/64.0, 46.0/64.0, 30.0/64.0, 33.0/64.0,17.0/64.0, 45.0/64.0, 29.0/64.0,
  10.0/64.0,58.0/64.0,  6.0/64.0, 54.0/64.0,  9.0/64.0,57.0/64.0,  5.0/64.0, 53.0/64.0,
  42.0/64.0,26.0/64.0, 38.0/64.0, 22.0/64.0, 41.0/64.0,25.0/64.0, 37.0/64.0, 21.0/64.0
);

float dither(vec2 cell, float v) {
  int x = int(mod(cell.x, 8.0));
  int y = int(mod(cell.y, 8.0));
  float threshold = bayer[y * 8 + x] - 0.25;
  v += threshold / (colorNum - 1.0);
  v = clamp(v - 0.2, 0.0, 1.0);
  return floor(v * (colorNum - 1.0) + 0.5) / (colorNum - 1.0);
}

void main() {
  // 先吸附到 pixelSize 格，再在格中心采样——等价于原版后处理里的 uvPixel
  vec2 cell = floor(gl_FragCoord.xy / pixelSize);
  vec2 snapped = (cell + 0.5) * pixelSize;
  vec2 uv = snapped / resolution - 0.5;
  uv.x *= resolution.x / resolution.y;
  float f = pattern(uv);
  if (mouseOn > 0.5) {
    vec2 m = (mousePos / resolution - 0.5) * vec2(1.0, -1.0);
    m.x *= resolution.x / resolution.y;
    float effect = 1.0 - smoothstep(0.0, mouseRadius, length(uv - m));
    f -= 0.5 * effect;
  }
  // 原版 mix(black, waveColor=0.5 灰, f) 再抖动，三通道相同，所以只量化一个标量
  float q = dither(cell, 0.5 * f);
  outColor = vec4(mix(fromColor, toColor, q), 1.0);
}`;

/** "#rrggbb" → [0..1, 0..1, 0..1]，喂 uniform3f */
export function ditherRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * 抖动的两档颜色，**两端共用这一张表**。
 *
 * 深浅色在原版里是"黑底灰波"翻成"白底深波"，等价于把两端颜色对调 ——
 * 所以这里不是一个 invert 开关，是两组 (from, to)。
 * 手机端曾经想把它压到主题那两档很淡的颜色上（#efece3 → #ddd8c8，
 * 见 mobile/scripts/gen-dither.mjs 烤 PNG 时用的那对），最后没有：
 * 两端配色不一致就不再是同一个效果，而是"另做了一个像的"。
 */
export const DITHER_RAMP = {
  dark: [ditherRgb("#000000"), ditherRgb("#ffffff")],
  light: [ditherRgb("#ffffff"), ditherRgb("#000000")],
} as const;

/** 波场之外那块底色（画之前那一帧、以及 GL 起不来时兜的底） */
export const DITHER_BASE = { dark: "#000000", light: "#ffffff" } as const;
