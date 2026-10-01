// 手机端应用图标（#1437）是从桌面那套资源**生成**的。三种失手都不报错，只是屏上少一个标：
// ① 加了图标 / 改了 MONO_ICONS 却没重跑脚本（手机上还是首字母，或颜色档不对）
// ② mono 标里还留着写死的颜色（深色底上一格黑）
// ③ 产物里混进渲染器不认的 <style> / class（画出来是一坨黑）
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_CATALOG } from "../../src/shared/mcpCatalog.js";
import { iconPaint } from "../../src/shared/appIcon.js";
import { APP_ICON_PNG_KEYS, APP_ICON_SVG } from "./mobileAppIconsFixture.js";

const root = join(__dirname, "..", "..");
const icons = [...new Set(MCP_CATALOG.map((e) => e.icon).filter((i): i is string => i !== undefined))];

describe("手机端应用图标", () => {
  it("产物与源一致（过期了就跑 node scripts/gen-mobile-app-icons.mjs）", () => {
    expect(() => execFileSync("node", [join(root, "scripts/gen-mobile-app-icons.mjs"), "--check"], { stdio: "pipe" })).not.toThrow();
  });

  it("目录里每个 icon 在手机上都画得出来：不是 svg 就是 png，不重不漏", () => {
    const missing = icons.filter((i) => APP_ICON_SVG[i] === undefined && !APP_ICON_PNG_KEYS.includes(i));
    expect(missing).toEqual([]);
    expect(icons.filter((i) => APP_ICON_SVG[i] !== undefined && APP_ICON_PNG_KEYS.includes(i))).toEqual([]);
  });

  it("mono 标里不留写死的颜色，且真的有地方吃 currentColor", () => {
    for (const i of icons.filter((x) => iconPaint(x) === "mono")) {
      const xml = APP_ICON_SVG[i];
      expect(xml, `${i} 是 mono，必须是 svg`).toBeDefined();
      expect(xml, i).not.toMatch(/(fill|stroke)="#/);
      expect(xml, i).toContain("currentColor");
    }
  });

  it("产物里没有渲染器不认的 <style> / class / style", () => {
    for (const [i, xml] of Object.entries(APP_ICON_SVG)) expect(xml, i).not.toMatch(/<style|\sclass=|\sstyle=/);
  });
});
