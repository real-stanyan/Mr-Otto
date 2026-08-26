import { describe, expect, it } from "vitest";
import {
  findProjectInstructions,
  INSTRUCTIONS_BYTE_BUDGET,
  type InstructionFsReader,
} from "../../src/main/projectInstructions.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

// 项目指令文件加载（issue #353；信任门禁在 #425 撤掉）：拼接不覆盖 + 字节预算 + provenance。

/** 假文件系统：{路径: 内容}，目录用 "<dir>/.git": "" 标记 */
function fakeFs(files: Record<string, string>): InstructionFsReader {
  return {
    readFile: (p) => (p in files ? files[p]! : null),
    exists: (p) => p in files,
  };
}

describe("findProjectInstructions", () => {
  it("多层目录各有指令文件：按 root → cwd 顺序拼接（不是就近覆盖），不越过 root", () => {
    const fs = fakeFs({
      "/repo/.git": "",
      "/repo/AGENTS.md": "根规则",
      "/repo/apps/web/AGENTS.md": "web 子目录规则",
      "/AGENTS.md": "root 之外的不该被捡走",
    });
    const out = findProjectInstructions("/repo/apps/web", fs);
    expect(out.segments.map((s) => s.path)).toEqual([
      "/repo/AGENTS.md", // root 在前
      "/repo/apps/web/AGENTS.md", // cwd 在后
    ]);
    expect(out.segments.map((s) => s.content)).toEqual(["根规则", "web 子目录规则"]);
    expect(out.truncated).toBe(false);
  });

  it("每层文件名优先级：.override > AGENTS.md > CLAUDE.md（一层最多一份）", () => {
    const fs = fakeFs({
      "/repo/.git": "",
      "/repo/AGENTS.override.md": "个人覆盖",
      "/repo/AGENTS.md": "共享那份",
      "/repo/CLAUDE.md": "更不该被选中",
    });
    const out = findProjectInstructions("/repo", fs);
    expect(out.segments).toEqual([{ path: "/repo/AGENTS.override.md", content: "个人覆盖" }]);

    const onlyClaude = findProjectInstructions("/repo2", fakeFs({ "/repo2/.git": "", "/repo2/CLAUDE.md": "c" }));
    expect(onlyClaude.segments[0]!.path).toBe("/repo2/CLAUDE.md");
  });

  it("字节预算：超预算的整段丢弃并标记 truncated，更近层的小文件照常进", () => {
    const fs = fakeFs({
      "/repo/.git": "",
      "/repo/AGENTS.md": "x".repeat(INSTRUCTIONS_BYTE_BUDGET + 1), // 一份就爆
      "/repo/pkg/AGENTS.md": "装得下的小份",
    });
    const out = findProjectInstructions("/repo/pkg", fs);
    expect(out.truncated).toBe(true);
    expect(out.segments).toEqual([{ path: "/repo/pkg/AGENTS.md", content: "装得下的小份" }]);
  });

  it("没有 .git：只认 workspace 自身，不向上捡陌生目录的指令", () => {
    const fs = fakeFs({
      "/somewhere/AGENTS.md": "陌生上级的",
      "/somewhere/deep/AGENTS.md": "自己的",
    });
    const out = findProjectInstructions("/somewhere/deep", fs);
    expect(out.segments.map((s) => s.path)).toEqual(["/somewhere/deep/AGENTS.md"]);
  });

  it("没有任何指令文件 / 空文件：segments 空", () => {
    expect(findProjectInstructions("/repo", fakeFs({ "/repo/.git": "" })).segments).toEqual([]);
    expect(
      findProjectInstructions("/repo", fakeFs({ "/repo/.git": "", "/repo/AGENTS.md": "  \n" })).segments
    ).toEqual([]);
  });
});

describe("project_instructions 投影（model-visible means logged）", () => {
  // ADR-0130：从"独立的 user 消息"改成"焊进围栏 system"——compact 清场
  // 会把 user 消息扫掉，而项目约定不是历史，是每轮都该在的围栏（issue #527）
  it("焊进围栏 system，带每段来源路径（provenance）；未注入时投影不变", () => {
    const base: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 1, type: "session_created", workspace: "/repo" },
      { seq: 1, sessionId: "s", ts: 2, type: "user_message", content: "干活" },
      { seq: 2, sessionId: "s", ts: 3, type: "assistant_message", content: "好", model: "m" },
    ];
    const withInstructions: SessionEvent[] = [
      base[0]!,
      {
        seq: 1, sessionId: "s", ts: 2, type: "project_instructions",
        segments: [
          { path: "/repo/AGENTS.md", content: "根规则" },
          { path: "/repo/pkg/AGENTS.md", content: "子目录规则" },
        ],
      },
      { ...base[1]!, seq: 2 },
      { ...base[2]!, seq: 3 },
    ];
    const messages = deriveMessages(withInstructions);
    const injected = messages[0]!;
    expect(injected.role).toBe("system");
    expect(injected.content).toContain("── 来自 /repo/AGENTS.md ──\n根规则");
    expect(injected.content).toContain("── 来自 /repo/pkg/AGENTS.md ──\n子目录规则");
    // 不再自成一条消息：system + user + assistant，就三条
    expect(messages).toHaveLength(3);
    // 没有该事件 = 投影与从前逐字节一致
    expect(deriveMessages(base)).toHaveLength(3);
  });
});
