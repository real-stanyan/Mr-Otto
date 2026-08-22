import { useEffect, useRef } from "react";

/**
 * reactbits 的 Dither 背景（https://reactbits.dev/backgrounds/dither）移植成裸 WebGL2。
 *
 * 原版是 three + @react-three/fiber + postprocessing 两道 pass（先画 fbm 噪声波，
 * 再后处理做 Bayer 抖动）。这里合成一道 pass：片元先把坐标按 pixelSize 吸附，
 * 在吸附后的坐标上算噪声，再叠 8x8 Bayer 阈值量化到 colorNum 级——画面一样，
 * 少 ~1MB 依赖。只给启动画面用，参数按原版默认值钉死，不暴露成 props。
 */
const WAVE = { speed: 0.05, frequency: 3, amplitude: 0.3, colorNum: 4, pixelSize: 2, mouseRadius: 1 };

const VERT = `#version 300 es
void main() {
  // 一个盖满裁剪空间的大三角，不用顶点缓冲
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 resolution;
uniform float time;
uniform vec2 mousePos;
uniform float mouseOn;
uniform float invert;
out vec4 outColor;

const float waveSpeed = ${WAVE.speed.toFixed(3)};
const float waveFrequency = ${WAVE.frequency.toFixed(3)};
const float waveAmplitude = ${WAVE.amplitude.toFixed(3)};
const float colorNum = ${WAVE.colorNum.toFixed(1)};
const float pixelSize = ${WAVE.pixelSize.toFixed(1)};
const float mouseRadius = ${WAVE.mouseRadius.toFixed(3)};

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
  // 原版 mix(black, waveColor=0.5 灰, f) 再抖动，三通道相同，所以只量化一个标量。
  // 浅色主题整体取反：黑底灰波翻成白底深波，抖动图样不变
  float q = dither(cell, 0.5 * f);
  outColor = vec4(vec3(mix(q, 1.0 - q, invert)), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("[dither] shader compile:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function DitherBackground({ className, dark = true }: { className?: string; dark?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    // 拿不到 WebGL2（软渲染被禁之类）就留一块纯色——启动画面不值得为此兜第二套实现
    if (!gl) return;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("[dither] link:", gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);
    const u = {
      resolution: gl.getUniformLocation(prog, "resolution"),
      time: gl.getUniformLocation(prog, "time"),
      mousePos: gl.getUniformLocation(prog, "mousePos"),
      mouseOn: gl.getUniformLocation(prog, "mouseOn"),
      invert: gl.getUniformLocation(prog, "invert"),
    };
    gl.uniform1f(u.invert, dark ? 0 : 1);

    // 原版 dpr={1}：抖动点就是要看得见颗粒，不按 devicePixelRatio 放大
    const resize = () => {
      const w = Math.max(1, Math.floor(canvas.clientWidth));
      const h = Math.max(1, Math.floor(canvas.clientHeight));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(u.resolution, w, h);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    let mouseOn = 0;
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      gl.uniform2f(u.mousePos, e.clientX - r.left, e.clientY - r.top);
      mouseOn = 1;
    };
    const onLeave = () => {
      mouseOn = 0;
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    const t0 = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      gl.uniform1f(u.time, (now - t0) / 1000);
      gl.uniform1f(u.mouseOn, mouseOn);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [dark]);

  return <canvas ref={ref} className={className} aria-hidden />;
}
