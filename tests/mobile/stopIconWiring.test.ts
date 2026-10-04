// 手机聊天页「此刻」那一行的停钮改成图标（#1482）。手机代码依赖 react-native 进不了 vitest，
// 读源码钉住三件事：① 钮里是桌面同一个符号（lucide `square` 填实），不再是字「停」；
// ② 「正在停」给一个转圈，不是字也不是什么都没有；③ 无障碍标签还在——VoiceOver 读的是它。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("TypingRow 的停钮", () => {
  const src = read("mobile/src/chat/Bubbles.tsx");
  const typingRow = src.slice(src.indexOf("export function TypingRow"), src.indexOf("function TypingDots"));

  it("画的是实心方块图标，不是字「停」/「正在停…」", () => {
    expect(typingRow).toMatch(/<Icon name="square"[^>]*\bfill\b/);
    expect(typingRow).not.toContain('"停"');
    expect(typingRow).not.toContain("正在停");
  });

  it("正在停：转圈替掉方块", () => {
    expect(typingRow).toMatch(/stopping \? <ActivityIndicator/);
  });

  it("无障碍标签照旧", () => {
    expect(typingRow).toContain("accessibilityLabel={`让${name}停下这一轮`}");
  });
});

describe("Icon 组件", () => {
  const src = read("mobile/src/wx/Icon.tsx");
  it("有 fill 开关：填实时用同一个颜色填，默认仍只描边", () => {
    expect(src).toMatch(/fill\?: boolean/);
    expect(src).toMatch(/fill=\{fill \? color : "none"\}/);
  });
});
