import { describe, expect, it } from "vitest";
import { buildApprovalPreview } from "../../src/main/approvalPreview.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

function worldWith(files: Record<string, string>): ExecutionWorld {
  return {
    fs: {
      async read(path) {
        const content = files[path];
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      async write() {},
    },
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

describe("buildApprovalPreview", () => {
  it("write_file 覆盖已有文件 → 旧内容随预览出场", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "write_file", args: { path: "a.txt", content: "新" } },
      worldWith({ "a.txt": "旧" })
    );
    expect(preview).toEqual({ path: "a.txt", oldText: "旧", newText: "新" });
  });

  it("目标不存在 → oldText 为 null（新文件），预览失败不挡审批", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "write_file", args: { path: "new.txt", content: "内容" } },
      worldWith({})
    );
    expect(preview).toEqual({ path: "new.txt", oldText: null, newText: "内容" });
  });

  it("非 write_file（bash 等）→ 无预览，审批卡走 JSON 兜底", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "bash", args: { cmd: "rm -rf /" } },
      worldWith({})
    );
    expect(preview).toBeUndefined();
  });

  it("参数出自模型，形状不对不赌：缺 path/content 就不预览", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "write_file", args: { path: 42 } },
      worldWith({})
    );
    expect(preview).toBeUndefined();
  });

  it("超大内容 → 放弃预览（IPC 别扛巨物）", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "write_file", args: { path: "big.txt", content: "x".repeat(300_000) } },
      worldWith({})
    );
    expect(preview).toBeUndefined();
  });
});
