// 三把 Git 刀那几段脚本与它们的解析（#1105）。判据是**脚本的字节**与**输出的
// 解析**，不是「调了哪个函数」——同 `workFilesScript.test.ts` 的纪律。

import { describe, it, expect } from "vitest";
import {
  buildCloneProbeScript, buildDefaultBranchScript, buildPushScript,
  parseCloneProbe, parseDefaultBranch, parsePushOutput,
} from "../../services/runtime/src/gitScripts.js";

/** #1056 踩过的那条：普通模板串里的 `\0` 是一个**真的 NUL 字节**，而 execve
    的参数在 NUL 处截断——两处都不报错，单测因为不看脚本字节而全绿 */
const scripts = () => [
  buildCloneProbeScript("code/x"),
  buildDefaultBranchScript("code/x"),
  buildPushScript({ dest: "code/x", branch: "b", message: "m", authorName: "n", authorEmail: "e@x" }),
];

describe("脚本的字节", () => {
  it("除换行外不许有裸控制字符", () => {
    const ctrl = new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f]");
    for (const s of scripts()) expect(ctrl.test(s)).toBe(false);
  });

  it("单引号被正确转义 —— 目录名里带引号不该把脚本劈开", () => {
    expect(buildCloneProbeScript("a'b")).toContain(`'a'\\''b'`);
  });

  it("push 脚本里**没有 force**（--force / --force-with-lease 都不许出现）", () => {
    const s = buildPushScript({ dest: "d", branch: "b", message: "m", authorName: "n", authorEmail: "e" });
    expect(s).not.toContain("--force");
  });

  it("author 经 -c 传给这一次 commit，不写进容器的全局配置", () => {
    const s = buildPushScript({ dest: "d", branch: "b", message: "m", authorName: "小红", authorEmail: "u1@x" });
    expect(s).toContain(`-c user.name="$an"`);
    expect(s).toContain(`-c user.email="$ae"`);
    expect(s).not.toContain("git config --global user.name");
  });

  it("三段脚本都有 realpath 兜底 —— 一条指向 /etc 的软链过得了客户端那道路径闸", () => {
    for (const s of scripts()) {
      expect(s).toContain("realpath -m --");
      expect(s).toContain("/work");
    }
  });
});

describe("parseCloneProbe", () => {
  it("空目录", () => {
    expect(parseCloneProbe("entries=0\norigin=\n")).toEqual({ kind: "ok", entries: 0, origin: "" });
  });

  it("有内容且有 origin", () => {
    expect(parseCloneProbe("entries=12\norigin=https://github.com/a/b.git\n"))
      .toEqual({ kind: "ok", entries: 12, origin: "https://github.com/a/b.git" });
  });

  it("denied / notdir 各自单列", () => {
    expect(parseCloneProbe("denied")).toEqual({ kind: "denied" });
    expect(parseCloneProbe("notdir")).toEqual({ kind: "notdir" });
  });

  it("**认不出来单列一档，不退化成空目录** —— 后者会往一个没看懂的地方 clone", () => {
    const r = parseCloneProbe("bash: git: command not found");
    expect(r.kind).toBe("unparsable");
    expect(r.kind === "unparsable" && r.detail).toContain("command not found");
  });
});

describe("parseDefaultBranch", () => {
  it("认得出 ls-remote --symref 的第一行", () => {
    expect(parseDefaultBranch("ref: refs/heads/main\tHEAD\nabc123\tHEAD\n")).toBe("main");
    expect(parseDefaultBranch("ref: refs/heads/develop/v2\tHEAD\n")).toBe("develop/v2");
  });

  it("**认不出来回 null** —— 上层会把 null 当成「是默认分支」= 拒绝", () => {
    expect(parseDefaultBranch("")).toBeNull();
    expect(parseDefaultBranch("fatal: could not read Username")).toBeNull();
  });
});

describe("parsePushOutput", () => {
  it("`pushed` 那一行是唯一的成功凭据 —— **不看退出码**（最后一条是 echo）", () => {
    expect(parsePushOutput("committed\npushed\n")).toMatchObject({ pushed: true, committed: true });
    expect(parsePushOutput("nothing-to-commit\npushed\n")).toMatchObject({ pushed: true, committed: false });
  });

  it("push 失败时 pushed=false，原文带回去", () => {
    const r = parsePushOutput("committed\n ! [rejected] b -> b (non-fast-forward)\n");
    expect(r.pushed).toBe(false);
    expect(r.detail).toContain("non-fast-forward");
  });
});
