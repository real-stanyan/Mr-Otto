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

// ── git clone（issue #821 slice 1，复审 Rejected 八条修复后重建）専用の假
// exec ─────────────────────────────────────────────────────────────────
// 既有 makeFakeDocker 的 getContainer(id).exec 一律 throw（"not used in
// sandbox tests"）——不动它，克隆相关测试改用这层 wrapper 单独接管 exec/modem，
// 其余 listContainers/createContainer/listVolumes/getVolume 原样透传。

interface ExecOutcome {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  /** 让这次 exec 的 inspect() 永远回 { ExitCode: null }——模拟 docker 一直
      给不出退出码的场景（复审 C1 repro：credential approve 卡在这个状态，
      execInContainer 的 inspectExecExitCode 重试 5 次后会 throw） */
  neverResolveExitCode?: boolean;
  /** 让这次 exec 的 stream 走 'error' 而不是 'end'——模拟 docker attach 流
      本身出错（execInContainer 里 stream.on("error", reject) 那条路，同样
      是复审 C1 要覆盖的"execInContainer 直接抛异常"场景之一） */
  streamError?: boolean;
  /** 让这次 exec 的完成（'end'/'error'）等这个 promise 先 resolve——用来
      模拟"一个 attempt 的某条命令还卡着"，测试 invalidateClone 在它
      pending 期间被调用时，新 attempt 是否老老实实排队等它收尾（复审
      二轮竞态回归测试），而不是立刻并发起步 */
  gate?: Promise<void>;
}
type ExecRouter = (cmd: string[]) => ExecOutcome;
type ExecLog = Array<{ cmd: string[]; stdin?: string; workingDir?: string }>;

/** 按 exec 拿到的完整 Cmd 数组（`["/usr/bin/timeout","-k","5",secs,
    "/bin/bash","-lc",<script>]`，复审 I6 之后多了 timeout 前缀，脚本不再
    固定在 cmd[2]）拼成整段文本路由到预设结局，并把 attachStdin 场景下
    写入的内容整段记下——克隆测试要断言"PAT 经 stdin 传入、Cmd 数组里不含
    PAT"，全靠这份 execLog。

    execLog 的登记点在 exec() 被调用的那一刻（不是 inspect() 里）：
    neverResolveExitCode 场景下 inspect() 会被连续调用最多 5 次，登记点
    挂在 inspect() 会让同一条命令在 execLog 里重复出现好几遍，污染"数了
    几次 clone/reject 调用"这类断言。stdin 在 exec() 调用时还不知道（要
    等 start() 之后才会被写入），所以先登记一条占位记录，stdin 到达时
    原地在同一个对象上补上。 */
