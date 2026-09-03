import { describe, expect, it } from "vitest";
import { createMemorySync } from "../../src/main/memorySync.js";
import type { MemoryDocRow } from "../../src/main/memoryDocsApi.js";

function fakeFiles() {
  const disk = new Map<string, { content: string; mtimeMs: number }>();
  let clock = 1000;
  return {
    disk,
    files: {
      walk: async () => [...disk].map(([rel, d]) => ({ rel, ...d })),
      read: async (rel: string) => disk.get(rel)?.content ?? "",
      write: async (rel: string, content: string) => { disk.set(rel, { content, mtimeMs: ++clock }); },
      remove: async (rel: string) => { disk.delete(rel); },
    },
    tick: () => ++clock,
  };
}
function fakeApi(rows: MemoryDocRow[] = []) {
  const calls: string[] = [];
  let fail = false;
  return {
    calls,
    setFail: (v: boolean) => { fail = v; },
    api: {
      listAll: async () => { if (fail) throw new Error("net"); return rows; },
      upsert: async (_u: string, key: string, content: string) => { if (fail) throw new Error("net"); calls.push(`up ${key}=${content}`); },
      remove: async (_u: string, key: string) => { if (fail) throw new Error("net"); calls.push(`rm ${key}`); },
    },
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("memorySync（#852）", () => {
  it("touched → 防抖后 upsert；空/不存在 → remove", async () => {
    const f = fakeFiles();
    const a = fakeApi();
    const s = createMemorySync({ files: f.files, api: a.api, uid: () => "u1", debounceMs: 1 });
    await f.files.write("memories/USER.md", "hi");
    s.touched("memories/USER.md");
    s.touched("memories/topics/x.md"); // 不存在
    await sleep(10);
    expect(a.calls.sort()).toEqual(["rm memories/topics/x.md", "up memories/USER.md=hi"]);
    expect(s.state().kind).toBe("idle");
    s.dispose();
  });
  it("没登录：pending 留着、不打网络、状态 off；登录后 flush 推出去", async () => {
    const f = fakeFiles();
    const a = fakeApi();
    let uid: string | null = null;
    const s = createMemorySync({ files: f.files, api: a.api, uid: () => uid, debounceMs: 1 });
    await f.files.write("memories/USER.md", "hi");
    s.touched("memories/USER.md");
    await sleep(10);
    expect(a.calls).toEqual([]);
    expect(s.state().kind).toBe("off");
    uid = "u1";
    await s.flushNow();
    expect(a.calls).toEqual(["up memories/USER.md=hi"]);
    s.dispose();
  });
  it("网络失败：状态 error、pending 保留、retry 后成功", async () => {
    const f = fakeFiles();
    const a = fakeApi();
    a.setFail(true);
    const s = createMemorySync({ files: f.files, api: a.api, uid: () => "u1", debounceMs: 1, retryMs: 5 });
    await f.files.write("memories/USER.md", "hi");
    s.touched("memories/USER.md");
    await sleep(3);
    expect(s.state().kind).toBe("error");
    a.setFail(false);
    await sleep(15);
    expect(a.calls).toEqual(["up memories/USER.md=hi"]);
    expect(s.state().kind).toBe("idle");
    s.dispose();
  });
  it("pullNow：云端新的写本地且不回推；本地新的推上去；相同不动", async () => {
    const f = fakeFiles();
    await f.files.write("memories/MEMORY.md", "local-old");   // mtime 1001
    await f.files.write("memories/USER.md", "local-new");     // mtime 1002
    await f.files.write("memories/topics/same.md", "same");   // mtime 1003
    const a = fakeApi([
      { key: "memories/MEMORY.md", content: "cloud-new", updated_at: new Date(5000).toISOString() },
      { key: "memories/USER.md", content: "cloud-old", updated_at: new Date(1).toISOString() },
      { key: "memories/topics/same.md", content: "same", updated_at: new Date(9999).toISOString() },
      { key: "memories/topics/only-cloud.md", content: "oc", updated_at: new Date(1).toISOString() },
    ]);
    const s = createMemorySync({ files: f.files, api: a.api, uid: () => "u1", debounceMs: 1 });
    expect(await s.pullNow()).toBe("synced");
    expect(f.disk.get("memories/MEMORY.md")?.content).toBe("cloud-new");
    expect(f.disk.get("memories/topics/only-cloud.md")?.content).toBe("oc");
    expect(a.calls).toEqual(["up memories/USER.md=local-new"]);
    await sleep(10); // 从云端写本地那两次不得触发上传
    expect(a.calls).toEqual(["up memories/USER.md=local-new"]);
    s.dispose();
  });
  it("pullNow 没登录 → skipped；失败 → failed 不抛", async () => {
    const f = fakeFiles();
    const a = fakeApi();
    const s1 = createMemorySync({ files: f.files, api: a.api, uid: () => null });
    expect(await s1.pullNow()).toBe("skipped");
    a.setFail(true);
    const s2 = createMemorySync({ files: f.files, api: a.api, uid: () => "u1" });
    expect(await s2.pullNow()).toBe("failed");
    expect(s2.state().kind).toBe("error");
    s1.dispose(); s2.dispose();
  });
});
