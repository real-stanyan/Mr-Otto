import { describe, it, expect } from "vitest";
import {
  appBundlePathFromExe,
  isNewerVersion,
  isTranslocated,
  parseLatestRelease,
  parseShasums,
  parseVersion,
} from "../../src/main/updaterCore.js";

describe("parseVersion / isNewerVersion", () => {
  it("认 v 前缀和裸三段；预发布/缺段/垃圾一律 null", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3-beta.1")).toBeNull();
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("abc")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });

  it("逐段数值比较，不是字符串比较", () => {
    expect(isNewerVersion("1.0.10", "1.0.9")).toBe(true); // 字符串比较会翻车的那一对
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("0.9.9", "1.0.0")).toBe(false);
  });

  it("解析不了的一侧当没有新版——识别不了宁可漏报", () => {
    expect(isNewerVersion("weird", "1.0.0")).toBe(false);
    expect(isNewerVersion("2.0.0", "weird")).toBe(false);
  });
});

describe("parseLatestRelease", () => {
  const release = (over: object = {}) => ({
    tag_name: "v1.2.0",
    html_url: "https://github.com/real-stanyan/Mr-Otto/releases/tag/v1.2.0",
    assets: [
      { name: "Mr Otto-1.2.0-arm64.dmg", browser_download_url: "https://dl/dmg" },
      { name: "Mr Otto-1.2.0-arm64-mac.zip", browser_download_url: "https://dl/zip" },
      { name: "SHA256SUMS", browser_download_url: "https://dl/sums" },
    ],
    ...over,
  });

  it("完整 Release：按后缀认 zip，带上 SHA256SUMS 和页面 URL", () => {
    expect(parseLatestRelease(release())).toEqual({
      version: "1.2.0",
      zipUrl: "https://dl/zip",
      zipName: "Mr Otto-1.2.0-arm64-mac.zip",
      shasumsUrl: "https://dl/sums",
      pageUrl: "https://github.com/real-stanyan/Mr-Otto/releases/tag/v1.2.0",
    });
  });

  it("缺 zip 资产 = null；缺 SHA256SUMS 仍解析（拒绝下载在 updater 那层）", () => {
    expect(parseLatestRelease(release({ assets: [] }))).toBeNull();
    const noSums = parseLatestRelease(
      release({ assets: [{ name: "a-arm64-mac.zip", browser_download_url: "https://dl/z" }] }),
    );
    expect(noSums?.shasumsUrl).toBeNull();
  });

  it("形状不对不炸：null / 数组 / tag 不是版本号 → null", () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease([])).toBeNull();
    expect(parseLatestRelease(release({ tag_name: "nightly" }))).toBeNull();
    expect(parseLatestRelease({ tag_name: "v1.0.0" })).toBeNull(); // 没 assets
  });
});

describe("parseShasums", () => {
  it("shasum 标准格式；文件名带空格；大写哈希转小写；坏行跳过", () => {
    const text = [
      "ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789  Mr Otto-1.2.0-arm64-mac.zip",
      "0000000000000000000000000000000000000000000000000000000000000001 *binary-mode.zip",
      "not a checksum line",
      "",
    ].join("\n");
    const m = parseShasums(text);
    expect(m.get("Mr Otto-1.2.0-arm64-mac.zip")).toBe(
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
    expect(m.get("binary-mode.zip")).toBe(
      "0000000000000000000000000000000000000000000000000000000000000001",
    );
    expect(m.size).toBe(2);
  });
});

describe("路径判定", () => {
  it("Translocation 看路径特征", () => {
    expect(isTranslocated("/private/var/folders/xy/AppTranslocation/ABC/d/Mr Otto.app/Contents/MacOS/Mr Otto")).toBe(true);
    expect(isTranslocated("/Applications/Mr Otto.app/Contents/MacOS/Mr Otto")).toBe(false);
  });

  it("从 execPath 找 .app 根；没有 .app 段回 null", () => {
    expect(appBundlePathFromExe("/Applications/Mr Otto.app/Contents/MacOS/Mr Otto")).toBe(
      "/Applications/Mr Otto.app",
    );
    expect(appBundlePathFromExe("/usr/local/bin/electron")).toBeNull();
  });
});