function withCloneExec(docker: DockerLike, router: ExecRouter, execLog: ExecLog): DockerLike {
  return {
    ...docker,
    getContainer(id: string) {
      const base = docker.getContainer(id);
      return {
        ...base,
        async exec(execOpts: {
          Cmd: string[];
          AttachStdout: boolean;
          AttachStderr: boolean;
          AttachStdin?: boolean;
          WorkingDir?: string;
        }) {
          const outcome = router(execOpts.Cmd);
          const record: ExecLog[number] = {
            cmd: execOpts.Cmd,
            ...(execOpts.WorkingDir !== undefined ? { workingDir: execOpts.WorkingDir } : {}),
          };
          execLog.push(record);

          // outcome 挂在 stream 实例本身上——modem.demuxStream 是容器共用
          // 的一个函数，没法从参数直接知道"这次 demux 对应哪次 exec"，
          // 靠 stream 自带的 __outcome 标记把预设 stdout/stderr 喂给对应
          // sink（每次 exec() 调用都会拿到一个全新的 stream 实例，互不
          // 干扰）
          const stream = new EventEmitter() as unknown as NodeJS.ReadWriteStream & { __outcome?: ExecOutcome };
          stream.__outcome = outcome;
          const finish = () => {
            if (outcome.streamError) stream.emit("error", new Error("simulated docker attach stream error"));
            else stream.emit("end");
          };
          // gate 未设置时和原来一样立刻（下一个 tick）收尾；设置了就先等
          // gate resolve，再补一个 setImmediate 让收尾走真正的异步路径
          const scheduleFinish = () => {
            if (outcome.gate) outcome.gate.then(() => setImmediate(finish));
            else setImmediate(finish);
          };
          (stream as unknown as { write: (d: string) => boolean }).write = (d: string) => {
            record.stdin = (record.stdin ?? "") + d;
            return true;
          };
          (stream as unknown as { end: () => void }).end = () => {
            scheduleFinish();
          };
          return {
            async start(startOpts?: { hijack?: boolean; stdin?: boolean }) {
              if (!startOpts?.stdin) scheduleFinish();
              return stream;
            },
            async inspect() {
              if (outcome.neverResolveExitCode) return { ExitCode: null };
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

/** 七个命令按 Cmd 拼接后的整段文本互斥匹配（幂等检查/凭据残留探测/凭据
    配置/凭据写入/清空目标目录/clone/凭据回收），每个都可以单独配置退出码
    ——覆盖字段走 overrides，不写就是"一路成功、且尚未 clone 过、没有
    残留凭据"的默认状态。字段名对齐 sandbox.ts 里的真实语义（`cloneComplete`
    对应 `git -C /work rev-parse HEAD`，不再是旧版的 `test -d /work/.git`
    ——复审 I3 之后判据换了）。 */
function cloneRouter(
  overrides: {
    cloneComplete?: boolean;
    residualCredentials?: boolean;
    credHelperExit?: number;
    approveExit?: number;
    approveNeverResolves?: boolean;
    clearExit?: number;
    cloneExit?: number;
    cloneStderr?: string;
    cloneStreamError?: boolean;
    rejectExit?: number;
  } = {},
): ExecRouter {
  return (cmd) => {
    const script = cmd.join(" ");
    if (script.includes("rev-parse HEAD")) {
      return { exitCode: overrides.cloneComplete ? 0 : 1 };
    }
    if (script.includes("test -f ~/.git-credentials")) {
      return { exitCode: overrides.residualCredentials ? 0 : 1 };
    }
    if (script.includes("credential.helper store")) {
      return { exitCode: overrides.credHelperExit ?? 0 };
    }
    if (script.includes("git credential approve")) {
      return {
        exitCode: overrides.approveExit ?? 0,
        ...(overrides.approveNeverResolves ? { neverResolveExitCode: true } : {}),
      };
    }
    if (script.includes("find /work -mindepth 1 -delete")) {
      return { exitCode: overrides.clearExit ?? 0 };
    }
    if (script.includes("git clone --")) {
      return {
        exitCode: overrides.cloneExit ?? 0,
        ...(overrides.cloneStderr ? { stderr: overrides.cloneStderr } : {}),
        ...(overrides.cloneStreamError ? { streamError: true } : {}),
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

/** 轮询等一个条件成立——不用固定 sleep（太短会 flaky，太长拖慢测试）。
    这份 fake 除了 gate 之外全靠 setImmediate 驱动异步收尾，没有真实
    timer，所以每次 setImmediate 都足够推进一步；给个宽松上限防止真出
    bug 时测试挂死不报错。 */
async function waitUntil(cond: () => boolean, maxTicks = 500): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("waitUntil：条件在预期的 tick 数内没有成立");
}

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

  it("⑨ 配了且没克隆过 → 执行 clone；Cmd 数组不含 PAT，PAT 经 stdin 传入", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-fresh", state: "running", labels: { "mrotto.workspace": "fresh" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ cloneComplete: false, cloneExit: 0 }), execLog);
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
      expect(call.cmd.join(" ")).not.toContain(PAT);
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

  it("⑩ 已经完整克隆过（rev-parse HEAD 成功） → 跳过 clone，不通报（幂等）", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-existing", state: "running", labels: { "mrotto.workspace": "existing" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ cloneComplete: true }), execLog);
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

  it("⑪ clone 以非零码失败 → ensure 仍正常返回容器，回调收到失败原因", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-bad", state: "running", labels: { "mrotto.workspace": "bad" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ cloneComplete: false, cloneExit: 128, cloneStderr: "fatal: repository 'https://bad' not found" }),
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
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ cloneComplete: false, cloneExit: 0 }), execLog);
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
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ cloneComplete: false, cloneExit: 0 }), execLog);
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
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ cloneComplete: false, cloneExit: 0 }), execLog);
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

  // ── 复审 Rejected 八条 ────────────────────────────────────────────────

  it("⑮（C1）credential approve 的 inspect 永远拿不到退出码 → ensure 仍正常返回，但凭据依然被清理", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-stuck", state: "running", labels: { "mrotto.workspace": "stuck" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ cloneComplete: false, approveNeverResolves: true }),
      execLog,
    );
    const results: Array<{ result: { ok: boolean; reason?: string } }> = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git", pat: "ghp_stuck" }),
      onCloneResult: (_workspaceId, result) => results.push({ result: result as { ok: boolean; reason?: string } }),
    });

    const container = await sandbox.ensure("stuck");

    expect(container).toBeDefined(); // ensure 没有被拖下水
    expect(results.length).toBe(1);
    expect(results[0]!.result.ok).toBe(false);
    // 关键断言：即使 approve 阶段的 exec 本身抛异常（不是返回非零 exitCode），
    // cleanup（reject/rm/unset）依然被调用过——旧版本这里会漏做（复审 C1 repro）
    expect(execLog.some((c) => c.cmd.join(" ").includes("git credential reject"))).toBe(true);
    // clone 本身不应该发生——approve 都没成功，不该往下走
    expect(execLog.some((c) => c.cmd.join(" ").includes("git clone --"))).toBe(false);
  });

  it("⑯（C1）clone 阶段 docker 流本身出错 → ensure 仍正常返回，但凭据依然被清理", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-streamerr", state: "running", labels: { "mrotto.workspace": "streamerr" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ cloneComplete: false, cloneStreamError: true }),
      execLog,
    );
    const results: Array<{ result: { ok: boolean } }> = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git", pat: "ghp_streamerr" }),
      onCloneResult: (_workspaceId, result) => results.push({ result: result as { ok: boolean } }),
    });

    const container = await sandbox.ensure("streamerr");

    expect(container).toBeDefined();
    expect(results.length).toBe(1);
    expect(results[0]!.result.ok).toBe(false);
    expect(execLog.some((c) => c.cmd.join(" ").includes("git credential reject"))).toBe(true);
  });

  it("⑰（C2）幂等命中但探到凭据残留 → 顺手清理，不重新 clone", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-residual", state: "running", labels: { "mrotto.workspace": "residual" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ cloneComplete: true, residualCredentials: true }), execLog);
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
    });

    await sandbox.ensure("residual");

    expect(execLog.some((c) => c.cmd.join(" ").includes("test -f ~/.git-credentials"))).toBe(true);
    expect(execLog.some((c) => c.cmd.join(" ").includes("git credential reject"))).toBe(true);
    expect(execLog.some((c) => c.cmd.join(" ").includes("git clone --"))).toBe(false); // 没有重新 clone
  });

  it("⑱（C2）幂等命中且没有残留凭据 → 只探测，不空跑 reject/rm/unset", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-clean", state: "running", labels: { "mrotto.workspace": "clean" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ cloneComplete: true, residualCredentials: false }), execLog);
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
    });

    await sandbox.ensure("clean");

    expect(execLog.some((c) => c.cmd.join(" ").includes("test -f ~/.git-credentials"))).toBe(true);
    expect(execLog.some((c) => c.cmd.join(" ").includes("git credential reject"))).toBe(false);
  });

  it("⑲（I3）半成品 clone（.git 建了但没有可用提交）→ 判定没完成，清空目标目录后重新 clone", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-half", state: "running", labels: { "mrotto.workspace": "half" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ cloneComplete: false, cloneExit: 0 }), execLog);
    const results: Array<{ result: { ok: boolean } }> = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
      onCloneResult: (_workspaceId, result) => results.push({ result: result as { ok: boolean } }),
    });

    await sandbox.ensure("half");

    expect(execLog.some((c) => c.cmd.join(" ").includes("rev-parse HEAD"))).toBe(true); // 幂等检查跑过
    const clearIdx = execLog.findIndex((c) => c.cmd.join(" ").includes("find /work -mindepth 1 -delete"));
    const cloneIdx = execLog.findIndex((c) => c.cmd.join(" ").includes("git clone --"));
    expect(clearIdx).toBeGreaterThanOrEqual(0); // 判定没完成后，清空目标目录这一步确实跑了
    expect(cloneIdx).toBeGreaterThan(clearIdx); // 清空发生在重新 clone 之前（不然 git clone 会因目录非空拒绝）
    expect(results.length).toBe(1); // 没有被幂等分支静默吞掉——用户能看到这次重新 clone 的结果
    expect(results[0]!.result.ok).toBe(true);
  });

  it("⑳（I4）invalidateClone 后重新配置——ensure 立刻重新尝试 clone，不用等进程重启", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-retry", state: "running", labels: { "mrotto.workspace": "retry" } },
    ]);
    const execLog: ExecLog = [];
    let cloneExit = 128; // 先失败（比如 repoUrl 配错）
    const wrapped = withCloneExec(
      docker,
      (cmd) => {
        const script = cmd.join(" ");
        if (script.includes("rev-parse HEAD")) return { exitCode: 1 };
        if (script.includes("git clone --")) return { exitCode: cloneExit };
        return { exitCode: 0 };
      },
      execLog,
    );
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
    });

    await sandbox.ensure("retry");
    const cloneCallsAfterFirst = execLog.filter((c) => c.cmd.join(" ").includes("git clone --")).length;
    expect(cloneCallsAfterFirst).toBe(1);

    await sandbox.ensure("retry"); // 缓存生效，不重新尝试
    expect(execLog.filter((c) => c.cmd.join(" ").includes("git clone --")).length).toBe(cloneCallsAfterFirst);

    sandbox.invalidateClone("retry"); // owner 纠正了配置
    cloneExit = 0; // 这次能成功了
    await sandbox.ensure("retry");

    expect(execLog.filter((c) => c.cmd.join(" ").includes("git clone --")).length).toBe(cloneCallsAfterFirst + 1);
  });

  it("㉑（I5）onCloneResult 回调自身抛出异常（正常出结果路径）→ 不传导，ensure 仍正常返回", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-cbthrows", state: "running", labels: { "mrotto.workspace": "cbthrows" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ cloneComplete: false, cloneExit: 0 }), execLog);
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
      onCloneResult: () => {
        throw new Error("simulated store.append failure (disk full)");
      },
    });

    await expect(sandbox.ensure("cbthrows")).resolves.toBeDefined();
  });

  it("㉒（I5）onCloneResult 回调自身抛出异常（意外异常兜底路径）→ 同样不传导", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-cbthrows2", state: "running", labels: { "mrotto.workspace": "cbthrows2" } },
    ]);
    const execLog: ExecLog = [];
    // 幂等检查本身抛异常（inspect 永远拿不到退出码），逼 runCloneAttempt
    // 走它自己的 catch 分支——这条分支也调 onCloneResult，同样要吞掉回调
    // 自身的异常
    const wrapped = withCloneExec(
      docker,
      (cmd) => {
        const script = cmd.join(" ");
        if (script.includes("rev-parse HEAD")) return { exitCode: 0, neverResolveExitCode: true };
        return { exitCode: 0 };
      },
      execLog,
    );
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
      onCloneResult: () => {
        throw new Error("simulated callback failure");
      },
    });

    await expect(sandbox.ensure("cbthrows2")).resolves.toBeDefined();
  });

  it("㉓（M7）PAT 存在 + clone 以非零码失败 → 同样触发凭据清理，reason 不含 PAT", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-patfail", state: "running", labels: { "mrotto.workspace": "patfail" } },
    ]);
    const execLog: ExecLog = [];
    const PAT = "ghp_patfail_secret";
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ cloneComplete: false, cloneExit: 128, cloneStderr: "fatal: authentication failed" }),
      execLog,
    );
    const results: Array<{ result: { ok: boolean; reason?: string } }> = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git", pat: PAT }),
      onCloneResult: (_workspaceId, result) => results.push({ result: result as { ok: boolean; reason?: string } }),
    });

    await sandbox.ensure("patfail");

    expect(results.length).toBe(1);
    expect(results[0]!.result.ok).toBe(false);
    expect(results[0]!.result.reason).not.toContain(PAT);
    expect(execLog.some((c) => c.cmd.join(" ").includes("git credential reject"))).toBe(true);
    for (const call of execLog) {
      expect(call.cmd.join(" ")).not.toContain(PAT);
    }
  });

  it("㉔（M8）每条 exec 都带 WorkingDir=/work，且各自套了 timeout（clone 600s，其余默认 30s）", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-wd", state: "running", labels: { "mrotto.workspace": "wd" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ cloneComplete: false, cloneExit: 0 }), execLog);
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
    });

    await sandbox.ensure("wd");

    expect(execLog.length).toBeGreaterThan(0);
    for (const call of execLog) {
      expect(call.workingDir).toBe("/work");
    }

    const rev = execLog.find((c) => c.cmd.join(" ").includes("rev-parse HEAD"));
    expect(rev!.cmd.slice(0, 4)).toEqual(["/usr/bin/timeout", "-k", "5", "30"]);
    const clone = execLog.find((c) => c.cmd.join(" ").includes("git clone --"));
    expect(clone!.cmd.slice(0, 4)).toEqual(["/usr/bin/timeout", "-k", "5", "600"]);
  });

  it("㉕（M8）clone 超时（exitCode 124）→ reason 带「命令超时」友好文案", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-timeout", state: "running", labels: { "mrotto.workspace": "timeout" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ cloneComplete: false, cloneExit: 124 }), execLog);
    const results: Array<{ result: { ok: boolean; reason?: string } }> = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
      onCloneResult: (_workspaceId, result) => results.push({ result: result as { ok: boolean; reason?: string } }),
    });

    await sandbox.ensure("timeout");

    expect(results.length).toBe(1);
    expect(results[0]!.result.ok).toBe(false);
    expect(results[0]!.result.reason).toContain("命令超时");
  });

  it("㉖（复审二轮防患）checkCloneComplete 先注册 safe.directory，且发生在 rev-parse 之前", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-safedir", state: "running", labels: { "mrotto.workspace": "safedir" } },
    ]);
    const execLog: ExecLog = [];
    // cloneComplete:true——幂等命中，只走 checkCloneComplete 不真的 clone，
    // 断言聚焦在这一个函数内两条命令的先后顺序
    const wrapped = withCloneExec(docker, cloneRouter({ cloneComplete: true }), execLog);
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
    });

    await sandbox.ensure("safedir");

    const safeDirIdx = execLog.findIndex((c) => c.cmd.join(" ").includes("safe.directory /work"));
    const revParseIdx = execLog.findIndex((c) => c.cmd.join(" ").includes("rev-parse HEAD"));
    expect(safeDirIdx).toBeGreaterThanOrEqual(0);
    expect(revParseIdx).toBeGreaterThan(safeDirIdx);
  });

  it("㉗（复审二轮竞态修复）clone 进行中调 invalidateClone——新 attempt 等旧 attempt 完全收尾（含 cleanup）才起步，不重叠", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-race2", state: "running", labels: { "mrotto.workspace": "race2" } },
    ]);
    const execLog: ExecLog = [];

    let releaseOldClone: (() => void) | undefined;
    const oldCloneGate = new Promise<void>((resolve) => {
      releaseOldClone = resolve;
    });

    // rev-parse 永远回"没克隆完"（逼真的走到 clone 那一步）；旧配置
    // （old-repo）的 clone 卡在 gate 上，新配置（new-repo）的 clone 立刻
    // 完成——用仓库名区分是哪一次 attempt 发起的调用
    const wrapped = withCloneExec(
      docker,
      (cmd) => {
        const script = cmd.join(" ");
        if (script.includes("rev-parse HEAD")) return { exitCode: 1 };
        if (script.includes("git clone --") && script.includes("old-repo")) {
          return { exitCode: 0, gate: oldCloneGate };
        }
        return { exitCode: 0 };
      },
      execLog,
    );

    let repoConfigCalls = 0;
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => {
        repoConfigCalls++;
        // 第一次给旧（坏）配置；owner 纠正之后甚至换成了不需要 PAT 的
        // 公开仓库——第二次 attempt 应该用这份新配置，而不是继续用旧的
        return repoConfigCalls === 1
          ? { repoUrl: "https://github.com/acme/old-repo.git", pat: "ghp_old" }
          : { repoUrl: "https://github.com/acme/new-repo.git" };
      },
    });

    const firstEnsure = sandbox.ensure("race2"); // session A：起第一个 attempt，会卡在 old-repo 的 clone 上

    await waitUntil(() => {
      const j = execLog.map((c) => c.cmd.join(" "));
      return j.some((s) => s.includes("git clone --") && s.includes("old-repo"));
    });

    sandbox.invalidateClone("race2"); // owner 纠正了配置
    const secondEnsure = sandbox.ensure("race2"); // session B：紧接着触发新的工具调用

    // 给事件循环几个 tick 的机会——如果实现有 bug（invalidateClone 直接
    // delete 掉 pending 的 slot，导致 B 立刻并发起第二个 attempt），这里
    // 就会看到 repoConfig 已经被查了第二次。正确实现下 B 的
    // runCloneAttempt 要等 A 的 promise（含 finally 里的 cleanup）settle
    // 之后才会调 repoConfig，所以此刻应该仍然是 1。
    await new Promise((r) => setTimeout(r, 30));
    expect(repoConfigCalls).toBe(1);
    expect(execLog.some((c) => c.cmd.join(" ").includes("new-repo"))).toBe(false);

    releaseOldClone!(); // 放行旧 attempt，让它的 clone 完成、走完 finally 里的 cleanup

    await Promise.all([firstEnsure, secondEnsure]);

    // 新 attempt 确实起来了，且用的是新配置（没有 PAT 的公开仓库）
    expect(repoConfigCalls).toBe(2);
    const newCloneIdx = execLog.findIndex((c) => c.cmd.join(" ").includes("new-repo"));
    expect(newCloneIdx).toBeGreaterThanOrEqual(0);

    // 不重叠：旧 attempt 收尾时的凭据清理（整个 execLog 里唯一一次
    // "git credential reject"——B 的新配置没有 PAT，不会触发它自己的
    // 凭据步骤，所以这次 reject 只可能属于 A）严格发生在新 attempt 的
    // clone 之前，证明 B 是排在 A 完全收尾之后才起步的，不是并发
    const rejectIdx = execLog.findIndex((c) => c.cmd.join(" ").includes("git credential reject"));
    expect(rejectIdx).toBeGreaterThanOrEqual(0);
    expect(rejectIdx).toBeLessThan(newCloneIdx);
  });
});
