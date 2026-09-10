// tests/main/taskWorkspace.resume.test.ts
import { describe, expect, it } from "vitest";
import { resolveResumeWorkspace } from "../../src/main/taskWorkspace.js";
import type { SessionCreatedEvent } from "../../src/session/events.js";

const created = (extra: Partial<SessionCreatedEvent>): SessionCreatedEvent =>
  ({ seq: 0, sessionId: "s-20260910000000-abcdef12", ts: 0, type: "session_created", ...extra }) as SessionCreatedEvent;
const builtin = "/Users/me/Documents/Mr Otto/Default";

describe("resolveResumeWorkspace（#1223，spec §3.6 Default 路径）", () => {
  it("default 种、日志里的目录本机存在：照用", () => {
    const made: string[] = [];
    const ws = resolveResumeWorkspace(created({ workspace: "/Users/other/Documents/Mr Otto/Default/s-20260910000000-abcdef12", workspaceKind: "default" }), "s-20260910000000-abcdef12", { builtin, exists: () => true, mkdir: (p) => made.push(p) });
    expect(ws).toBe("/Users/other/Documents/Mr Otto/Default/s-20260910000000-abcdef12");
    expect(made).toEqual([]);
  });
  it("default 种、目录不在（另一台 Mac 建的）或日志没记路径（云端建的）：按 sessionId 派生并 mkdir", () => {
    const made: string[] = [];
    const deps = { builtin, exists: () => false, mkdir: (p: string) => made.push(p) };
    expect(resolveResumeWorkspace(created({ workspace: "/Users/other/Documents/Mr Otto/Default/s-20260910000000-abcdef12", workspaceKind: "default" }), "s-20260910000000-abcdef12", deps)).toBe(`${builtin}/s-20260910000000-abcdef12`);
    expect(resolveResumeWorkspace(created({ workspaceKind: "default" }), "s-20260910000000-abcdef12", deps)).toBe(`${builtin}/s-20260910000000-abcdef12`);
    expect(made).toEqual([`${builtin}/s-20260910000000-abcdef12`, `${builtin}/s-20260910000000-abcdef12`]);
  });
  it("项目会话：一切照旧——有路径用路径，没路径 null", () => {
    const deps = { builtin, exists: () => false, mkdir: () => {} };
    expect(resolveResumeWorkspace(created({ workspace: "/repo" }), "x", deps)).toBe("/repo");
    expect(resolveResumeWorkspace(created({}), "x", deps)).toBeNull();
  });
});
