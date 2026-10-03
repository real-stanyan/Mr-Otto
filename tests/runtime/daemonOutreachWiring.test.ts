// daemon.ts 进不了 vitest。外联（#1441）在它身上的接线，漏了或传 null 都是安静的：
// 刀永远不出现、收尾汇报永远丢、好友听不到声音。所以判据落在源码上（同 daemonCallbackWiring.test.ts）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon.ts：外联的接线（#1441）", () => {
  it("hub 接上了真数据源，且推送关着时没有 hub", () => {
    for (const k of ["friendsOf:", "deviceCount:", "ownerBlocked:", "countSince:", "ensureSession:", "origin:", "agentName:"]) {
      expect(src).toContain(k);
    }
    expect(src).toMatch(/const outreachHub =\s*apns === null\s*\?\s*null\s*:\s*createOutreachHub\(/);
  });
  it("好友名单只认 accepted 的行，查询出错抛", () => {
    expect(src).toMatch(/from\("friendships"\)[\s\S]{0,120}\.eq\("status", "accepted"\)/);
    expect(src).toMatch(/friendsOf:[\s\S]{0,600}if \(error\) throw/);
  });
  it("额度闸复用 decideRuntimeRoute + hostedProbe，不另造判据", () => {
    expect(src).toMatch(/ownerBlocked:[\s\S]{0,300}decideRuntimeRoute\([\s\S]{0,120}hostedProbe\.me\(ownerUid\)/);
  });
  it("外联会话的 insert 带 chat_kind 与 peer_uid（由 ensureOutreachSession 的 insert 回调落库）", () => {
    expect(src).toMatch(/ensureOutreachSession<CloudSession>\(/);
    expect(src).toMatch(/from\("workspace_sessions"\)\.insert\(row\)/);
    expect(src).toMatch(/\.eq\("chat_kind", "outreach"\)[\s\S]{0,120}\.eq\("peer_uid", peerUid\)/);
    expect(src).toMatch(/syncGuests: syncGuestRows/);
  });
  it("每条会话的 outreach / onOutreachEnded / signSpeechTicket 都接了真的，不再是 null", () => {
    expect(src).not.toMatch(/onOutreachEnded:\s*null/);
    expect(src).not.toMatch(/\boutreach:\s*null,/);
    expect(src).toMatch(/onOutreachEnded:\s*outreachHub === null \? null : \(r\) => void outreachHub\.ended\(workspaceId, ownerUid, r\)/);
    expect(src).toMatch(/outreach:\s*outreachHub === null \|\| !approveAll\s*\?\s*null\s*:\s*\{ dispatch: \(o\) => outreachHub\.dispatch\(\{ \.\.\.o, workspaceId, ownerUid \}\) \}/);
  });
  it("补种子 / 摘归档房 / 开房幂等三处接线", () => {
    expect(src).toMatch(/hasSeed: \(id\) => storeFor\(workspaceId\)\.lastOfType\(id, "session_created"\) !== null/);
    expect(src).toMatch(/discard: discardRoom/);
    expect(src).toMatch(/discardRoom\(row\.id\)/); // 启动补开发现归档走同一个函数
    expect(src).toMatch(/async function openExistingRoom\([\s\S]{0,300}activeSessions\.get\(sessionId\)\?\.session/);
  });
  it("openSessionRoom 幂等：入口先查 activeSessions，装配本体只经它进（终审 I2）", () => {
    // 启动补开那一圈与外联开原聊天 / 外联会话会在同一段启动窗口里碰上同一条会话；守卫拆掉就是两个 CloudSession 写一份日志
    expect(src).toMatch(/function openSessionRoom\([\s\S]{0,900}return liveOr\(activeSessions\.get\(sessionId\)\?\.session, \(\) =>\s*assembleSessionRoom\(/);
    // 装配本体只有 openSessionRoom 这一个调用方（别的调用方绕过守卫直接装配，就回到了老样子）
    expect(src.match(/assembleSessionRoom\(/g)).toHaveLength(2); // 定义 + 守卫里那一次
    // 启动补开仍走 openSessionRoom（不是直接 assembleSessionRoom）
    expect(src).toMatch(/const session = openSessionRoom\(row\.workspace_id, row\.id,/);
  });
  it("语音票用 config.runtimeSecret 签", () => {
    expect(src).toMatch(/signSpeechTicket:\s*\(t\)\s*=>\s*signSpeechTicket\(t, config\.runtimeSecret\)/);
  });
  it("原会话房关着时按启动补开同一套步骤开（workspaceFacts + openSessionRoom）", () => {
    expect(src).toMatch(/async function openExistingRoom\([\s\S]{0,300}workspaceFacts\([\s\S]{0,200}openSessionRoom\(/);
    expect(src).toMatch(/open: \(w, id, publisherUid\) => openExistingRoom\(w, id, publisherUid\)/);
  });
});
