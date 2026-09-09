import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryCloudSessionMeta,
  createSupabaseCloudSessionMeta,
} from "../../services/runtime/src/cloudSessionMeta.js";

describe("createInMemoryCloudSessionMeta", () => {
  it("记下最后一次写进去的标题与参与者，给断言读", async () => {
    const meta = createInMemoryCloudSessionMeta();
    expect(meta.title).toBeNull();
    await meta.setTitle("奶茶店选址");
    await meta.setParticipants({ window: 3, uids: ["u1", "u2"] });
    expect(meta.title).toBe("奶茶店选址");
    expect(meta.participants).toEqual({ window: 3, uids: ["u1", "u2"] });
  });
});

describe("createSupabaseCloudSessionMeta", () => {
  /** 造一个只认 from().update().eq() 的假 client */
  function fakeClient(result: { error: { message: string } | null }) {
    const eq = vi.fn().mockResolvedValue(result);
    const update = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ update });
    return { client: { from } as never, from, update, eq };
  }

  it("标题写 title 那一列，按 sessionId 定位", async () => {
    const f = fakeClient({ error: null });
    await createSupabaseCloudSessionMeta(f.client, "sess-1", () => {}).setTitle("新名字");
    expect(f.from).toHaveBeenCalledWith("workspace_sessions");
    expect(f.update).toHaveBeenCalledWith({ title: "新名字" });
    expect(f.eq).toHaveBeenCalledWith("id", "sess-1");
  });

  it("参与者两列一起写", async () => {
    const f = fakeClient({ error: null });
    await createSupabaseCloudSessionMeta(f.client, "sess-1", () => {}).setParticipants({ window: 7, uids: ["a"] });
    expect(f.update).toHaveBeenCalledWith({ participants: ["a"], participants_window: 7 });
  });

  it("写失败只记一行日志不抛——这是日志的投影，权威那份已经落盘了", async () => {
    const log = vi.fn();
    const f = fakeClient({ error: { message: "column does not exist" } });
    await expect(createSupabaseCloudSessionMeta(f.client, "s", log).setTitle("x")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("column does not exist");
  });
});
