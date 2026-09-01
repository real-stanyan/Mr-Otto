import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { createSandbox, type DockerLike } from "../../services/runtime/src/sandbox.js";

interface FakeContainer {
  id: string;
  name: string;
  state: string; // "running" | "exited" | ...
  labels: Record<string, string>;
}

function makeFakeDocker(initial: FakeContainer[] = []) {
  const containers = new Map<string, FakeContainer>(initial.map((c) => [c.id, c]));
  const volumes = new Set<string>(initial.map((c) => c.name));
  const calls: string[] = [];
  let nextId = 1;

  function listContainers(opts: { all: boolean; filters: string }) {
    calls.push(`listContainers:${opts.filters}`);
    const filters = JSON.parse(opts.filters) as { name?: string[]; label?: string[] };
    let list = [...containers.values()];
    if (filters.name) {
      const names = filters.name;
      list = list.filter((c) => names.includes(c.name));
    }
    if (filters.label) {
      const labelKeys = filters.label.map((l) => l.split("=")[0]);
      list = list.filter((c) => labelKeys.every((k) => k !== undefined && k in c.labels));
    }
    return Promise.resolve(
      list.map((c) => ({ Id: c.id, Names: [`/${c.name}`], State: c.state, Labels: c.labels })),
    );
  }

  function getContainer(id: string) {
    return {
      start: async () => {
        calls.push(`start:${id}`);
        const c = containers.get(id);
        if (c) c.state = "running";
      },
      stop: async () => {
        calls.push(`stop:${id}`);
        const c = containers.get(id);
        if (c) c.state = "exited";
      },
      remove: async (opts: { force: boolean }) => {
        calls.push(`remove:${id}:${opts.force}`);
        containers.delete(id);
      },
      update: async (_opts: Record<string, unknown>) => {},
      exec: async () => {
        throw new Error("not used in sandbox tests");
      },
      modem: { demuxStream: () => {} },
    };
  }

  async function createContainer(opts: Record<string, unknown>) {
    calls.push(`createContainer:${JSON.stringify(opts)}`);
    const id = `c${nextId++}`;
    const name = String(opts["name"]);
    const labels = (opts["Labels"] ?? {}) as Record<string, string>;
    containers.set(id, { id, name, state: "created", labels });
    volumes.add(name);
    return { id };
  }

  function listVolumes(opts: { filters: string }) {
    calls.push(`listVolumes:${opts.filters}`);
    return Promise.resolve({ Volumes: [...volumes].map((name) => ({ Name: name, Labels: null })) });
  }

  function getVolume(name: string) {
    return {
      remove: async () => {
        calls.push(`volumeRemove:${name}`);
        if (!volumes.has(name)) throw new Error("no such volume");
        volumes.delete(name);
      },
    };
  }

  const docker: DockerLike = { listContainers, getContainer, createContainer, listVolumes, getVolume };
  return { docker, calls, containers, volumes };
}

// ── git clone（issue #821 slice 1）専用の假 exec ──────────────────────────
// 既有 makeFakeDocker 的 getContainer(id).exec 一律 throw（"not used in
// sandbox tests"）——不动它，克隆相关测试改用这层 wrapper 单独接管 exec/modem，
// 其余 listContainers/createContainer/listVolumes/getVolume 原样透传。

interface ExecOutcome {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}
type ExecRouter = (cmd: string[]) => ExecOutcome;

/** 按 exec 拿到的 Cmd（`["/bin/bash","-lc",<script>]`）文本路由到预设结局，
    并把 attachStdin 场景下写入的内容整段记下——克隆测试要断言"PAT 经 stdin
    传入、Cmd 数组里不含 PAT"，全靠这份 execLog。modem.demuxStream 是容器
    共用的一个函数，没法从参数直接知道"这次 exec 是哪一条"，靠 stream 自带
    的 __outcome 标记把预设 stdout/stderr 喂给对应 sink。 */
