// Git 凭据存储（#1103）。真起临时文件跑，不打桩 fs：这一层几乎全部的行为都是
// 「文件里到底躺着什么」，桩掉它等于只测了我自己写的那份记忆。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitCredentialStore } from "../../services/runtime/src/gitCredentialStore.js";

let dir: string;
let path: string;
const store = () => createGitCredentialStore(path);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otto-creds-"));
  path = join(dir, "git-credentials.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createGitCredentialStore", () => {
  it("存了就查得到；hosts() 里没有 token —— 它从不下行", () => {
    const s = store();
    s.put("w1", "github.com", "ghp_secret", "owner-uid");

    expect(s.token("w1", "github.com")).toBe("ghp_secret");
    const listed = s.hosts("w1");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ host: "github.com", addedBy: "owner-uid" });
    expect(JSON.stringify(listed)).not.toContain("ghp_secret");
  });

  it("hosts() 按 host 排序 —— 界面上那张表不该因为存的顺序跳来跳去", () => {
    const s = store();
    s.put("w1", "gitlab.com", "t2", "u");
    s.put("w1", "github.com", "t1", "u");
    expect(s.hosts("w1").map((h) => h.host)).toEqual(["github.com", "gitlab.com"]);
  });

  it("同一台主机再存 = 换新，不是新增一条", () => {
    const s = store();
    s.put("w1", "github.com", "old", "u");
    s.put("w1", "github.com", "new", "u2");
    expect(s.hosts("w1")).toHaveLength(1);
    expect(s.token("w1", "github.com")).toBe("new");
    expect(s.hosts("w1")[0]!.addedBy).toBe("u2");
  });

  it("工作区之间不串 —— 一把 token 只属于存它的那个工作区", () => {
    const s = store();
    s.put("w1", "github.com", "t1", "u");
    s.put("w2", "github.com", "t2", "u");
    expect(s.token("w1", "github.com")).toBe("t1");
    expect(s.token("w2", "github.com")).toBe("t2");
  });

  it("remove 删掉那台；删不存在的不是错误", () => {
    const s = store();
    s.put("w1", "github.com", "t", "u");
    s.remove("w1", "github.com");
    expect(s.hosts("w1")).toEqual([]);
    expect(s.token("w1", "github.com")).toBeNull();
    expect(() => s.remove("w1", "nope.com")).not.toThrow();
  });

  it("最后一台被删掉时整条工作区记录也清掉 —— 别留一个空壳长期占着", () => {
    const s = store();
    s.put("w1", "github.com", "t", "u");
    s.remove("w1", "github.com");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  it("purge 清掉这个工作区的全部 —— 工作区没了，它那几把 token 也得跟着没", () => {
    const s = store();
    s.put("w1", "github.com", "t1", "u");
    s.put("w1", "gitlab.com", "t2", "u");
    s.put("w2", "github.com", "keep", "u");

    s.purge("w1");

    expect(s.hosts("w1")).toEqual([]);
    expect(s.token("w2", "github.com")).toBe("keep"); // 别的工作区不受影响
    expect(readFileSync(path, "utf8")).not.toContain("t1");
  });

  it("落盘是 0600，且**已有文件也会被再 chmod 一刀** —— mode 只在新建时生效", () => {
    const s = store();
    s.put("w1", "github.com", "t", "u");
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // 有人把权限放开了（或者上一版留下的文件是 0644）：下一次写要收回来
    chmodSync(path, 0o644);
    s.put("w1", "gitlab.com", "t2", "u");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("文件坏了 → 当空的重来，不抛 —— 拿一份半懂的记录去 clone 比重配一次糟得多", () => {
    writeFileSync(path, "{ 这不是 json");
    const s = store();
    expect(s.hosts("w1")).toEqual([]);
    expect(s.token("w1", "github.com")).toBeNull();
    expect(() => s.put("w1", "github.com", "t", "u")).not.toThrow();
    expect(s.token("w1", "github.com")).toBe("t");
  });

  it("文件是数组之类的合法 JSON 但形状不对 → 同样当空的", () => {
    writeFileSync(path, "[1,2,3]");
    expect(store().hosts("w1")).toEqual([]);
  });

  it("没有文件时读不炸，且不会凭空建出一个来", () => {
    const s = store();
    expect(s.hosts("w1")).toEqual([]);
    expect(() => statSync(path)).toThrow();
  });
});
