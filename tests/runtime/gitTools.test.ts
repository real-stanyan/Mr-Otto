// 三把 Git 刀的行为（#1105）。这一份钉的是**闸**——每条用例背后都是一个真会
// 弄坏东西的动作，而它们全都发生在 runtime 上，没有第二次机会。

import { describe, it, expect } from "vitest";
import { createGitTools, type GitToolDeps } from "../../services/runtime/src/gitTools.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const WORLD = {} as ExecutionWorld;
const REPO = "https://github.com/acme/widgets.git";

interface Recorded {
  workspaceScripts: string[];
  sidecar: { cfg: { repoUrl: string; pat?: string }; script: string }[];
  clones: { cfg: { repoUrl: string; pat?: string }; dest: string }[];
  github: { path: string; token: string; body?: unknown }[];
}

function harness(over: Partial<GitToolDeps> & {
  probe?: string;
  head?: string;
  push?: string;
  token?: string | null;
} = {}) {
  const rec: Recorded = { workspaceScripts: [], sidecar: [], clones: [], github: [] };
  const deps: GitToolDeps = {
    workspaceId: "w1",
    tokenFor: (h) => (h === "github.com" ? (over.token === undefined ? "ghp_secret" : over.token) : null),
    execInWorkspace: async (script) => {
      rec.workspaceScripts.push(script);
      return { stdout: over.probe ?? "entries=0\norigin=\n", stderr: "", exitCode: 0 };
    },
    execInSidecar: async (cfg, script) => {
      rec.sidecar.push({ cfg, script });
      const isHead = script.includes("ls-remote");
      return {
        stdout: isHead ? (over.head ?? "ref: refs/heads/main\tHEAD\n") : (over.push ?? "committed\npushed\n"),
        stderr: "",
        exitCode: 0,
      };
    },
    clone: async (cfg, dest) => {
      rec.clones.push({ cfg, dest });
      return { ok: true };
    },
    sanitize: (t) => t.replaceAll("ghp_secret", "***"),
    initiator: async () => ({ uid: "u-1", label: "小红" }),
    githubApi: async (path, init) => {
      rec.github.push({ path, token: init.token, ...(init.body === undefined ? {} : { body: init.body }) });
      return { status: 201, json: { clone_url: "https://github.com/me/x.git", owner: { login: "me" } } };
    },
    ...over,
  };
  const [clone, push, create] = createGitTools(deps);
  return { rec, clone: clone!, push: push!, create: create! };
}

describe("三把刀共同的形状", () => {
  it("**三把全部 requiresApproval** —— 「工作区开着免审也管不到它们」的落地方式", () => {
    const { clone, push, create } = harness();
    for (const t of [clone, push, create]) expect(t.requiresApproval).toBe(true);
  });
});

describe("clone_repo", () => {
  it("空目录 → clone，凭据按 host 取到并只交给旁路容器那条路", async () => {
    const { rec, clone } = harness();
    const out = await clone.run({ repo_url: REPO, dest: "code/widgets" }, WORLD);
    expect(out).toContain("code/widgets");
    expect(rec.clones).toEqual([{ cfg: { repoUrl: REPO, pat: "ghp_secret" }, dest: "code/widgets" }]);
    // 探目录那一步跑在工作区容器上，**不带凭据**
    expect(rec.workspaceScripts.join("\n")).not.toContain("ghp_secret");
  });

  it("已经是同一个仓库 → 回「已经在了」并**不再 clone**", async () => {
    const { rec, clone } = harness({ probe: `entries=9\norigin=${REPO}\n` });
    const out = await clone.run({ repo_url: REPO, dest: "code/widgets" }, WORLD);
    expect(out).toContain("已经是这个仓库");
    expect(rec.clones).toEqual([]);
  });

  it("目标非空且不是同一个仓库 → 拒绝，**一个文件都没动**", async () => {
    const { rec, clone } = harness({ probe: "entries=3\norigin=\n" });
    await expect(clone.run({ repo_url: REPO, dest: "code/widgets" }, WORLD)).rejects.toThrow(/已经有东西/);
    expect(rec.clones).toEqual([]);
  });

  it("探不清那里是什么 → 停手，**不当成空目录往里 clone**", async () => {
    const { rec, clone } = harness({ probe: "bash: git: command not found" });
    await expect(clone.run({ repo_url: REPO, dest: "x" }, WORLD)).rejects.toThrow(/探不清/);
    expect(rec.clones).toEqual([]);
  });

  it("dest 越界 / 是根目录 → 参数就拒，一次容器都不碰", async () => {
    const { rec, clone } = harness();
    await expect(clone.run({ repo_url: REPO, dest: "../etc" }, WORLD)).rejects.toThrow();
    await expect(clone.run({ repo_url: REPO, dest: "" }, WORLD)).rejects.toThrow();
    expect(rec.workspaceScripts).toEqual([]);
  });

  it("非 https 地址过不了 validateRepoUrl", async () => {
    const { clone } = harness();
    await expect(clone.run({ repo_url: "git@github.com:a/b.git", dest: "x" }, WORLD)).rejects.toThrow();
  });

  it("没存过这台主机的 token → 照跑（公开仓库不需要），只是不带 pat", async () => {
    const { rec, clone } = harness({ token: null });
    await clone.run({ repo_url: REPO, dest: "x" }, WORLD);
    expect(rec.clones[0]!.cfg.pat).toBeUndefined();
  });

  it("clone_repo：dest 落在 wiki/ 下一律拒（#1140）——wiki 目录是团队记忆，clone 进去索引器会对着 .git 发呆", async () => {
    const { clone, rec } = harness();
    await expect(clone.run({ repo_url: REPO, dest: "wiki" }, WORLD)).rejects.toThrow("wiki/");
    await expect(clone.run({ repo_url: REPO, dest: "wiki/sub" }, WORLD)).rejects.toThrow("wiki/");
    expect(rec.workspaceScripts).toEqual([]); // 一条 exec 都没起
    expect(rec.clones).toEqual([]);
  });
});