function withCloneExec(
  docker: DockerLike,
  router: ExecRouter,
  execLog: Array<{ cmd: string[]; stdin?: string }>,
): DockerLike {
  return {
    ...docker,
    getContainer(id: string) {
      const base = docker.getContainer(id);
      return {
        ...base,
        async exec(execOpts: { Cmd: string[]; AttachStdout: boolean; AttachStderr: boolean; AttachStdin?: boolean }) {
          const outcome = router(execOpts.Cmd);
          let stdin: string | undefined;
          const stream = new EventEmitter() as unknown as NodeJS.ReadWriteStream & { __outcome?: ExecOutcome };
          stream.__outcome = outcome;
          (stream as unknown as { write: (d: string) => boolean }).write = (d: string) => {
            stdin = (stdin ?? "") + d;
            return true;
          };
          (stream as unknown as { end: () => void }).end = () => {
            setImmediate(() => stream.emit("end"));
          };
          return {
            async start(startOpts?: { hijack?: boolean; stdin?: boolean }) {
              if (!startOpts?.stdin) setImmediate(() => stream.emit("end"));
              return stream;
            },
            async inspect() {
              execLog.push({ cmd: execOpts.Cmd, ...(stdin !== undefined ? { stdin } : {}) });
              return { ExitCode: outcome.exitCode };
            },
          };
        },
        modem: {
          demuxStream(stream: NodeJS.ReadableStream, out: NodeJS.WritableStream, err: NodeJS.WritableStream) {
            const s = stream as NodeJS.ReadableStream & { __outcome?: ExecOutcome };
            if (s.__outcome?.stdout) out.write(s.__outcome.stdout);
            if (s.__outcome?.stderr) err.write(s.__outcome.stderr);
          },
        },
      };
    },
  };
}

/** 五个命令按 Cmd 里的脚本文本互斥匹配（幂等检查/凭据配置/凭据写入/clone/
    凭据回收），每个都可以单独配置退出码——覆盖脚本走 overrides，不写就是
    "一路成功、且尚未 clone 过" 的默认状态 */
function cloneRouter(
  overrides: {
    gitDirExists?: boolean;
    credHelperExit?: number;
    approveExit?: number;
    cloneExit?: number;
    cloneStderr?: string;
    rejectExit?: number;
  } = {},
): ExecRouter {
  return (cmd) => {
    const script = cmd[2] ?? "";
    if (script.includes("test -d /work/.git")) {
      return { exitCode: overrides.gitDirExists ? 0 : 1 };
    }
    if (script.includes("credential.helper store")) {
      return { exitCode: overrides.credHelperExit ?? 0 };
    }
    if (script.includes("git credential approve")) {
      return { exitCode: overrides.approveExit ?? 0 };
    }
    if (script.includes("git clone")) {
      return {
        exitCode: overrides.cloneExit ?? 0,
        ...(overrides.cloneStderr ? { stderr: overrides.cloneStderr } : {}),
      };
    }
    if (script.includes("git credential reject")) {
      return { exitCode: overrides.rejectExit ?? 0 };
    }
    return { exitCode: 0 };
  };
}

