// 把桌面那套连接器图标（src/renderer/src/assets/mcp）做成手机端吃得下的形状（#1437）。
//
// 为什么是"生成"：Metro 不会把 .svg 当字符串 import（要另装 transformer），而 react-native-svg 的
// SvgXml 收的正是一段 xml 字符串——所以把目录用得到的那些标抄成一张 TS 表。位图抄进 mobile/assets/
// 走 require（包外的资源路径带 `..`，不赌打包器怎么处理它）。
//
// mono 那一档（shared/appIcon.ts 的 iconPaint）在桌面靠 mask 只取形状；手机上没有 mask，改成把
// 写死的 fill / stroke 换成 currentColor，由 <SvgXml color=…> 跟主题前景色走。
//
// 用法：
//   node scripts/gen-mobile-app-icons.mjs          重新生成
//   node scripts/gen-mobile-app-icons.mjs --check  产物过期就退出 1（tests/scripts/mobileAppIcons.test.ts）
// 产出：
//   mobile/src/machine/appIcons.generated.ts
//   mobile/assets/app-icons/*.png
// 加图标 / 改 MONO_ICONS 之后跑一遍，不手改产物。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "src/renderer/src/assets/mcp");
const OUT_TS = join(root, "mobile/src/machine/appIcons.generated.ts");
const OUT_PNG = join(root, "mobile/assets/app-icons");

// 两张表都从源码里读，不抄第二份：目录用到哪些键、哪些走 mono
const catalogSrc = readFileSync(join(root, "src/shared/mcpCatalog.ts"), "utf8");
const icons = [...new Set([...catalogSrc.matchAll(/^\s+icon: "([a-z0-9-]+)",$/gm)].map((m) => m[1]))].sort();
const paintSrc = readFileSync(join(root, "src/shared/appIcon.ts"), "utf8");
const monoBlock = paintSrc.slice(paintSrc.indexOf("const MONO_ICONS"), paintSrc.indexOf("]);"));
const mono = new Set([...monoBlock.matchAll(/^\s+"([a-z0-9-]+)",$/gm)].map((m) => m[1]));
if (icons.length === 0 || mono.size === 0) throw new Error("没读出图标键或 MONO_ICONS——源文件的形状变了，先改这个脚本");

const squeeze = (xml) =>
  xml
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();

/** SvgXml 不认 <style>：把 `.类名 { 属性: 值 }` 摊成元素上的属性，再把 style 块删掉。
    只认这一种最简单的规则；摊完还剩 <style 或 class= 就抛——那是这里没见过的写法，画出来会是一坨黑 */
function inlineStyles(xml, icon) {
  // 声明串 → 属性表。丢掉渲染器不认的：color(display-p3 …) 这种色值、enable-background
  const decls = (css) => {
    const map = new Map();
    for (const d of css.split(";")) {
      const at = d.indexOf(":");
      if (at < 0) continue;
      const k = d.slice(0, at).trim();
      const v = d.slice(at + 1).trim();
      if (k === "" || k === "enable-background" || v.includes("(")) continue;
      map.set(k, v);
    }
    return map;
  };
  const asAttrs = (map) => [...map].map(([k, v]) => `${k}="${v}"`).join(" ");
  const rules = new Map();
  let rootRule = null;
  let out = xml.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/g, (_, css) => {
    for (const m of css.matchAll(/(:root|\.[\w-]+)\s*\{([^}]*)\}/g)) {
      if (m[1] === ":root") rootRule = decls(m[2]);
      else rules.set(m[1].slice(1), asAttrs(decls(m[2])));
    }
    return "";
  });
  out = out.replace(/\sclass="([\w-]+)"/g, (whole, name) => (rules.has(name) ? ` ${rules.get(name)}` : whole));
  // 行内 style="…" 同样摊成属性
  out = out.replace(/\sstyle="([^"]*)"/g, (_, css) => {
    const attrs = asAttrs(decls(css));
    return attrs === "" ? "" : ` ${attrs}`;
  });
  // `:root { fill: … }` 落在 <svg> 上：先摘掉根上同名的旧属性再补
  if (rootRule !== null) {
    out = out.replace(/<svg\b[^>]*>/, (tag) => {
      let t = tag;
      for (const k of rootRule.keys()) t = t.replace(new RegExp(`\\s${k}="[^"]*"`), "");
      return t.replace(/<svg\b/, `<svg ${asAttrs(rootRule)}`);
    });
  }
  if (/<style|\sclass=|\sstyle=/.test(out)) throw new Error(`${icon}.svg 里有摊不开的 <style> / class / style，先改 inlineStyles`);
  return out;
}

