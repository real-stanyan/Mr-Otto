// message_friend 在 sessionService / daemon 里的接线（#1549）：亮刀条件与 call_friend 逐字相同、监督轮不亮、daemon 接的是同一个 hub。
// 读源码验（sessionService 的装配进不了轻量夹具）；正则不依赖换行（工作区可能是 CRLF）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const ss = read("services/runtime/src/sessionService.ts");
const daemon = read("services/runtime/src/daemon.ts");

describe("sessionService：message_friend", () => {
  it("opts.friendMessage 可选（同 laneBridge 的理由），缺席 = 刀不挂", () => {
    expect(ss).toMatch(/friendMessage\?: \{\s*send\(o: \{ agentId: string; agentName: string; friend: string; text: string \}\): Promise<string>;\s*\} \| null;/);
    expect(ss).toMatch(/const friendMessage = opts\.friendMessage \?\? null;/);
  });
  it("亮刀条件与 call_friend 相同：主场（approveAll）、不在外联会话、不在车道；maySend 的两句与 mayCall 同构", () => {
    expect(ss).toMatch(/const callFriendTool =\s*opts\.outreach === null \|\| !opts\.approveAll \|\| isOutreach \|\| isPair/);
    expect(ss).toMatch(/const messageFriendTool =\s*friendMessage === null \|\| !opts\.approveAll \|\| isOutreach \|\| isPair/);
    expect(ss).toMatch(/maySend: \(\) =>\s*ownerSpoke\s*\? null\s*: rerunTurn\s*\? "这一轮是服务重启后的补跑：这条消息上一次可能已经发出去了/);
    expect(ss).toMatch(/"只有他本人亲口让你发，才能给他的好友发消息。这一轮不是。"/);
  });
  it("工具表里紧挨着 call_friend，同样受监督的轮不亮；agentName 取 specNames 里的现名", () => {
    expect(ss).toMatch(/\.\.\.\(callFriendTool !== null && adminOnly && !supervisedTurn\(\) \? \[callFriendTool\] : \[\]\),\s*\.\.\.\(messageFriendTool !== null && adminOnly && !supervisedTurn\(\) \? \[messageFriendTool\] : \[\]\),/);
    expect(ss).toMatch(/friendMessage\.send\(\{ agentId: spec\.agentId, agentName: specNames\.get\(spec\.agentId\) \?\? spec\.name, friend, text \}\)/);
  });
});

describe("daemon：message_friend", () => {
  it("hub 的 sendDm 用 service key 往 messages 表 insert（sender 是主人），出错抛", () => {
    expect(daemon).toMatch(/sendDm: async \(sender, recipient, body\) => \{\s*const \{ error \} = await supabase\.from\("messages"\)\.insert\(\{ sender, recipient, body \}\);\s*if \(error\) throw new Error\(error\.message\);/);
  });
  it("每条会话的 friendMessage 与 outreach 同一个开关（有 hub 且主场），出口是同一个 hub 的 message", () => {
    expect(daemon).toMatch(/friendMessage: outreachHub === null \|\| !approveAll \? null : \{ send: \(o\) => outreachHub\.message\(\{ \.\.\.o, workspaceId, ownerUid \}\) \},/);
  });
});
