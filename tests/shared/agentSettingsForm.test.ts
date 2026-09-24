// agentSettingsForm —— 手机智能体设置页的表单（#1356 A1，spec §5.4）。

import { describe, expect, it } from "vitest";
import {
  FACE_TOUR, agentFormErrors, agentFormOf, agentFormPatch, agentFormValid, pickableFaces,
} from "../../src/shared/agentSettingsForm.js";
import { faceCharacterAt, isFaceState } from "../../src/shared/ottoFace/index.js";
import type { WorkspaceAgentRow } from "../../src/shared/workspaces.js";

const A: WorkspaceAgentRow = {
  agentId: "a_000000000001", name: "开发", description: "写代码", instructions: "只推分支",
  models: [], tools: [], createdBy: "me", updatedTs: 0, avatarSlot: null,
};

describe("agentFormErrors", () => {
  it("名字必填，校验与桌面同一份（空 / 空白 / @ / 太长）", () => {
    const ok = agentFormOf(A);
    expect(agentFormErrors(ok)).toEqual({ name: null, description: null, instructions: null });
    expect(agentFormValid(agentFormErrors(ok))).toBe(true);
    expect(agentFormErrors({ ...ok, name: "  " }).name).toBe("名字不能为空");
    expect(agentFormErrors({ ...ok, name: "开 发" }).name).toBe("名字里不能有空白");
    expect(agentFormErrors({ ...ok, name: "@开发" }).name).toMatch(/@/);
    expect(agentFormErrors({ ...ok, name: "长".repeat(33) }).name).toMatch(/32/);
  });
  it("职责不许换行、≤200 字；还有什么要交代的 ≤4000 字", () => {
    const ok = agentFormOf(A);
    expect(agentFormErrors({ ...ok, description: "一\n二" }).description).toBe("职责不能换行");
    expect(agentFormErrors({ ...ok, description: "字".repeat(201) }).description).toBe("职责最多 200 字");
    expect(agentFormErrors({ ...ok, description: "字".repeat(200) }).description).toBeNull();
    expect(agentFormErrors({ ...ok, instructions: "字".repeat(4001) }).instructions).toBe("最多 4000 字");
    expect(agentFormValid(agentFormErrors({ ...ok, instructions: "字".repeat(4001) }))).toBe(false);
  });
});

describe("agentFormPatch", () => {
  it("什么都没改 → null（「存」按不动）；只改了空白也算没改", () => {
    expect(agentFormPatch(A, agentFormOf(A))).toBeNull();
    expect(agentFormPatch(A, { ...agentFormOf(A), name: " 开发 ", description: "写代码  " })).toBeNull();
  });
  it("只带改了的那几格", () => {
    expect(agentFormPatch(A, { ...agentFormOf(A), description: "写代码、跑门禁" })).toEqual({ description: "写代码、跑门禁" });
    expect(agentFormPatch(A, { ...agentFormOf(A), name: "工程", instructions: "" })).toEqual({ name: "工程", instructions: "" });
  });
  it("换了形象才写 avatarSlot（没换就不写，spec §5.4）", () => {
    expect(agentFormPatch(A, { ...agentFormOf(A), avatarSlot: 3 })).toEqual({ avatarSlot: 3 });
    expect(agentFormPatch({ ...A, avatarSlot: 3 }, { ...agentFormOf({ ...A, avatarSlot: 3 }) })).toBeNull();
  });
});

describe("pickableFaces", () => {
  it("十张：cap 没有自己的坑位不进这面墙；暂借格 1 / 2 / 10 一个都不出现", () => {
    const faces = pickableFaces();
    expect(faces).toHaveLength(10);
    expect(faces.map((f) => f.id)).not.toContain("cap");
    for (const f of faces) {
      expect([1, 2, 10]).not.toContain(f.slot);
      expect(faceCharacterAt(f.slot).id).toBe(f.id); // 存进去的坑位画出来就是这张脸
    }
  });
});

describe("FACE_TOUR", () => {
  it("走一遍干活的样子：排队 → 思考 → 检索 → 执行 → 作答 → 完成 → 活着", () => {
    expect(FACE_TOUR.map((s) => s.state)).toEqual(["queued", "composing", "searching", "working", "solving", "done", "alive"]);
    for (const s of FACE_TOUR) {
      expect(isFaceState(s.state)).toBe(true);
      expect(s.ms).toBeGreaterThan(0);
    }
  });
});
