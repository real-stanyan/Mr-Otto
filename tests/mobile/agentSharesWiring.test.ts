// 共有的智能体（#1545）在手机端的接线。判据在 shared（agentShares.test）真跑，这里读源码钉住：
// ① 接受名片之后记一行 agent_shares（分享方原 id ↔ 我这边新 id）、往私聊里说一句；两件都尽力而为，不碰「已保存」；
// ② 资料页的 tag、通讯录那一行的小字都从 shareBadgeFor 来；进页面拉一次 shares。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("接受名片之后", () => {
  const src = read("mobile/src/friends/ContactCardBubble.tsx");
  it("记一行 agent_shares（原主人 + 原 id + 我 + 新 id + 名字），再告诉分享方；都在 setAccepted 之后、都不抛", () => {
    expect(src).toMatch(/recordAgentShare\(supabase, \{ ownerUid: card\.from\.uid, agentId: card\.agentId, withUid: selfUid, copyAgentId: agentId, name: card\.name \}\)/);
    expect(src).toMatch(/sendToFriend\(card\.from\.uid, acceptedShareText\(card\.name\)\)\.catch\(\(\) => undefined\)/);
    expect(src.indexOf("setAccepted(true)")).toBeLessThan(src.indexOf("recordAgentShare(supabase"));
  });
});

describe("标「共有」", () => {
  it("资料页 tag：共有时接在「等级 · 域」后面（#1571 第 4 步起 tag 先写等级与域）", () => {
    const src = read("mobile/src/agent/AgentScreen.tsx");
    expect(src).toMatch(/const shareBadge = shareBadgeFor\(agentId, shares, nameOfUid\);/);
    expect(src).toMatch(/\$\{shareBadge === null \? "" : ` · \$\{shareBadge\}`\}`\}/);
  });
  it("通讯录那一行：小字前面标；进页面拉一次 shares", () => {
    const src = read("mobile/src/tabs/ContactsScreen.tsx");
    expect(src).toMatch(/shareBadgeFor\(a\.agentId, shares, nameOfUid\)/);
    expect(src).toMatch(/useFocusEffect\(useCallback\(\(\) => \{ void refreshAgentShares\(\); \}, \[\]\)\);/);
  });
  it("store：读我参与的全部行；读不到当没有", () => {
    const api = read("src/shared/agentSharesApi.ts");
    expect(api).toMatch(/\.or\(`owner_uid\.eq\.\$\{selfUid\},with_uid\.eq\.\$\{selfUid\}`\)/);
    expect(api).toMatch(/if \(res\.error \|\| !Array\.isArray\(res\.data\)\) return \[\];/);
  });
});
