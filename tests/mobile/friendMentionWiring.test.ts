// 朋友私聊带了智能体之后打 @ 弹选人（#1493）。手机代码依赖 react-native 进不了 vitest，这里读源码钉住接线：
// ① 输入栏只在带了智能体时才接 onAt（没带的话打 @ 什么都不弹——名单是空的）；
// ② 选人抽屉用的是群聊页那一张 MentionSheet，名单 = 我带进来的那几只，不列朋友（@ 朋友没有去处）；
// ③ 挑中的名字经 ref.mention 插回光标处，等抽屉退场后再插（同 ChatScreen）；
// ④ 抽屉底下那一句换成私聊的口径——群里那句「不 @ 谁 = 它们自己认领」在私聊里是假话（不 @ 谁是发给朋友）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("FriendChatScreen", () => {
  const src = read("mobile/src/friends/FriendChatScreen.tsx");
  it("带了智能体才接 onAt", () => {
    // #1523：朋友公开给我的智能体也能 @，所以两边任一有就接
    // #1544：我主场里没带进来的那几只也能 @（先带进来再发），所以三者任一有就接
    // #1571 第二轮：没带进来的专员不再能 @（由管理员拉），所以只看两条车道
    expect(src).toMatch(/\{\.\.\.\(broughtNames\.length > 0 \|\| peerNames\.length > 0 \? \{ onAt: \(\) => setMentioning\(true\) \} : \{\}\)\}/);
  });
  it("MentionSheet 的名单 = 带进来的那几只，不列朋友", () => {
    // #1523：名单 = 我带进来的 + 朋友公开给我的；仍不列朋友（humans 恒空）
    // 两边的管理员同一个 agentId（真机 2026-10-05 分不清谁是谁的）：按 entries 画，我的叫「我的管理员」标「我的」，对方的叫「X的管理员」标「X 的」
    expect(src).toMatch(/\.\.\.broughtNames\.map\(\(a\) => \(\{ key: `mine:\$\{a\.agentId\}`, name: a\.name, tag: "我的"/);
    expect(src).toMatch(/\.\.\.peerNames\.map\(\(a\) => \(\{ key: `peer:\$\{a\.agentId\}`, name: a\.name, tag: `\$\{name\} 的`/);
    expect(src).toMatch(/name: id === ADMIN_AGENT_ID \? "我的管理员" : agentNameOf\(homeWs, id\)/);
    expect(src).toContain('name: `${name.replace(/\\s+/g, "")}的管理员`');
    expect(src).toMatch(/humans=\{\[\]\}/);
  });
  it("挑中的名字等抽屉退场再经 ref.mention 插回", () => {
    expect(src).toMatch(/ref=\{composer\}/);
    expect(src).toMatch(/requestAnimationFrame\(\(\) => composer\.current\?\.mention\(picked\)\)/);
  });
  it("底下那一句是私聊的口径", () => {
    // #1523：仅我可见时仍是那句；公开 / 朋友也带了时换成「进它的车道」那句
    expect(src).toMatch(/`@ 了它的那句只有你看得到/);
    expect(src).toMatch(/`@ 了智能体的那句进它的车道，不 @ 谁就是发给\$\{name\}。`/);
  });
});

describe("MentionSheet", () => {
  const src = read("mobile/src/chat/MentionSheet.tsx");
  it("footer 可换、可不画，默认仍是群里的派活规矩", () => {
    expect(src).toMatch(/footer = MENTION_FOOTER/);
    expect(src).toMatch(/footer !== null \?/);
  });
});