describe("git_push", () => {
  const ok = { dest: "code/widgets", branch: "otto/fix", message: "修好了" };

  it("正常路径：提交并推，署名是**点火的那个人**", async () => {
    const { rec, push } = harness({ probe: `entries=9\norigin=${REPO}\n` });
    const out = await push.run(ok, WORLD);
    expect(out).toContain("otto/fix");
    const pushScript = rec.sidecar.find((c) => c.script.includes("git push"))!.script;
    expect(pushScript).toContain("小红");
    expect(pushScript).toContain("u-1@users.noreply.mrotto.app");
  });

  it("**推默认分支一律拒**", async () => {
    const { rec, push } = harness({ probe: `entries=9\norigin=${REPO}\n` });
    await expect(push.run({ ...ok, branch: "main" }, WORLD)).rejects.toThrow(/默认分支 main/);
    expect(rec.sidecar.some((c) => c.script.includes("git push"))).toBe(false);
  });

  it("**查不到默认分支也拒** —— 查不到的那一刻正是网络出问题的时候", async () => {
    const { rec, push } = harness({ probe: `entries=9\norigin=${REPO}\n`, head: "fatal: could not read Username" });
    await expect(push.run(ok, WORLD)).rejects.toThrow(/查不到.*默认分支/);
    expect(rec.sidecar.some((c) => c.script.includes("git push"))).toBe(false);
  });

  it("查不到发起人 → 拒绝，**不伪造署名**", async () => {
    const { push } = harness({ probe: `entries=9\norigin=${REPO}\n`, initiator: async () => null });
    await expect(push.run(ok, WORLD)).rejects.toThrow(/谁发起的/);
  });

  it("那个目录不是连着远端的工作副本 → 说清楚，不去 push", async () => {
    const { rec, push } = harness({ probe: "entries=3\norigin=\n" });
    await expect(push.run(ok, WORLD)).rejects.toThrow(/不是一个连着远端/);
    expect(rec.sidecar).toEqual([]);
  });

  /** #1206：clone 没 token 照跑（公开仓不需要），push **永远**要凭据——公开仓也一样。
      没存 token 时以前是带着空凭据进旁路容器让 git 撞 `could not read Username`，
      模型读到那句只会说「沙箱不允许推」。现在在起容器之前就说清去哪儿加，
      措辞与 create_repo 逐字同一条路径 */
  it("没存这台主机的 token → 一台容器都不起，明说去「团队设置 → 连接器 → 代码仓库」加", async () => {
    const { rec, push } = harness({ token: null, probe: `entries=9\norigin=${REPO}\n` });
    await expect(push.run(ok, WORLD)).rejects.toThrow(/团队设置 → 连接器 → 代码仓库/);
    expect(rec.sidecar).toEqual([]);
  });

  it("push 被远端拒（non-fast-forward）→ 原文带回去，且**擦掉凭据**", async () => {
    const { push } = harness({
      probe: `entries=9\norigin=${REPO}\n`,
      push: "committed\n ! [rejected] (non-fast-forward) ghp_secret\n",
    });
    // `.rejects.not.toThrow` 是空转（它只断言「没抛」，而这里必然抛）——
    // 真要看的是**抛出来那句话的内容**
    const err = await push.run(ok, WORLD).then(() => null, (e: unknown) => e);
    expect(String(err)).toContain("non-fast-forward");
    expect(String(err)).not.toContain("ghp_secret");
    expect(String(err)).toContain("***");
  });

  it("没有新改动但分支还不存在 → **照推**，说清楚没提交", async () => {
    const { push } = harness({ probe: `entries=9\norigin=${REPO}\n`, push: "nothing-to-commit\npushed\n" });
    const out = await push.run(ok, WORLD);
    expect(out).toContain("没有新的改动");
    expect(out).toContain("otto/fix");
  });
});

describe("create_repo", () => {
  it("建成功 → 回地址，并**说清楚建在谁名下**", async () => {
    const { rec, create } = harness();
    const out = await create.run({ name: "widgets" }, WORLD);
    expect(out).toContain("@me");
    expect(out).toContain("https://github.com/me/x.git");
    expect(rec.github[0]).toMatchObject({ path: "/user/repos", token: "ghp_secret" });
    expect(rec.github[0]!.body).toMatchObject({ name: "widgets", private: true });
  });

  it("没存 github.com 的 token → 明说去哪儿加，**不写「你没订阅」这种不相干的话**", async () => {
    const { rec, create } = harness({ token: null });
    await expect(create.run({ name: "x" }, WORLD)).rejects.toThrow(/连接器 → 代码仓库/);
    expect(rec.github).toEqual([]);
  });

  it("401 / scope 不够 / 同名 各翻各的；认不出的原样带回（同 humanizeMcpError 的规矩）", async () => {
    const cases: [number, string, RegExp][] = [
      [401, "Bad credentials", /令牌无效/],
      [403, "missing scope 'repo'", /权限不够/],
      [422, "name already exists on this account", /同名仓库/],
      [500, "Server Error", /Server Error/],
    ];
    for (const [status, message, expected] of cases) {
      const { create } = harness({ githubApi: async () => ({ status, json: { message } }) });
      await expect(create.run({ name: "x" }, WORLD)).rejects.toThrow(expected);
    }
  });

  it("**不顺手 clone** —— 建完只回地址", async () => {
    const { rec, create } = harness();
    await create.run({ name: "widgets" }, WORLD);
    expect(rec.clones).toEqual([]);
  });
});
