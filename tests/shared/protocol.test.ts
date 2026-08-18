import { describe, it, expect } from "vitest";
import {
  adrIdFromFilename, extractAdrTitle, classifyIssueRole, parseHandoff,
  mapIssueList, mapIssueDetail, classifyGhError,
} from "../../src/shared/protocol.js";

describe("adrIdFromFilename", () => {
  it("标准 ADR 文件名取四位编号", () => {
    expect(adrIdFromFilename("0007-skill-injection.md")).toBe("0007");
  });
  it("非 ADR 命名 = null(README、无编号、非 md)", () => {
    expect(adrIdFromFilename("README.md")).toBeNull();
    expect(adrIdFromFilename("notes.md")).toBeNull();
    expect(adrIdFromFilename("0007-skill.txt")).toBeNull();
  });
});

describe("extractAdrTitle", () => {
  it("取第一个 # 标题", () => {
    expect(extractAdrTitle("---\nfoo\n---\n# ADR-0007: skill 注入\n\n正文", "fb")).toBe("ADR-0007: skill 注入");
  });
  it("无标题退回 fallback", () => {
    expect(extractAdrTitle("没有标题的文件", "0007-skill-injection")).toBe("0007-skill-injection");
  });
});

describe("classifyIssueRole", () => {
  it("handoff/交接 = memory", () => {
    expect(classifyIssueRole("Handoff: 2026-08-18 shift")).toBe("memory");
    expect(classifyIssueRole("交接:sidebar 完工")).toBe("memory");
  });
  it("protocol gap/协议缺口 = gap", () => {
    expect(classifyIssueRole("Protocol gap: 前端样式无规矩")).toBe("gap");
    expect(classifyIssueRole("协议缺口:xx")).toBe("gap");
  });
  it("其余 = task", () => {
    expect(classifyIssueRole("shadcn/ui 接入")).toBe("task");
  });
});

describe("parseHandoff", () => {
  const std = "① 完成了 A 和 B\n② 无阻塞\n③ 下一步做 C\n④ 已关闭 #7\n⑤ 无非默认决策";
  it("标准五段全解析", () => {
    expect(parseHandoff(std)).toEqual({
      done: "完成了 A 和 B", blocked: "无阻塞", next: "下一步做 C",
      closed: "已关闭 #7", rationale: "无非默认决策",
    });
  });
  it("缺段 = null(回退原文)", () => {
    expect(parseHandoff("① A\n② B\n③ C\n④ D")).toBeNull();
  });
  it("乱序 = null(不猜作者意图)", () => {
    expect(parseHandoff("② B\n① A\n③ C\n④ D\n⑤ E")).toBeNull();
  });
  it("普通评论 = null", () => {
    expect(parseHandoff("LGTM,合了")).toBeNull();
  });
});

describe("mapIssueList", () => {
  it("gh JSON 映射 + 角色判定 + state 小写化", () => {
    const json = [
      { number: 9, title: "Protocol gap: 样式无规矩", state: "CLOSED", updatedAt: "2026-08-17T12:00:00Z" },
      { number: 16, title: "新任务", state: "OPEN", updatedAt: "2026-08-18T01:00:00Z" },
    ];
    expect(mapIssueList(json)).toEqual([
      { number: 9, title: "Protocol gap: 样式无规矩", state: "closed", role: "gap", updatedAt: "2026-08-17T12:00:00Z" },
      { number: 16, title: "新任务", state: "open", role: "task", updatedAt: "2026-08-18T01:00:00Z" },
    ]);
  });
  it("非数组/字段缺失 = throw", () => {
    expect(() => mapIssueList({})).toThrow();
    expect(() => mapIssueList([{ title: "没有 number" }])).toThrow();
  });
});

describe("mapIssueDetail", () => {
  it("正文 + 评论(author.login 摊平)", () => {
    const json = {
      number: 5, title: "Handoff: shift", state: "OPEN", body: "现状与建议",
      comments: [{ author: { login: "stanyan" }, createdAt: "2026-08-17T10:00:00Z", body: "① A\n② B\n③ C\n④ D\n⑤ E" }],
    };
    expect(mapIssueDetail(json)).toEqual({
      number: 5, title: "Handoff: shift", state: "open", role: "memory", body: "现状与建议",
      comments: [{ author: "stanyan", createdAt: "2026-08-17T10:00:00Z", body: "① A\n② B\n③ C\n④ D\n⑤ E" }],
    });
  });
  it("comments 缺省 = 空数组", () => {
    expect(mapIssueDetail({ number: 1, title: "t", state: "OPEN", body: "" }).comments).toEqual([]);
  });
});

describe("classifyGhError", () => {
  it("ENOENT = gh 未安装", () => {
    expect(classifyGhError({ code: "ENOENT", message: "spawn gh ENOENT" }).kind).toBe("gh-missing");
  });
  it("非 git 仓库 / 无 remote = no-repo", () => {
    expect(classifyGhError({ stderr: "fatal: not a git repository" }).kind).toBe("no-repo");
    expect(classifyGhError({ stderr: "no git remotes found" }).kind).toBe("no-repo");
  });
  it("未登录 = gh-auth", () => {
    expect(classifyGhError({ stderr: "To get started with GitHub CLI, please run:  gh auth login" }).kind).toBe("gh-auth");
  });
  it("其余 = gh-error,detail 带 stderr", () => {
    const r = classifyGhError({ stderr: "HTTP 500" });
    expect(r.kind).toBe("gh-error");
    expect(r.detail).toContain("HTTP 500");
  });
});
