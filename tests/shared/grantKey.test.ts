// 审批记忆 key 规范化（issue #342）。验收四件事：
// 归一命中 / 复杂脚本不归一（原文精确匹配） / cwd 区分 / 多对象子集命中。

import { describe, it, expect } from "vitest";
import {
  canonicalizeCommand,
  grantKeysFor,
  callGranted,
  grantedScope,
  GRANT_KEY_SEP,
} from "../../src/shared/grantKey.js";

const bash = (cmd: string) => ({ name: "bash", args: { cmd } });
const WS = "/tmp/proj";

describe("canonicalizeCommand", () => {
  it("归一：解释器路径剥壳 + 空白折叠 + 引号 token 化,语义相同归同 key", () => {
    const a = canonicalizeCommand('/bin/bash -lc "git status"');
    const b = canonicalizeCommand("bash  -lc  'git status'");
    expect(a).toEqual(b);
    expect(a.kind).toBe("cmd");
  });

  it("引号内容不与相邻 token 混淆（JSON 编码 argv,不是空格拼接）", () => {
    const a = canonicalizeCommand('echo "a b" c');
    const b = canonicalizeCommand("echo a 'b c'");
    expect(a).not.toEqual(b);
  });

  it.each([
    "ls | wc -l", // 管道
    "a && b", // 逻辑
    "a; b", // 多语句
    "echo $(whoami)", // 命令替换
    "echo `date`", // 反引号
    "cat < in > out", // 重定向
    "rm *.log", // glob
    'echo "$HOME"', // 双引号内扩展
    "echo 'unclosed", // 引号不闭合
    "cd ~/x", // 家目录展开
  ])("复杂脚本退化原文精确匹配: %s", (cmd) => {
    const c = canonicalizeCommand(`  ${cmd}  `);
    expect(c).toEqual({ kind: "raw", raw: cmd });
  });

  it("白名单外的路径不归一 —— ./x 和 /opt/custom/x 不赌语义", () => {
    expect(canonicalizeCommand("./deploy run")).toEqual({
      kind: "cmd",
      canon: JSON.stringify(["./deploy", "run"]),
    });
    expect(canonicalizeCommand("/opt/custom/deploy run")).toEqual({
      kind: "cmd",
      canon: JSON.stringify(["/opt/custom/deploy", "run"]),
    });
  });
});

describe("grantKeysFor / callGranted", () => {
  it("归一命中：授 `git status`,`/bin/git   status` 的写法也放行", () => {
    const granted = new Set(grantKeysFor(bash("git status"), WS));
    expect(callGranted(bash("/usr/bin/git  status"), WS, granted)).toBe(true);
  });

  it("宁窄勿宽：授 `git status` 放不过 `git push --force`", () => {
    const granted = new Set(grantKeysFor(bash("git status"), WS));
    expect(callGranted(bash("git push --force"), WS, granted)).toBe(false);
  });

  it("复杂脚本原文精确匹配：一字不差才命中", () => {
    const granted = new Set(grantKeysFor(bash("ls | wc -l"), WS));
    expect(callGranted(bash("ls | wc -l"), WS, granted)).toBe(true);
    expect(callGranted(bash("ls | wc -l "), WS, granted)).toBe(true); // 首尾空白除外
    expect(callGranted(bash("ls | wc"), WS, granted)).toBe(false);
  });

  it("cwd 区分：同一命令在不同目录是不同 key", () => {
    const granted = new Set(grantKeysFor(bash("git status"), "/proj/a"));
    expect(callGranted(bash("git status"), "/proj/a", granted)).toBe(true);
    expect(callGranted(bash("git status"), "/proj/b", granted)).toBe(false);
  });

  it("write_file 按路径建 key：授 a.txt 不放行 b.txt", () => {
    const wa = { name: "write_file", args: { path: "/p/a.txt", content: "x" } };
    const wb = { name: "write_file", args: { path: "/p/b.txt", content: "x" } };
    const granted = new Set(grantKeysFor(wa, WS));
    // content 不同不影响命中 —— key 只认对象(路径)，不认这次写什么
    expect(callGranted({ ...wa, args: { path: "/p/a.txt", content: "别的" } }, WS, granted)).toBe(true);
    expect(callGranted(wb, WS, granted)).toBe(false);
  });

  it("多对象子集命中：授过 {A,B} 的 key,后续只碰 A 的调用命中", () => {
    // 今天 write_file 一次一个文件,多对象语义用两次授权拼出集合来验证:
    // grantKeysFor 返回数组 + callGranted 用 every,天然支持将来一次多对象
    const granted = new Set([
      ...grantKeysFor({ name: "write_file", args: { path: "/p/A", content: "" } }, WS),
      ...grantKeysFor({ name: "write_file", args: { path: "/p/B", content: "" } }, WS),
    ]);
    expect(callGranted({ name: "write_file", args: { path: "/p/A", content: "" } }, WS, granted)).toBe(true);
    expect(callGranted({ name: "write_file", args: { path: "/p/C", content: "" } }, WS, granted)).toBe(false);
  });

  it("畸形参数不可授权：无 cmd 的 bash / 无 path 的 write_file 永不命中、无 key 可存", () => {
    expect(grantKeysFor({ name: "bash", args: {} }, WS)).toEqual([]);
    expect(grantKeysFor({ name: "write_file", args: {} }, WS)).toEqual([]);
    expect(callGranted({ name: "bash", args: {} }, WS, new Set(["bash" + GRANT_KEY_SEP]))).toBe(false);
  });

  it("兼容策略：旧 permissions.json 的裸工具名按宽语义继续兑现", () => {
    expect(callGranted(bash("任意命令 | 管道都行"), WS, new Set(["bash"]))).toBe(true);
  });

  it("其余工具（MCP 等）：工具粒度 + cwd", () => {
    const call = { name: "mcp_github_create_issue", args: { title: "t" } };
    const granted = new Set(grantKeysFor(call, WS));
    expect(callGranted({ ...call, args: { title: "别的" } }, WS, granted)).toBe(true);
    expect(callGranted(call, "/elsewhere", granted)).toBe(false);
  });

  it("grantedScope：session 先于 always,都没有 = undefined", () => {
    const sKeys = new Set(grantKeysFor(bash("ls"), WS));
    expect(grantedScope(bash("ls"), WS, sKeys, new Set())).toBe("session");
    expect(grantedScope(bash("ls"), WS, new Set(), sKeys)).toBe("always");
    expect(grantedScope(bash("pwd"), WS, sKeys, sKeys)).toBeUndefined();
  });
});
