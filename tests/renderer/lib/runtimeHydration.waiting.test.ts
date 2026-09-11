import { describe, expect, it } from "vitest";
import { runtimePatch } from "../../../src/renderer/src/lib/runtimeHydration.js";

const empty = { statusBySession: {}, compactingBySession: {}, approvals: {}, asks: {}, waitingBySession: {} };

describe("runtimePatch 的 waitingFor\uFF08#1223\uFF09", () => {
  it("快照带 waitingFor 且 store 没记录 → 补\uFF1B已有记录不覆盖\uFF1Bnull / 缺席不补", () => {
    expect(runtimePatch(empty, "s", { status: "idle", compacting: false, approval: null, ask: null, waitingFor: "cloud" })).toMatchObject({ waitingBySession: { s: "cloud" } });
    expect(runtimePatch({ ...empty, waitingBySession: { s: "desktop" } }, "s", { status: "idle", compacting: false, approval: null, ask: null, waitingFor: "cloud" }).waitingBySession).toBeUndefined();
    expect(runtimePatch(empty, "s", { status: "idle", compacting: false, approval: null, ask: null, waitingFor: null }).waitingBySession).toBeUndefined();
    expect(runtimePatch(empty, "s", { status: "idle", compacting: false, approval: null, ask: null }).waitingBySession).toBeUndefined();
  });
});
