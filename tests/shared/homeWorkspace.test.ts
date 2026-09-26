// 主场「有就用、没有就建、两台设备同时建时回头重查」——手机与桌面共用这一段（#1356）。
// 判据是「回头重查」而不是错误码：PostgREST 的 code 在不同版本里挂的位置不一样（#1213）。
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureHomeWorkspace, type HomeWorkspaceDeps } from "../../src/shared/homeWorkspace.js";
import { HOME_WORKSPACE_NAME } from "../../src/shared/workspaces.js";

const client = {} as SupabaseClient;

function deps(o: Partial<HomeWorkspaceDeps>): HomeWorkspaceDeps {
  return {
    findHomeWorkspace: vi.fn(async () => null),
    createWorkspace: vi.fn(async () => ({ id: "made" })),
    ...o,
  };
}

describe("ensureHomeWorkspace", () => {
  it("已经有主场：直接用，不建", async () => {
    const d = deps({ findHomeWorkspace: vi.fn(async () => "home-1") });
    expect(await ensureHomeWorkspace(d, client, "u1")).toEqual({ id: "home-1" });
    expect(d.createWorkspace).not.toHaveBeenCalled();
  });

  it("没有：用 HOME_WORKSPACE_NAME 建一个 home", async () => {
    const d = deps({});
    expect(await ensureHomeWorkspace(d, client, "u1")).toEqual({ id: "made" });
    expect(d.createWorkspace).toHaveBeenCalledWith(client, HOME_WORKSPACE_NAME, "u1", "home");
  });

  it("建的时候撞了（另一台设备先建了）：回头重查，查得到就用它", async () => {
    const find = vi.fn<HomeWorkspaceDeps["findHomeWorkspace"]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("home-raced");
    const d = deps({ findHomeWorkspace: find, createWorkspace: vi.fn(async () => { throw new Error("23505"); }) });
    expect(await ensureHomeWorkspace(d, client, "u1")).toEqual({ id: "home-raced" });
  });

  it("建失败且重查也没有：抛原来那个错", async () => {
    const boom = new Error("rls");
    const d = deps({ createWorkspace: vi.fn(async () => { throw boom; }) });
    await expect(ensureHomeWorkspace(d, client, "u1")).rejects.toBe(boom);
  });

  it("重查本身又失败：仍抛原来那个错（原错误优先）", async () => {
    const boom = new Error("rls");
    const find = vi.fn<HomeWorkspaceDeps["findHomeWorkspace"]>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("network"));
    const d = deps({ findHomeWorkspace: find, createWorkspace: vi.fn(async () => { throw boom; }) });
    await expect(ensureHomeWorkspace(d, client, "u1")).rejects.toBe(boom);
  });
});
