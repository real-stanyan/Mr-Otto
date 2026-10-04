// 代办入口在 daemon 里的接线（#1564，ADR-0363）：公开出去的车道名单里管理员必须在——三处入口都走 delegationRoster。
// daemon.ts 进不了 vitest，读源码钉住；正则不依赖换行（工作区可能是 CRLF）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon：公开车道必带管理员", () => {
  it("朋友替主人开的车道：名单 = 管理员 + 公开智能体", () => {
    expect(src).toMatch(/chat = \{ kind: "pair", peerUid: byUid, facing: "both", agentIds: delegationRoster\(\[\], publicAgentId as string\) \};/);
  });
  it("主人一开始就公开着建的车道：建之前把管理员补进名单", () => {
    expect(src).toMatch(/if \(chat\?\.kind === "pair" && chat\.facing === "both"\) chat = \{ \.\.\.chat, agentIds: delegationRoster\(chat\.agentIds\) \};\s*\/\/ 建一条聊天/);
  });
  it("切成公开那一刻补管理员；收回私密不动名单", () => {
    expect(src).toMatch(/if \(patch\.facing === "both"\) \{\s*const cur = patch\.agentIds \?\? chat\.agentIds;\s*if \(!cur\.includes\(ADMIN_AGENT_ID\)\) patch = \{ \.\.\.patch, agentIds: delegationRoster\(cur\) \};/);
  });
});
