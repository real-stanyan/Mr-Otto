// 连接器目录里那二十个标，两个主题都得看得见（issue #720，ADR-0180）。
//
// 上一版把每个标垫在一张白色方片上，于是"看不见"这件事根本不会发生——白底
// 兜住了所有情况。方片去掉之后兜底也没了，判断落回每个标自己：纯黑的标必须
// 走 mask（形状 + 主题前景色），有品牌色的照原样画、颜色要在两种卡片底色上
// 都过得去。这两条都是人肉挑的，忘一条就是深色主题下一格空白——而空白不报错。
//
// 下面三条断言各钉住一种已经发生过的失手：
// ① 目录里写了 icon 却没有那个文件（退化成首字母色块，#715 的原始症状）
// ② 一个纯黑的标被划进 "color"（深色主题上等于没有）
// ③ 一个 mono 标里带着整幅的背景块（mask 只取 alpha，整块底板会变成实心方块
//    —— linear.svg 的黑底圆角方片就是这样，改版时才发现）
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_CATALOG } from "../../src/shared/mcpCatalog.js";
import { iconPaint } from "../../src/renderer/src/lib/mcpDirectory.js";

const ICON_DIR = join(__dirname, "..", "..", "src", "renderer", "src", "assets", "mcp");

const icons = MCP_CATALOG.map((e) => e.icon).filter((i): i is string => i !== undefined);

// WCAG 的相对亮度
function luminance(hex: string): number {
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function svg(icon: string): string {
  return readFileSync(join(ICON_DIR, `${icon}.svg`), "utf8");
}

/** 这个标是不是位图。有一批牌子根本不发 SVG 标（国内几家、Klaviyo、Vanta…），
    #725 起精选层也认 png——下面那两条"读 SVG 文本"的断言对它们无从谈起，
    换成第四条：位图不许走 mask（不透明底会被 mask 成一个实心方块） */
const isPng = (icon: string): boolean => !existsSync(join(ICON_DIR, `${icon}.svg`));

describe("连接器目录的图标", () => {
  it("目录里写的每个 icon 都有对应的图标文件", () => {
    const files = new Set(
      readdirSync(ICON_DIR)
        .filter((n) => n.endsWith(".svg") || n.endsWith(".png"))
        .map((n) => n.slice(0, -4))
    );
    const missing = icons.filter((i) => !files.has(i));
    expect(missing, `这些 icon 在 src/renderer/src/assets/mcp/ 下没有文件`).toEqual([]);
  });

  it("走原色那一档的标，不能通篇都是近黑", () => {
    // 深色卡片底是 #1d1d1f（app.css 的 --card）。一个通篇近黑的标画在上面就是
    // 一格空白，而空白不报错。要么给它一个看得见的颜色，要么把它加进
    // lib/mcpDirectory.ts 的 MONO_ICONS——那边会用主题前景色重新上色。
    //
    // 只查"有没有一个不近黑的颜色"，不查具体对比度：品牌色是人挑的，逐个卡
    // 3:1 会把 Supabase 的绿判成不合格（它在浅色卡片底上只有 1.8:1，但看得
    // 清清楚楚——色相差补上了亮度差补不上的那部分）。这条断言只兜住"整个标
    // 都是黑的"这一类，剩下的判断留给 ADR-0180 里那份逐个过的记录。
    const invisible = icons
      .filter((i) => iconPaint(i) === "color")
      .filter((i) => !isPng(i))
      .filter((i) => {
        const declared = [...svg(i).matchAll(/(?:fill|stroke|stop-color)\s*[:=]\s*"?#([0-9a-f]{3,6})\b/gi)]
          .map((m) => m[1]!)
          .filter((hex) => hex.length === 3 || hex.length === 6);
        // 一个颜色都没声明 = 默认填充黑（github.svg 就是这样，标本身没写 fill）
        return !declared.some((hex) => luminance(hex) >= 0.06);
      });
    expect(invisible, "这些标通篇近黑，深色主题上看不见；加进 MONO_ICONS 或换个颜色").toEqual(
      []
    );
  });

  it("走 mask 那一档的标，里面不能有整幅的背景块", () => {
    // mask-image 只看 alpha：一块铺满 viewBox 的 rect 会让整个标变成实心方块
    const plated = icons
      .filter((i) => iconPaint(i) === "mono")
      .filter((i) => !isPng(i))
      .filter((i) => {
        const s = svg(i);
        const box = /viewBox="([\d.\s-]+)"/.exec(s)?.[1]?.trim().split(/\s+/).map(Number);
        if (box === undefined || box.length !== 4) return false;
        const [, , w, h] = box as [number, number, number, number];
        return [...s.matchAll(/<rect\b[^>]*>/g)].some((m) => {
          const tag = m[0];
          const num = (attr: string) =>
            Number(new RegExp(`\\b${attr}="([\\d.]+)"`).exec(tag)?.[1] ?? NaN);
          return num("width") >= w && num("height") >= h;
        });
      });
    expect(plated, "这些标带着整幅底板，当 mask 用会变成实心方块").toEqual([]);
  });

  it("位图的标不许走 mask 那一档 —— 会变成一格实心方块", () => {
    // mask 只看 alpha。SVG 的标是一条条路径，alpha 就是标本身的形状；
    // 位图不是——favicon 基本都带不透明底，mask 出来是一个纯色方块。
    // 这条断言是"精选层认 png"（#725）附带的那半个代价，写下来免得下次
    // 有人顺手把某个 png 键加进 MONO_ICONS
    const masked = icons.filter((i) => iconPaint(i) === "mono").filter(isPng);
    expect(masked, "这些标是 png，不能进 MONO_ICONS；换一张 svg，或让它走原色那一档").toEqual([]);
  });

  it("svg 的标里得真有形状 —— 空壳 svg 渲染出来是一片安静的空白", () => {
    // #725 扩表时用脚本从 simple-icons 批量生成，而那份 JSON 里根本没有 path
    // 字段（只有 title/slug/hex/source），于是 38 个文件全成了 `d="undefined"`。
    // 症状：卡片上什么都没有。不报错、不告警、连首字母色块都不会退回去——
    // 因为文件确实存在，iconUrl 找得到，<img> 老老实实画了一张空图。
    const empty = icons
      .filter((i) => !isPng(i))
      .filter((i) => {
        const s = svg(i);
        if (/\bd="(undefined|null|)"/.test(s)) return true;
        return !/<(path|circle|rect|polygon|ellipse|line|polyline)\b/.test(s);
      });
    expect(empty, "这些 svg 里没有可画的形状，卡片上会是一片空白").toEqual([]);
  });
});
