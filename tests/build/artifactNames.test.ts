// 产物命名的可执行契约（issue #306）。
//
// 背景：GitHub Release 上传时把资产文件名里的空格改写成点（Mr Otto-… 变
// Mr.Otto-…）。release.mjs 按本地文件名写 SHA256SUMS、更新器（updaterCore）
// 按 Release 资产名查条目——产物名一带空格，三者对不上，OTA 直接报
// 「SHA256SUMS 里没有 … 的条目」（v1.0.1 首发翻的车）。
//
// 所以：electron-builder.yml 里每个 target 都必须显式给 artifactName，
// 且不含空格、不引用 ${productName}（它是 "Mr Otto"，带空格）。
// 另一条是更新器的暗号：mac 的 zip 资产必须以 -arm64-mac.zip 收尾
// （updaterCore 按这个后缀认包），mac.artifactName 的形状要保住它。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const yml = readFileSync(join(__dirname, "../../electron-builder.yml"), "utf8");

/** 所有 artifactName 的值（yml 是扁平缩进，正则够用，不引 yaml 依赖） */
const artifactNames = [...yml.matchAll(/^\s*artifactName:\s*(.+?)\s*$/gm)].map((m) => m[1]);

describe("electron-builder 产物命名", () => {
  it("mac / dmg / nsis 三处 artifactName 都显式声明了", () => {
    // 少一处就是有 target 回落到 electron-builder 默认名（${productName}-…，带空格）
    expect(artifactNames.length).toBeGreaterThanOrEqual(3);
  });

  it("产物名不含空格、不引用带空格的 ${productName}", () => {
    for (const name of artifactNames) {
      expect(name, `artifactName「${name}」`).not.toMatch(/[ ]/);
      expect(name, `artifactName「${name}」`).not.toContain("${productName}");
    }
  });

  it("mac 的 zip 名保住更新器认的 -mac.${ext} 后缀", () => {
    const macSection = yml.slice(yml.indexOf("\nmac:"), yml.indexOf("\ndmg:"));
    const mac = macSection.match(/^\s*artifactName:\s*(.+?)\s*$/m)?.[1];
    expect(mac, "mac.artifactName 必须存在").toBeTruthy();
    expect(mac!).toMatch(/-mac\.\$\{ext\}$/);
  });
});
