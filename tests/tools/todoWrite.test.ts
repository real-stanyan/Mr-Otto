import { describe, expect, it } from "vitest";
import { todoWriteTool } from "../../src/tools/todoWrite.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

// 这工具不碰世界——传个会炸的 world 进去，证明它一次都没伸手
const forbiddenWorld = new Proxy({} as ExecutionWorld, {
  get() {
    throw new Error("todo_write 不该碰 ExecutionWorld");
  },
});

describe("todo_write", () => {
  it("不需要审批：它不改变世界，只写日志", () => {
    expect(todoWriteTool.requiresApproval).toBe(false);
  });

  it("回执报出三态计数，模型据此确认自己写对了", async () => {
    const out = await todoWriteTool.run(
      {
        items: [
          { text: "读代码", status: "in_progress" },
          { text: "写测试", status: "pending" },
          { text: "开 issue", status: "completed" },
        ],
      },
      forbiddenWorld
    );
    expect(out).toBe("清单已更新：共 3 项（进行中 1 / 待处理 1 / 已完成 1）");
  });

  it("参数非法就抛：engine 落成 status:\"error\"，清单不生效", async () => {
    await expect(todoWriteTool.run({ items: [{ text: "缺状态" }] }, forbiddenWorld)).rejects.toThrow(
      /todo_write/
    );
    await expect(todoWriteTool.run({}, forbiddenWorld)).rejects.toThrow(/todo_write/);
  });

  it("空表合法：模型可以主动收摊", async () => {
    await expect(todoWriteTool.run({ items: [] }, forbiddenWorld)).resolves.toContain("共 0 项");
  });
});
