import { describe, it, expect } from "vitest";
import { gitHostRows, gitHostsNotice } from "../../../src/renderer/src/lib/gitHostsView.js";
import type { CsGitHost } from "../../../src/shared/remote/cloudSession.js";
import type { WorkspaceMemberRow } from "../../../src/shared/workspaces.js";

const NOW = new Date("2026-09-08T12:00:00Z").getTime();
const AT = new Date("2026-09-06T00:00:00Z").getTime();
const host = (over: Partial<CsGitHost> = {}): CsGitHost => ({ host: "github.com", addedBy: "u1", addedAt: AT, ...over });
const member = (uid: string, label: string): WorkspaceMemberRow => ({ uid, role: "member", label, avatarUrl: "" });

describe("gitHostRows", () => {
  it("认得出添加者时写「由某某添加 · 日期」", () => {
    const [row] = gitHostRows([host()], [member("u1", "小红")], true, NOW);
    expect(row).toMatchObject({ host: "github.com", canRemove: true });
    expect(row!.meta).toContain("由 小红 添加");
    expect(row!.meta).toContain("9/6");
  });

  it("添加者退群 / 查不到 → 只写日期，**不回显 uid**", () => {
    const [row] = gitHostRows([host({ addedBy: "gone-uid" })], [], true, NOW);
    expect(row!.meta).toBe("9/6");
    expect(row!.meta).not.toContain("gone-uid");
  });

  it("非 owner 不给删除钮 —— 点了必然拿到「无权修改」的钮是撒谎的勾", () => {
    const [row] = gitHostRows([host()], [], false, NOW);
    expect(row!.canRemove).toBe(false);
  });

  it("不重排 —— 排序在服务端那侧，两处各排一次迟早分家", () => {
    const rows = gitHostRows([host({ host: "z.com" }), host({ host: "a.com" })], [], true, NOW);
    expect(rows.map((r) => r.host)).toEqual(["z.com", "a.com"]);
  });
});

describe("gitHostsNotice", () => {
  it("三种「空」各说各的话，不许合并", () => {
    expect(gitHostsNotice(undefined, true)).toMatchObject({ tone: "muted", text: "正在读取…" });
    // 读不到 → 红字；一台都没配 → 空态。合并它们就是把「读不到」画成「没有」
    expect(gitHostsNotice(null, false)).toMatchObject({ tone: "err" });
    expect(gitHostsNotice([], false)).toMatchObject({ tone: "muted" });
    expect(gitHostsNotice(null, false)!.text).not.toBe(gitHostsNotice([], false)!.text);
  });

  it("有内容就不说话", () => {
    expect(gitHostsNotice([host()], false)).toBeNull();
  });
});