describe("createSandbox", () => {
  it("① ensure 不存在 → createContainer 全形状断言 + start", async () => {
    const { docker, calls } = makeFakeDocker([]);
    const sandbox = createSandbox(docker);

    const container = await sandbox.ensure("abc");

    const createCall = calls.find((c) => c.startsWith("createContainer:"));
    expect(createCall).toBeDefined();
    const args = JSON.parse(createCall!.slice("createContainer:".length));
    expect(args).toMatchObject({
      name: "otto-ws-abc",
      Image: "otto-sandbox",
      Cmd: ["sleep", "infinity"],
      Labels: { "mrotto.workspace": "abc" },
      HostConfig: {
        Memory: 2 * 1024 ** 3,
        NanoCpus: 2e9,
        PidsLimit: 512,
        Mounts: [{ Type: "volume", Source: "otto-ws-abc", Target: "/work" }],
      },
    });
    expect(calls.some((c) => c === "start:c1")).toBe(true);
    expect(container).toBeDefined();
  });

  it("② ensure 已停 → 只 start 不 create", async () => {
    const { docker, calls } = makeFakeDocker([
      { id: "c1", name: "otto-ws-x", state: "exited", labels: { "mrotto.workspace": "x" } },
    ]);
    const sandbox = createSandbox(docker);

    await sandbox.ensure("x");

    expect(calls.some((c) => c.startsWith("createContainer:"))).toBe(false);
    expect(calls.some((c) => c === "start:c1")).toBe(true);
  });

  it("③ sweepIdle 尊重 runningWorkspaces", async () => {
    let t = 0;
    const { docker, calls } = makeFakeDocker([
      { id: "c1", name: "otto-ws-a", state: "running", labels: { "mrotto.workspace": "a" } },
      { id: "c2", name: "otto-ws-b", state: "running", labels: { "mrotto.workspace": "b" } },
    ]);
    const sandbox = createSandbox(docker, { now: () => t, idleMs: 1000 });

    await sandbox.ensure("a"); // marks active @ t=0
    await sandbox.ensure("b"); // marks active @ t=0
    t = 2000; // both idle > 1000ms

    const stopped = await sandbox.sweepIdle(new Set(["a"])); // a 正跑着 turn

    expect(stopped).toEqual(["b"]);
    expect(calls.some((c) => c === "stop:c2")).toBe(true);
    expect(calls.some((c) => c === "stop:c1")).toBe(false);
  });

  it("④ reconcile 首见孤儿只标记不删，越过 grace 后 remove(force)+卷删", async () => {
    let t = 0;
    const { docker, calls, volumes } = makeFakeDocker([
      { id: "c1", name: "otto-ws-orphan", state: "running", labels: { "mrotto.workspace": "orphan" } },
    ]);
    let store: Record<string, number> = {};
    const orphans = {
      load: () => ({ ...store }),
      save: (m: Record<string, number>) => {
        store = { ...m };
      },
    };
    const sandbox = createSandbox(docker, { now: () => t, orphanGraceMs: 1000, orphans });

    const r1 = await sandbox.reconcile(new Set(["other"])); // orphan 不在 validIds

    expect(r1.marked).toEqual(["orphan"]);
    expect(r1.removed).toEqual([]);
    expect(store).toEqual({ orphan: 0 });
    expect(calls.some((c) => c.startsWith("remove:"))).toBe(false);

    t = 2000; // 越过 grace

    const r2 = await sandbox.reconcile(new Set(["other"]));

    expect(r2.marked).toEqual([]);
    expect(r2.removed).toEqual(["orphan"]);
    expect(calls.some((c) => c === "remove:c1:true")).toBe(true);
    expect(volumes.has("otto-ws-orphan")).toBe(false);
    expect(store).toEqual({});

    const removeIdx = calls.indexOf("remove:c1:true");
    const volRemoveIdx = calls.indexOf("volumeRemove:otto-ws-orphan");
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(volRemoveIdx).toBeGreaterThan(removeIdx);
  });

  it("⑥ reconcile 反悔：标记后变回 valid → 清除标记；再次不 valid 从头计时", async () => {
    let t = 0;
    const { docker, calls } = makeFakeDocker([
      { id: "c1", name: "otto-ws-flaky", state: "running", labels: { "mrotto.workspace": "flaky" } },
    ]);
    let store: Record<string, number> = {};
    const orphans = {
      load: () => ({ ...store }),
      save: (m: Record<string, number>) => {
        store = { ...m };
      },
    };
    const sandbox = createSandbox(docker, { now: () => t, orphanGraceMs: 1000, orphans });

    const r1 = await sandbox.reconcile(new Set()); // 误标记（比如 supabase 抖动）
    expect(r1.marked).toEqual(["flaky"]);
    expect(store).toEqual({ flaky: 0 });

    t = 500;
    const r2 = await sandbox.reconcile(new Set(["flaky"])); // 恢复合法
    expect(r2.marked).toEqual([]);
    expect(r2.removed).toEqual([]);
    expect(store).toEqual({}); // 标记被清除，不是留着等下次抖动时越过 grace

    t = 5000; // 早已过 grace——若标记没清，这里会被误删
    const r3 = await sandbox.reconcile(new Set()); // 再次不合法
    expect(r3.marked).toEqual(["flaky"]); // 重新计时，只标记不删
    expect(r3.removed).toEqual([]);
    expect(calls.some((c) => c.startsWith("remove:"))).toBe(false);
  });

  it("⑦ reconcile 无容器的孤儿卷：按名字前缀反推 id，同样走 marked/grace 两段式", async () => {
    let t = 0;
    const { docker, calls, volumes } = makeFakeDocker([]);
    volumes.add("otto-ws-danglingvol"); // 容器已经没了，卷还在
    let store: Record<string, number> = {};
    const orphans = {
      load: () => ({ ...store }),
      save: (m: Record<string, number>) => {
        store = { ...m };
      },
    };
    const sandbox = createSandbox(docker, { now: () => t, orphanGraceMs: 1000, orphans });

    const r1 = await sandbox.reconcile(new Set(["other"]));
    expect(r1.marked).toEqual(["danglingvol"]);
    expect(r1.removed).toEqual([]);
    expect(volumes.has("otto-ws-danglingvol")).toBe(true); // 首轮只标记不删

    t = 2000; // 越过 grace
    const r2 = await sandbox.reconcile(new Set(["other"]));
    expect(r2.marked).toEqual([]);
    expect(r2.removed).toEqual(["danglingvol"]);
    expect(volumes.has("otto-ws-danglingvol")).toBe(false);
    expect(calls.some((c) => c === "volumeRemove:otto-ws-danglingvol")).toBe(true);

    // valid 的孤儿卷不动
    volumes.add("otto-ws-keepvol");
    const r3 = await sandbox.reconcile(new Set(["keepvol"]));
    expect(r3.marked).not.toContain("keepvol");
    expect(r3.removed).not.toContain("keepvol");
    expect(volumes.has("otto-ws-keepvol")).toBe(true);
  });

  it("⑤ destroy 容器与卷都删；容器不存在时只删卷、不炸", async () => {
    const { docker, calls, volumes } = makeFakeDocker([
      { id: "c1", name: "otto-ws-y", state: "running", labels: { "mrotto.workspace": "y" } },
    ]);
    const sandbox = createSandbox(docker);

    await sandbox.destroy("y");

    expect(calls.some((c) => c === "remove:c1:true")).toBe(true);
    expect(volumes.has("otto-ws-y")).toBe(false);
    const removeIdx = calls.indexOf("remove:c1:true");
    const volRemoveIdx = calls.indexOf("volumeRemove:otto-ws-y");
    expect(volRemoveIdx).toBeGreaterThan(removeIdx);

    // 容器不存在（比如已经手动删过）：只删卷，不炸
    volumes.add("otto-ws-z");
    await expect(sandbox.destroy("z")).resolves.toBeUndefined();
    expect(volumes.has("otto-ws-z")).toBe(false);
    expect(calls.some((c) => c.startsWith("remove:") && c.endsWith(":true") && c.includes("z"))).toBe(false);
  });
});

