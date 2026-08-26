// 登录页那块抖动波场，**会动的那一版**。
//
// 桌面是 src/renderer/src/components/DitherBackground.tsx：一块 canvas + WebGL2。
// 手机端跑的是**同一份 shader**（`src/shared/dither.ts`，两端 import 同一个文件），
// 只是那块 canvas 换到了 WKWebView 里。
//
// 为什么绕 WebView 而不是 expo-gl：
//   expo-gl 文档写着 Included in Expo Go，CLI 给模拟器装的那份（57.0.9）里也确实
//   有 EXGL 的符号；但 App Store 上最新的 Expo Go 装到真机上，import 就是
//   `Cannot find native module 'ExpoGL'`。要它就得 prebuild + 签名做 dev client，
//   等于推翻 README 那条前提（Expo Go 就能跑，没有 native module）。
//   react-native-webview 同样是 Included in Expo Go，而且真机上就有。
//   代价：多一个 WKWebView（一屏一个，登录完就卸载），以及 JS 桥外的一个独立
//   渲染进程 —— 换来的是和桌面**逐字节同一套**的效果，而不是"另做一个像的"。
//
// 和桌面唯一的行为差别：没有指针跟随（`mouseOn` 恒为 0）。这一层 pointerEvents
// 是 none，触摸要留给底下的表单；把手指位置喂给 shader 就得抢触摸。
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { DITHER_BASE, DITHER_FRAG, DITHER_RAMP, DITHER_VERT } from "../../src/shared/dither.js";

function page(isDark: boolean): string {
  const [from, to] = isDark ? DITHER_RAMP.dark : DITHER_RAMP.light;
  const bg = isDark ? DITHER_BASE.dark : DITHER_BASE.light;
  // 遮罩用底色本身，不引第三个颜色
  const scrim = isDark ? "rgba(0,0,0,0.82)" : "rgba(255,255,255,0.82)";
  // shader 源码走 JSON.stringify 进去：里面有 `<<`、反引号之外的各种符号，
  // 直接拼进 <script> 里迟早撞到某个转义
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
html,body{margin:0;height:100%;overflow:hidden;background:${bg}}
canvas{display:block;width:100vw;height:100vh}
/* 状态栏那条的遮罩。波场是通栏的，亮波飘到刘海那一带时，系统那行时间/信号
   就压在同色上读不出来了（iOS 的状态栏只有 light/dark 两档，跟不了波）。
   一道 120px 的渐变把顶端压回底色，够读，又不至于切出一条硬边。
   要"和原版逐像素一致"就删掉这个 ::after —— 代价是时间偶尔看不见 */
body::after{content:"";position:fixed;top:0;left:0;right:0;height:120px;
  background:linear-gradient(${scrim} 0%,${scrim} 28%,transparent 100%);pointer-events:none}
</style>
</head><body><canvas id="c"></canvas><script>
(function(){
  var VERT = ${JSON.stringify(DITHER_VERT)};
  var FRAG = ${JSON.stringify(DITHER_FRAG)};
  var canvas = document.getElementById("c");
  var gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) return;                       // 拿不到就留一块纯色底，别把登录页拖下水
  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(sh)); return null; }
    return sh;
  }
  var vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;
  var prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(prog)); return; }
  gl.useProgram(prog);
  var uRes = gl.getUniformLocation(prog, "resolution");
  var uTime = gl.getUniformLocation(prog, "time");
  gl.uniform1f(gl.getUniformLocation(prog, "mouseOn"), 0);
  gl.uniform2f(gl.getUniformLocation(prog, "mousePos"), 0, 0);
  gl.uniform3f(gl.getUniformLocation(prog, "fromColor"), ${from[0]}, ${from[1]}, ${from[2]});
  gl.uniform3f(gl.getUniformLocation(prog, "toColor"), ${to[0]}, ${to[1]}, ${to[2]});
  // 和桌面一样按 dpr=1 画：抖动点就是要看得见颗粒，按 devicePixelRatio 放大
  // 既糊掉颗粒又白烧 9 倍片元
  function resize() {
    var w = Math.max(1, Math.floor(canvas.clientWidth)), h = Math.max(1, Math.floor(canvas.clientHeight));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    gl.uniform2f(uRes, w, h);
  }
  window.addEventListener("resize", resize);
  resize();
  var t0 = performance.now();
  (function frame(now){
    gl.uniform1f(uTime, (now - t0) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  })(t0);
})();
</script></body></html>`;
}

export function DitherBackground({ isDark }: { isDark: boolean }) {
  const html = useMemo(() => page(isDark), [isDark]);
  // 外面必须套一层定尺寸的 View，WebView 自己 `style={absoluteFill}` 量出来只有
  // 114pt 高（它按内容/内在尺寸量，不吃绝对定位那四条边）。套一层之后
  // WebView 只要 flex:1 去填满这层，viewport 才是整屏
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
    <WebView
      // key 绑主题：颜色是烤进 HTML 的，切主题要换整个文档
      key={isDark ? "d" : "l"}
      source={{ html }}
      originWhitelist={["*"]}
      style={{ flex: 1, backgroundColor: "transparent" }}
      scrollEnabled={false}
      bounces={false}
      // 这一屏没有链接可点，也不该有：万一 shader 那段出错跳去别处，
      // 登录页上出现一个网页比没有背景糟得多
      javaScriptEnabled
      setSupportMultipleWindows={false}
      // 进度条 / 长按选中 / 双击缩放这些 WKWebView 默认行为，在"一张背景"上全是噪音
      allowsLinkPreview={false}
    />
    </View>
  );
}
