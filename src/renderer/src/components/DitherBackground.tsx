import { useEffect, useRef } from "react";
import { DITHER_FRAG, DITHER_RAMP, DITHER_VERT } from "../../../shared/dither.js";

/**
 * reactbits 的 Dither 背景。**shader 源码不在这个文件里** —— 在
 * `src/shared/dither.ts`，手机端（mobile/src/dither.tsx，跑在 WKWebView 里的
 * 同一套 WebGL2）import 的是同一份字符串。这里只剩"把它接到一块 canvas 上"。
 *
 * 配色表（DITHER_RAMP）也在那边：两端同一张表，改一处两端一起动。
 */

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
    // context 丢了就别往下走：createShader 会静默返回 null，画面变纯色但控制台干净，
    // 排查起来像"效果没做"。宁可在这里吵一声
    if (gl.isContextLost()) {
      console.error("[dither] WebGL2 context lost，跳过这次渲染");
      return;
    }
    const vs = compile(gl, gl.VERTEX_SHADER, DITHER_VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, DITHER_FRAG);
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
      fromColor: gl.getUniformLocation(prog, "fromColor"),
      toColor: gl.getUniformLocation(prog, "toColor"),
    };
    const [from, to] = dark ? DITHER_RAMP.dark : DITHER_RAMP.light;
    gl.uniform3f(u.fromColor, from[0], from[1], from[2]);
    gl.uniform3f(u.toColor, to[0], to[1], to[2]);

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
      // 这里不能 loseContext()：canvas 的 context 是认 canvas 不认 effect 的，
      // 丢掉之后同一个 canvas 再 getContext("webgl2") 拿回来的还是那个已丢失的 context
      // （规范如此，不会新建）。StrictMode 在 dev 下 mount→cleanup→mount，
      // 第二次挂载就永远拿到死 context，画面全空。canvas 卸载时 context 自己会走。
    };
  }, [dark]);

  return <canvas ref={ref} className={className} aria-hidden />;
}