describe("createSandbox — git clone（issue #821 slice 1）", () => {
  it("⑧ 没配 repo 时不 clone", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-noconf", state: "running", labels: { "mrotto.workspace": "noconf" } },
    ]);
    const execLog: Array<{ cmd: string[]; stdin?: string }> = [];
    const wrapped = withCloneExec(docker, cloneRouter(), execLog);
    const results: Array<{ workspaceId: string; result: unknown }> = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => undefined, // 有查询面，但这个工作区没配
      onCloneResult: (workspaceId, result) => results.push({ workspaceId, result }),
    });

    const container = await sandbox.ensure("noconf");

    expect(container).toBeDefined();
    expect(execLog.length).toBe(0); // 没碰 exec 半步——现状行为（空容器）
    expect(results.length).toBe(0);
  });

  it("⑨ 配了且 /work/.git 不存在 → 执行 clone；Cmd 数组不含 PAT，PAT 经 stdin 传入", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-fresh", state: "running", labels: { "mrotto.workspace": "fresh" } },
    ]);
    const execLog: Array<{ cmd: string[]; stdin?: string }> = [];
    const wrapped = withCloneExec(docker, cloneRouter({ gitDirExists: false, cloneExit: 0 }), execLog);
    const results: Array<{ workspaceId: string; result: { ok: boolean; repoUrl: string; reason?: string } }> = [];
    const PAT = "ghp_supersecrettoken1234";
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git", pat: PAT }),
      onCloneResult: (workspaceId, result) =>
        results.push({ workspaceId, result: result as { ok: boolean; repoUrl: string; reason?: string } }),
    });

    await sandbox.ensure("fresh");

    // PAT 不出现在任何一条 Cmd 数组里（拼接后整段搜，防止它被拆在两个数组元素之间也漏检）
    for (const call of execLog) {
      expect(call.cmd.join(" ")).not.toContain(PAT);
    }

    // PAT 经 stdin 传入 git credential approve
    const approveCall = execLog.find((c) => c.cmd.join(" ").includes("git credential approve"));
    expect(approveCall).toBeDefined();
    expect(approveCall!.stdin).toContain(`password=${PAT}`);
    expect(approveCall!.stdin).toContain("protocol=https");
    expect(approveCall!.stdin).toContain("host=github.com");

    // clone 本身也发生了，且 Cmd 里是原样 URL（不含 token）
    const cloneCall = execLog.find((c) => c.cmd.join(" ").includes("git clone"));
    expect(cloneCall).toBeDefined();
    expect(cloneCall!.cmd.join(" ")).toContain("https://github.com/acme/widgets.git");

    expect(results).toEqual([
      { workspaceId: "fresh", result: { ok: true, repoUrl: "https://github.com/acme/widgets.git" } },
    ]);
  });

  it("⑩ 已有 /work/.git → 跳过 clone，不通报（幂等）", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-existing", state: "running", labels: { "mrotto.workspace": "existing" } },
    ]);
    const execLog: Array<{ cmd: string[]; stdin?: string }> = [];
    const wrapped = withCloneExec(docker, cloneRouter({ gitDirExists: true }), execLog);
    const results: unknown[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
      onCloneResult: (_workspaceId, result) => results.push(result),
    });

    const container = await sandbox.ensure("existing");

    expect(container).toBeDefined();
    expect(execLog.some((c) => c.cmd.join(" ").includes("git clone"))).toBe(false);
    expect(results.length).toBe(0);
  });

  it("⑪ clone 失败 → ensure 仍正常返回容器，回调收到失败原因", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-bad", state: "running", labels: { "mrotto.workspace": "bad" } },
    ]);
    const execLog: Array<{ cmd: string[]; stdin?: string }> = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ gitDirExists: false, cloneExit: 128, cloneStderr: "fatal: repository 'https://bad' not found" }),
      execLog,
    );
    const results: Array<{ workspaceId: string; result: { ok: boolean; repoUrl: string; reason?: string } }> = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/does-not-exist.git" }),
      onCloneResult: (workspaceId, result) =>
        results.push({ workspaceId, result: result as { ok: boolean; repoUrl: string; reason?: string } }),
    });

    const container = await sandbox.ensure("bad");

    expect(container).toBeDefined(); // 容器照常返回，没有被 clone 失败拖下水
    expect(results.length).toBe(1);
    expect(results[0]!.result.ok).toBe(false);
    expect(results[0]!.result.reason).toContain("not found");
  });

  it("⑫ 并发两次 ensure 只 clone 一次", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-race", state: "running", labels: { "mrotto.workspace": "race" } },
    ]);
    const execLog: Array<{ cmd: string[]; stdin?: string }> = [];
    const wrapped = withCloneExec(docker, cloneRouter({ gitDirExists: false, cloneExit: 0 }), execLog);
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
    });

    const [c1, c2] = await Promise.all([sandbox.ensure("race"), sandbox.ensure("race")]);

    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    const cloneCalls = execLog.filter((c) => c.cmd.join(" ").includes("git clone"));
    expect(cloneCalls.length).toBe(1);
  });

  it("⑬ 凭据在 clone 后被清理（reject + 删文件 + unset），发生在 clone 之后", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-cleanup", state: "running", labels: { "mrotto.workspace": "cleanup" } },
    ]);
    const execLog: Array<{ cmd: string[]; stdin?: string }> = [];
    const wrapped = withCloneExec(docker, cloneRouter({ gitDirExists: false, cloneExit: 0 }), execLog);
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git", pat: "ghp_xxx" }),
    });

    await sandbox.ensure("cleanup");

    const cleanupCall = execLog.find((c) => c.cmd.join(" ").includes("git credential reject"));
    expect(cleanupCall).toBeDefined();
    expect(cleanupCall!.cmd.join(" ")).toContain("rm -f");
    expect(cleanupCall!.cmd.join(" ")).toContain("git-credentials");
    expect(cleanupCall!.cmd.join(" ")).toContain("--unset credential.helper");

    const cloneIdx = execLog.findIndex((c) => c.cmd.join(" ").includes("git clone"));
    const cleanupIdx = execLog.findIndex((c) => c.cmd.join(" ").includes("git credential reject"));
    expect(cloneIdx).toBeGreaterThanOrEqual(0);
    expect(cleanupIdx).toBeGreaterThan(cloneIdx);
  });

  it("⑭ 第二次 ensure（同进程内）不重新执行幂等检查——沿用已 settle 的 clone 结果", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-twice", state: "running", labels: { "mrotto.workspace": "twice" } },
    ]);
    const execLog: Array<{ cmd: string[]; stdin?: string }> = [];
    const wrapped = withCloneExec(docker, cloneRouter({ gitDirExists: false, cloneExit: 0 }), execLog);
    let queries = 0;
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => {
        queries++;
        return { repoUrl: "https://github.com/acme/widgets.git" };
      },
    });

    await sandbox.ensure("twice");
    const afterFirst = execLog.length;
    await sandbox.ensure("twice");

    expect(execLog.length).toBe(afterFirst); // 第二次 ensure 没有再发起任何 exec
    expect(queries).toBe(1); // repoConfig 也没有被再查一次
  });
});
