import { describe, it, expect } from "vitest";
import { createInMemoryWorkspaceMemory } from "../../services/runtime/src/workspaceMemory.js";

describe("createInMemoryWorkspaceMemory", () => {
  it("read 只回有行的键，缺行不出现；write 后可读；dump 平铺", async () => {
    const m = createInMemoryWorkspaceMemory({ "w1/": "共享" });
    const r = await m.read("w1", ["", "ops"]);
    expect([...r.entries()]).toEqual([["", "共享"]]);
    await m.write("w1", "ops", "私有");
    expect((await m.read("w1", ["ops"])).get("ops")).toBe("私有");
    expect((await m.read("w2", ["ops"])).size).toBe(0);
    expect(m.dump()).toEqual({ "w1/": "共享", "w1/ops": "私有" });
  });
});
