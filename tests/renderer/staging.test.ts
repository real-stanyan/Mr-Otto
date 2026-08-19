import { describe, expect, it } from "vitest";
import { MAX_IMAGES, mergeStaged, type StagedOk } from "../../src/renderer/src/lib/staging.js";
import type { StagedAttachment } from "../../src/shared/shellBridge.js";

const img = (id: string): StagedAttachment => ({
  kind: "image",
  ref: { id, mediaType: "image/png", bytes: 10 },
  previewDataUrl: "data:image/png;base64,x",
});
const txt = (name: string): StagedAttachment => ({ kind: "text", name, content: "hi", bytes: 2 });

describe("mergeStaged", () => {
  it("并进已暂存的,顺序是先来后到", () => {
    const r = mergeStaged([img("a") as StagedOk], [txt("b.md")]);
    expect(r.error).toBeNull();
    expect(r.staged.map((a) => a.kind)).toEqual(["image", "text"]);
  });

  it("被拒的不进暂存区,但要出声", () => {
    const r = mergeStaged([], [img("a"), { kind: "rejected", name: "x.zip", reason: "二进制文件" }]);
    expect(r.staged).toHaveLength(1);
    expect(r.error).toContain("x.zip");
    expect(r.error).toContain("二进制文件");
  });

  it("超过图片限额裁掉多的,保留先来的,并告知裁了几张", () => {
    const current = ["a", "b", "c", "d"].map((i) => img(i) as StagedOk);
    const r = mergeStaged(current, [img("e"), img("f")]);
    expect(r.staged).toHaveLength(MAX_IMAGES);
    expect(r.staged.map((a) => (a.kind === "image" ? a.ref.id : ""))).toEqual(["a", "b", "c", "d"]);
    expect(r.error).toContain("2 张已忽略");
  });

  it("限额只管图片,文本不受牵连", () => {
    const current = ["a", "b", "c", "d"].map((i) => img(i) as StagedOk);
    const r = mergeStaged(current, [img("e"), txt("note.md")]);
    expect(r.staged.filter((a) => a.kind === "text")).toHaveLength(1);
  });

  it("空输入 = 原样返回,不造错误", () => {
    const current = [img("a") as StagedOk];
    expect(mergeStaged(current, [])).toEqual({ staged: current, error: null });
  });
});
