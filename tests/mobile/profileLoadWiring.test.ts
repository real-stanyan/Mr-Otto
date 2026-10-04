// 本人资料什么时候拉（#1519）。手机端组件进不了 vitest，失败是安静的（头像退成字母块照样画），判据落在源码上。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("profileStore 接线", () => {
  it("useMyName 自己保证仓里有一份——冷启动直接进聊天也拉，不等去过「我」页", () => {
    const src = read("mobile/src/tabs/MeScreen.tsx");
    expect(src).toMatch(/export function useMyName[\s\S]*?const \{ me, loaded \} = useProfile\(\);[\s\S]*?if \(!loaded\) void ensureProfile\(\);[\s\S]*?\}, \[loaded\]\);/);
  });
  it("ensureProfile 并发去重：几个屏同时挂上只发一条查询", () => {
    const src = read("mobile/src/me/profileStore.ts");
    expect(src).toMatch(/export function ensureProfile\(\): Promise<void> \{[\s\S]*?inflight \?\?= refreshProfile\(\)\.finally\(\(\) => \{[\s\S]*?inflight = null;/);
  });
});
