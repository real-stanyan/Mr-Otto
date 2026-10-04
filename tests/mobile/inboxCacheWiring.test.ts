// 聊天列表本机快照的接线（#1471）。手机端组件进不了 vitest，失败全是安静的（列表照样一行一行蹦），判据落在源码上。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("inboxCache 接线", () => {
  it("App 一加载就挂上（越早读越好）", () => {
    expect(read("mobile/App.tsx")).toMatch(/import "\.\/src\/inbox\/inboxCache\.js";/);
  });
  it("三份同一拍铺上，且只在网上那份还没到时铺", () => {
    const src = read("mobile/src/inbox/inboxCache.ts");
    expect(src).toMatch(/hydrateHome\([\s\S]*hydrateTeams\([\s\S]*hydrateFriends\(/);
    expect(read("mobile/src/home/homeStore.ts")).toMatch(/export function hydrateHome[\s\S]*?if \(store\.get\(\)\.loaded \|\| p\.home === null\) return;/);
    expect(read("mobile/src/inbox/teamsStore.ts")).toMatch(/export function hydrateTeams[\s\S]*?if \(store\.get\(\)\.loaded\) return;/);
    expect(read("mobile/src/friends/friendsStore.ts")).toMatch(/export function hydrateFriends[\s\S]*?if \(s\.rows !== null/);
  });
  it("读完之前不存；退出登录清掉这个账号的那一份", () => {
    const src = read("mobile/src/inbox/inboxCache.ts");
    expect(src).toMatch(/if \(me === null \|\| !restored\) return;/);
    expect(src).toMatch(/removeItem\(inboxCacheKey\(prev\)\)/);
  });
  it("列表等三份到齐（有上限）才一起画", () => {
    const src = read("mobile/src/tabs/ChatsScreen.tsx");
    expect(src).toMatch(/const allIn = home\.loaded && teams\.loaded && friendsRows !== null;/);
    expect(src).toMatch(/data=\{loading \? \[\] : rows\}/);
  });
});
