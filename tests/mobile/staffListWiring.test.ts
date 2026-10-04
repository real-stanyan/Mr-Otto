// 员工表 + 任务卡 + 藏掉旧入口（#1571 第 4 步）在手机端的接线。判据在 shared 真跑（agentTier / tasks / mobileChat 的测试），这里读源码钉住：
// ① 侧页是员工表：只列 L0 / L1，点一只进资料页、管理员那行进它的私聊；不再左滑删智能体的聊天；
// ② 资料页：状态 / 当前任务 / 子工；
// ③ 旧入口藏掉：两处「新建智能体」、名片里的智能体、长按派活改派给管理员；
// ④ 任务卡：mobileChat 多一种 task 行，Bubbles 画 TaskCard；tasksStore 登录就拉 + 订实时。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("员工表", () => {
  const src = read("mobile/src/inbox/AgentPanel.tsx");
  it("只列 L0 / L1；每行写等级 · 域；状态行挂任务", () => {
    expect(src).toMatch(/const staff = visibleAgents\(ws\?\.agents \?\? \[\]\);/);
    expect(src).toMatch(/const role = `\$\{TIER_LABEL\[tierOf\(a\)\]\} · \$\{domainLabel\(domainOf\(a\)\)\}`;/);
    expect(src).toMatch(/liveTaskOf\(tasks\.rows\.values\(\), a\.agentId, where\.sessionId\)/);
    expect(src).toMatch(/taskLine\(task, \(id\) => tasks\.rows\.get\(id\)\?\.title \?\? null\)/);
  });
  it("点一只进它的私聊；别人的智能体那格还是聊天", () => {
    // 2026-10-05 真机改口：点一只直接进它的私聊（资料页从聊天信息页进）；头像压未读，看过就灭
    expect(src).toMatch(/onPick\(\{ kind: "chat", route: \{ kind: "agent", agentId: a\.agentId \} \}\)/);
    expect(src).toMatch(/row\?\.unread\?\.kind === "count" \? \(/);
    expect(src).toMatch(/for \(const r of inbox\.rows\) if \(r\.target\.kind === "agent"\) m\.set\(r\.target\.agentId, r\);/);
    expect(src).toMatch(/onPick\(\{ kind: "chat", route: r\.target \}\)/);
    const chats = read("mobile/src/tabs/ChatsScreen.tsx");
    expect(chats).toMatch(/if \(next\.kind === "agent"\) navigation\.navigate\("Agent", \{ agentId: next\.agentId \}\);\s*else navigation\.navigate\("Chat", next\.route\);/);
  });
  it("管理员那条私聊留在聊天主页（splitInbox 不把它收进侧页）", () => {
    expect(read("src/shared/wechatInbox.ts")).toMatch(/if \(r\.target\.kind === "agent" && r\.target\.agentId !== ADMIN_AGENT_ID\) s\.agents\.push\(r\);/);
  });
});

describe("资料页", () => {
  const src = read("mobile/src/agent/AgentScreen.tsx");
  it("tag 写等级 · 域；状态 / 当前任务一组；子工一组（只在上级这里）", () => {
    expect(src).toMatch(/tag=\{`\$\{TIER_LABEL\[tierOf\(agent\)\]\} · \$\{domainLabel\(domainOf\(agent\)\)\}/);
    expect(src).toMatch(/<Row label="状态" value=\{agentStatusText\(where, \(\) => null\)\} \/>/);
    expect(src).toMatch(/const subs = subworkersOf\(agentId, ws\.agents\);/);
  });
});

describe("旧入口藏掉", () => {
  it("两处「新建智能体」没了", () => {
    expect(read("mobile/src/tabs/ChatsScreen.tsx")).not.toMatch(/import \{ NewAgentDialog|label: "新建智能体"|<NewAgentDialog/);
    const contacts = read("mobile/src/tabs/ContactsScreen.tsx");
    expect(contacts).not.toMatch(/import \{ NewAgentDialog|accessibilityLabel="新建智能体"|<NewAgentDialog/);
    expect(contacts).toMatch(/visibleAgents\(ws\?\.agents \?\? \[\]\)/);
  });
  it("名片只推朋友，不发智能体；长按派活派给管理员", () => {
    const friend = read("mobile/src/friends/FriendChatScreen.tsx");
    expect(friend).toMatch(/title="发名片"[\s\S]{0,400}options=\{\[\]\}/);
    expect(friend).toMatch(/agentIds=\{\[ADMIN_AGENT_ID\]\}/);
    expect(read("mobile/src/chat/ChatScreen.tsx")).toMatch(/agentIds=\{\[ADMIN_AGENT_ID\]\}/);
  });
});

describe("任务卡与 store", () => {
  it("Bubbles 画 TaskCard；tasksStore 登录就订、SUBSCRIBED 再拉、回前台再拉", () => {
    const bubbles = read("mobile/src/chat/Bubbles.tsx");
    expect(bubbles).toMatch(/case "task":\s*return <TaskCard row=\{row\} \/>;/);
    const store = read("mobile/src/tasks/tasksStore.ts");
    expect(store).toMatch(/subscribeTasks\(supabase, uid, \{/);
    expect(store).toMatch(/if \(s === "SUBSCRIBED"\) void refreshTasks\(\);/);
    expect(store).toMatch(/if \(s === "active" && store\.get\(\)\.uid !== null\) void refreshTasks\(\);/);
  });
});

describe("资料页能删人（#1571 第二轮第 7 条，员工表之后专员的私聊不再从列表进得去）", () => {
  it("非管理员有「删除这只智能体」，与聊天信息页同一份 deleteDeps / Confirm；管理员那行写删不掉", () => {
    const src = read("mobile/src/agent/AgentScreen.tsx");
    expect(src).toMatch(/import \{ Confirm, DangerRow, deleteDeps \} from "\.\.\/chat\/ChatInfoScreen\.js";/);
    expect(src).toMatch(/<DangerRow label="删除这只智能体"/);
    expect(src).toMatch(/deleteAgentEverywhere\(deleteDeps, supabase, ws\.id, agentId\)/);
    expect(src).toMatch(/管理员删不掉/);
  });
  it("管理员拉人 / 请人落的名单事件不带主人的 uid（时间线那句读 byName「管理员」，不写成「你把…」）", () => {
    expect(read("services/runtime/src/sessionService.ts")).toMatch(/session\.updateChatRoster\("", \{ agentIds \}, "管理员"\)/);
  });
});