/** 写死的颜色一律换成 currentColor；none 与 url(#…) 不动。根上没写 fill 的补一个（缺省是黑，深色底上没影） */
function toMono(xml) {
  let out = xml.replace(/\b(fill|stroke)="(?!none|url\(|currentColor)[^"]*"/g, '$1="currentColor"');
  const rootTag = out.match(/<svg\b[^>]*>/)?.[0] ?? "";
  if (!/\sfill="/.test(rootTag)) out = out.replace(/<svg\b/, '<svg fill="currentColor"');
  return out;
}

const svg = {};
const png = [];
for (const icon of icons) {
  const svgPath = join(SRC, `${icon}.svg`);
  if (existsSync(svgPath)) {
    const xml = squeeze(inlineStyles(readFileSync(svgPath, "utf8"), icon));
    svg[icon] = mono.has(icon) ? toMono(xml) : xml;
  } else if (existsSync(join(SRC, `${icon}.png`))) {
    png.push(icon);
  } else {
    throw new Error(`目录里写了 icon "${icon}"，assets/mcp 下却没有这个文件`);
  }
}

const ts = [
  "// 由 scripts/gen-mobile-app-icons.mjs 生成，不要手改。源：src/renderer/src/assets/mcp（#1437）。",
  "// mono 那一档的颜色已换成 currentColor，由 AppTile 的 <SvgXml color=…> 上色。",
  "",
  "export const APP_ICON_SVG: Readonly<Record<string, string>> = {",
  ...Object.entries(svg).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`),
  "};",
  "",
  "export const APP_ICON_PNG: Readonly<Record<string, number>> = {",
  ...png.map((k) => `  ${JSON.stringify(k)}: require("../../assets/app-icons/${k}.png"),`),
  "};",
  "",
].join("\n");

if (process.argv.includes("--check")) {
  const stale = [];
  if (!existsSync(OUT_TS) || readFileSync(OUT_TS, "utf8") !== ts) stale.push("mobile/src/machine/appIcons.generated.ts");
  const have = existsSync(OUT_PNG) ? readdirSync(OUT_PNG).sort() : [];
  const want = png.map((k) => `${k}.png`);
  if (have.join() !== want.join()) stale.push("mobile/assets/app-icons（文件名单）");
  for (const f of want) {
    if (have.includes(f) && !readFileSync(join(OUT_PNG, f)).equals(readFileSync(join(SRC, f)))) stale.push(`mobile/assets/app-icons/${f}`);
  }
  if (stale.length > 0) {
    console.error(`手机端应用图标过期了：\n  ${stale.join("\n  ")}\n跑一遍：node scripts/gen-mobile-app-icons.mjs`);
    process.exit(1);
  }
} else {
  rmSync(OUT_PNG, { recursive: true, force: true });
  mkdirSync(OUT_PNG, { recursive: true });
  for (const k of png) copyFileSync(join(SRC, `${k}.png`), join(OUT_PNG, `${k}.png`));
  writeFileSync(OUT_TS, ts);
  console.log(`✓ ${Object.keys(svg).length} 个 svg + ${png.length} 个 png`);
}
