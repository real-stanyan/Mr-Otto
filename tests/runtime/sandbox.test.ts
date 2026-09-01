import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  cloneOutcomeText,
  createSandbox,
  decideCloneAction,
  parseWorkState,
  safeRepoLabel,
  sameRepo,
  type CloneOutcome,
  type DockerLike,
} from "../../services/runtime/src/sandbox.js";

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
type ExecLog = Array<{ cmd: string[]; stdin?: string; workingDir?: string; containerName?: string }>;

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
function withCloneExec(
  docker: DockerLike,
  router: ExecRouter,
  execLog: ExecLog,
  resolveName?: (id: string) => string,
): DockerLike {
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
            // 登记名字而不是 id：旁路容器跑完就被删了，事后再查 id 查不到
            ...(resolveName ? { containerName: resolveName(id) } : {}),
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

/** 磁盘可用空间的默认读数（KiB）——100 GiB，任何 clone 都放行。
    #836 的下限闸只在测试显式给 dfStdout 时才会挡下来。 */
const HUGE_DF = "104857600\n";

/** 五类命令按 Cmd 拼接后的整段文本互斥匹配（探现状 / 查空间 / 配 helper /
    写凭据 / 清空目录 / clone），每个都可以单独配置结局。默认状态 =
    "/work 是空的、磁盘很空、一路成功"。

    #832 之后 `cloneComplete` 这个布尔没有了：/work 的现状是 probe 脚本
    的一段 stdout（`state=` + 可选的 origin/dirty/ahead），要么用 `probe`
    整段给，要么用 `origin`/`dirty`/`ahead` 拼一个 state=repo 出来。 */
function cloneRouter(
  overrides: {
    /** 整段 probe stdout，给了就直接用（state=foreign / state=partial 这类） */
    probe?: string;
    /** 给了就是 state=repo（不给就是 state=empty） */
    origin?: string;
    dirty?: boolean;
    ahead?: string;
    probeExit?: number;
    probeStderr?: string;
    dfStdout?: string;
    credHelperExit?: number;
    approveExit?: number;
    approveNeverResolves?: boolean;
    clearExit?: number;
    cloneExit?: number;
    cloneStderr?: string;
    cloneStreamError?: boolean;
  } = {},
): ExecRouter {
  const probeStdout =
    overrides.probe ??
    (overrides.origin === undefined
      ? "state=empty\n"
      : `state=repo\norigin=${overrides.origin}\ndirty=${overrides.dirty ? 1 : 0}\nahead=${overrides.ahead ?? "0"}\n`);

  return (cmd) => {
    const script = cmd.join(" ");
    if (script.includes("echo state=repo")) {
      return {
        exitCode: overrides.probeExit ?? 0,
        stdout: probeStdout,
        ...(overrides.probeStderr ? { stderr: overrides.probeStderr } : {}),
      };
    }
    if (script.includes("df -Pk /work")) {
      return { exitCode: 0, stdout: overrides.dfStdout ?? HUGE_DF };
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
    return { exitCode: 0 };
  };
}

/** execLog 里那条 `containerName` 的来源——#835⑤ 之后"这条命令跑在哪台
    容器上"成了要断言的事实（凭据只许出现在一次性旁路容器里） */
function nameOf(containers: Map<string, FakeContainer>): (id: string) => string {
  return (id) => containers.get(id)?.name ?? id;
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

describe("createSandbox — git clone（#821 slice 1 / #832 决策表 / #835 旁路容器）", () => {
  // ── clone（issue #821 slice 1；#832 / #835 之后判据与凭据落点都变了）──
  // 这一批测试整体重写而不是逐条打补丁，因为被测的机制换了两处（motive
  // 同时记在 commit 里）：
  //   ① "要不要 clone" 从一个布尔（`rev-parse HEAD`）变成一张决策表
  //      （probeWorkState → decideCloneAction），旧的"能 rev-parse 就跳过"
  //      「不能就 find -delete」两分支不复存在；
  //   ② clone 不再跑在水獭那台容器里，而是一台一次性旁路容器——原来那套
  //      "写凭据 → 用完 reject → 删文件 → unset"的测试（旧 ⑬⑮⑯⑰⑱㉓）
  //      跟着那套机制一起删了，替代它们的是两条**更强**的断言：凭据相关的
  //      exec 从没在水獭那台容器上出现过，且旁路容器无论成败都被删掉。

  it("⑧ 没配 repo 时不 clone", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-norepo", state: "running", labels: { "mrotto.workspace": "norepo" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter(), execLog);
    const sandbox = createSandbox(wrapped, { repoConfig: async () => undefined });

    await sandbox.ensure("norepo");

    expect(execLog.length).toBe(0);
  });

  it("⑨ /work 空 + 配了 repo → clone；Cmd 数组不含 PAT，PAT 经 stdin 传入", async () => {
    const PAT = "ghp_secret_token_value";
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-cloneme", state: "running", labels: { "mrotto.workspace": "cloneme" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter(), execLog, nameOf(containers));
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git", pat: PAT }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    await sandbox.ensure("cloneme");

    const clone = execLog.find((c) => c.cmd.join(" ").includes("git clone --"));
    expect(clone).toBeDefined();
    expect(clone!.cmd.join(" ")).not.toContain(PAT);
    const approve = execLog.find((c) => c.cmd.join(" ").includes("git credential approve"));
    expect(approve).toBeDefined();
    expect(approve!.cmd.join(" ")).not.toContain(PAT);
    expect(approve!.stdin).toContain(`password=${PAT}`);
    expect(outcomes).toEqual([{ kind: "cloned", repoUrl: "https://github.com/acme/widgets.git" }]);
  });

  it("⑨b（#835⑤）凭据相关的 exec 一条都没落在水獭那台容器上——只在一次性旁路容器里", async () => {
    const PAT = "ghp_never_in_workspace_container";
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-sidecar", state: "running", labels: { "mrotto.workspace": "sidecar" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter(), execLog, nameOf(containers));
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git", pat: PAT }),
    });

    await sandbox.ensure("sidecar");

    // 水獭那台容器上只该有一条 exec：探现状（它不碰凭据）
    const onWorkspace = execLog.filter((c) => c.containerName === "otto-ws-sidecar");
    expect(onWorkspace.length).toBe(1);
    expect(onWorkspace[0]!.cmd.join(" ")).toContain("state=repo"); // probe 脚本
    for (const rec of onWorkspace) {
      expect(rec.stdin ?? "").not.toContain(PAT);
    }
    // 凭据/克隆都落在旁路容器上
    const credential = execLog.filter((c) => c.cmd.join(" ").includes("git credential approve"));
    expect(credential.length).toBe(1);
    expect(credential[0]!.containerName?.startsWith("otto-clone-sidecar-")).toBe(true);
  });

  it("⑨c（#835⑤）旁路容器：挂同一个卷 + 打 mrotto.clone 标签，跑完被 remove(force)", async () => {
    const { docker, calls, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-sidecar2", state: "running", labels: { "mrotto.workspace": "sidecar2" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter(), execLog, nameOf(containers));
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git", pat: "p" }),
    });

    await sandbox.ensure("sidecar2");

    const createCall = calls.filter((c) => c.startsWith("createContainer:")).at(-1);
    const args = JSON.parse(createCall!.slice("createContainer:".length)) as Record<string, unknown>;
    expect(String(args["name"]).startsWith("otto-clone-sidecar2-")).toBe(true);
    expect(args["Labels"]).toEqual({ "mrotto.clone": "sidecar2" });
    expect(args["HostConfig"]).toMatchObject({
      Mounts: [{ Type: "volume", Source: "otto-ws-sidecar2", Target: "/work" }],
    });
    // 跑完不留：本进程里再也没有这台容器
    expect([...containers.values()].some((c) => c.name.startsWith("otto-clone-"))).toBe(false);
  });

  it("⑨d（#835⑤）clone 中途抛异常 → 旁路容器照样被删，ensure 仍正常返回", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-sidecar3", state: "running", labels: { "mrotto.workspace": "sidecar3" } },
    ]);
    const execLog: ExecLog = [];
    // docker attach 流本身出错——execInContainer 直接抛异常那条路
    const wrapped = withCloneExec(docker, cloneRouter({ cloneStreamError: true }), execLog, nameOf(containers));
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git", pat: "p" }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    const container = await sandbox.ensure("sidecar3");

    expect(container).toBeDefined();
    expect(outcomes[0]!.kind).toBe("failed");
    expect([...containers.values()].some((c) => c.name.startsWith("otto-clone-"))).toBe(false);
  });

  it("⑩（#832）/work 已是同一个仓库的克隆 → skip，而且**说出口**（旧版这里静音）", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-already", state: "running", labels: { "mrotto.workspace": "already" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ origin: "https://github.com/acme/widgets.git" }),
      execLog,
      nameOf(containers),
    );
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    await sandbox.ensure("already");

    expect(execLog.some((c) => c.cmd.join(" ").includes("git clone --"))).toBe(false);
    expect(execLog.some((c) => c.cmd.join(" ").includes("find /work"))).toBe(false);
    expect(outcomes).toEqual([{ kind: "skipped", repoUrl: "https://github.com/acme/widgets.git" }]);
  });

  it("⑪ clone 以非零码失败 → ensure 仍正常返回容器，回调 kind=failed 带原因", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-fail", state: "running", labels: { "mrotto.workspace": "fail" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ cloneExit: 128, cloneStderr: "fatal: repository not found" }),
      execLog,
      nameOf(containers),
    );
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/nope.git" }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    const container = await sandbox.ensure("fail");

    expect(container).toBeDefined();
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]).toMatchObject({ kind: "failed", repoUrl: "https://github.com/acme/nope.git" });
    expect((outcomes[0] as { reason: string }).reason).toContain("repository not found");
  });

  it("⑫ 并发两次 ensure 只 clone 一次", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-conc", state: "running", labels: { "mrotto.workspace": "conc" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter(), execLog, nameOf(containers));
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
    });

    await Promise.all([sandbox.ensure("conc"), sandbox.ensure("conc")]);

    expect(execLog.filter((c) => c.cmd.join(" ").includes("git clone --")).length).toBe(1);
  });

  it("⑫b（#835①）并发两次 ensure 只建一次容器——两条会话同时起 turn 不该撞 409", async () => {
    const { docker, calls } = makeFakeDocker([]); // 容器还不存在：正是会撞的那一刻
    const sandbox = createSandbox(docker);

    const [a, b] = await Promise.all([sandbox.ensure("race"), sandbox.ensure("race")]);

    expect(calls.filter((c) => c.startsWith("createContainer:")).length).toBe(1);
    expect(a).toBe(b); // 同一个句柄，不是两台容器
  });

  it("⑬（#832 核心）/work 里有非 git 内容 → refused，一个字节都不清", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-foreign", state: "running", labels: { "mrotto.workspace": "foreign" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ probe: "state=foreign\n" }), execLog, nameOf(containers));
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    await sandbox.ensure("foreign");

    expect(execLog.some((c) => c.cmd.join(" ").includes("find /work"))).toBe(false);
    expect(execLog.some((c) => c.cmd.join(" ").includes("git clone --"))).toBe(false);
    expect(outcomes[0]!.kind).toBe("refused");
    expect((outcomes[0] as { reason: string }).reason).toContain("不是 git 仓库");
  });

  it("⑬b（#832）/work 是另一个仓库、有未提交改动 → refused，不清空", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-dirty", state: "running", labels: { "mrotto.workspace": "dirty" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ origin: "https://github.com/acme/old.git", dirty: true }),
      execLog,
      nameOf(containers),
    );
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/new.git" }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    await sandbox.ensure("dirty");

    expect(execLog.some((c) => c.cmd.join(" ").includes("find /work"))).toBe(false);
    expect(outcomes[0]!.kind).toBe("refused");
    expect((outcomes[0] as { reason: string }).reason).toContain("未提交的改动");
  });

  it("⑬c（#832）/work 是另一个仓库、干净但有没推送的提交 → refused（云沙箱不许 push，清了就没了）", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-ahead", state: "running", labels: { "mrotto.workspace": "ahead" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ origin: "https://github.com/acme/old.git", ahead: "3" }),
      execLog,
      nameOf(containers),
    );
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/new.git" }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    await sandbox.ensure("ahead");

    expect(execLog.some((c) => c.cmd.join(" ").includes("find /work"))).toBe(false);
    expect(outcomes[0]!.kind).toBe("refused");
    expect((outcomes[0] as { reason: string }).reason).toContain("还没推送");
  });

  it("⑬d（#832 核心）/work 是另一个仓库、干净且没有本地领先提交 → switched：清空后重新 clone", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-switch", state: "running", labels: { "mrotto.workspace": "switch" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ origin: "https://github.com/acme/old.git" }),
      execLog,
      nameOf(containers),
    );
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/new.git" }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    await sandbox.ensure("switch");

    const clearIdx = execLog.findIndex((c) => c.cmd.join(" ").includes("find /work -mindepth 1 -delete"));
    const cloneIdx = execLog.findIndex((c) => c.cmd.join(" ").includes("git clone --"));
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(cloneIdx).toBeGreaterThan(clearIdx);
    expect(outcomes[0]).toEqual({
      kind: "switched",
      repoUrl: "https://github.com/acme/new.git",
      from: "https://github.com/acme/old.git",
    });
  });

  it("⑬e（#832）ahead 拿不准（没有 upstream，水獭自己开了条分支）→ 按最坏情况 refuse", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-noups", state: "running", labels: { "mrotto.workspace": "noups" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ origin: "https://github.com/acme/old.git", ahead: "unknown" }),
      execLog,
      nameOf(containers),
    );
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/new.git" }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    await sandbox.ensure("noups");

    expect(outcomes[0]!.kind).toBe("refused");
    expect(execLog.some((c) => c.cmd.join(" ").includes("find /work"))).toBe(false);
  });

  it("⑭ 第二次 ensure（同进程内）不重新探测——沿用已 settle 的判定", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-cache", state: "running", labels: { "mrotto.workspace": "cache" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter(), execLog, nameOf(containers));
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
    });

    await sandbox.ensure("cache");
    const afterFirst = execLog.length;
    await sandbox.ensure("cache");

    expect(execLog.length).toBe(afterFirst);
  });

  it("⑮（#832）探测本身失败 → unknown → refused，绝不退化成「没克隆完」去清空", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-probefail", state: "running", labels: { "mrotto.workspace": "probefail" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ probeExit: 127, probeStderr: "bash: git: command not found" }),
      execLog,
      nameOf(containers),
    );
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    await sandbox.ensure("probefail");

    expect(execLog.some((c) => c.cmd.join(" ").includes("find /work"))).toBe(false);
    expect(outcomes[0]!.kind).toBe("refused");
    expect((outcomes[0] as { reason: string }).reason).toContain("探不清");
  });

  it("⑲（I3）半成品 clone（.git 建了但没有可用提交）→ 清空后重新 clone", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-partial", state: "running", labels: { "mrotto.workspace": "partial" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ probe: "state=partial\n" }), execLog, nameOf(containers));
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    await sandbox.ensure("partial");

    const clearIdx = execLog.findIndex((c) => c.cmd.join(" ").includes("find /work -mindepth 1 -delete"));
    const cloneIdx = execLog.findIndex((c) => c.cmd.join(" ").includes("git clone --"));
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(cloneIdx).toBeGreaterThan(clearIdx);
    expect(outcomes[0]!.kind).toBe("cloned");
  });

  it("⑳（I4）invalidateClone 后重新配置——ensure 立刻重新尝试，不用等进程重启", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-retry", state: "running", labels: { "mrotto.workspace": "retry" } },
    ]);
    const execLog: ExecLog = [];
    let cloneExit = 128; // 先失败（比如 repoUrl 配错）
    const wrapped = withCloneExec(
      docker,
      (cmd) => {
        const script = cmd.join(" ");
        if (script.includes("state=repo")) return { exitCode: 0, stdout: "state=empty\n" };
        if (script.includes("git clone --")) return { exitCode: cloneExit };
        return { exitCode: 0, stdout: HUGE_DF };
      },
      execLog,
      nameOf(containers),
    );
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
    });

    await sandbox.ensure("retry");
    expect(execLog.filter((c) => c.cmd.join(" ").includes("git clone --")).length).toBe(1);

    await sandbox.ensure("retry"); // 缓存生效，不重新尝试
    expect(execLog.filter((c) => c.cmd.join(" ").includes("git clone --")).length).toBe(1);

    sandbox.invalidateClone("retry"); // owner 纠正了配置
    cloneExit = 0;
    await sandbox.ensure("retry");

    expect(execLog.filter((c) => c.cmd.join(" ").includes("git clone --")).length).toBe(2);
  });

  it("⑳b（#832 症状①的回归）上一次克隆是**成功**的，owner 换了仓库地址 → 这次真的会重新 clone", async () => {
    // 这条正是旧实现永远做不到的那件事：旧的幂等判据只问"能不能
    // rev-parse HEAD"，克隆完好就直接 return，invalidateClone 起了个
    // 寂寞，owner 的修正被静默吃掉（而且连一句通报都没有）
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-swap", state: "running", labels: { "mrotto.workspace": "swap" } },
    ]);
    const execLog: ExecLog = [];
    let origin = "https://github.com/acme/old.git";
    let configured = "https://github.com/acme/old.git";
    const wrapped = withCloneExec(
      docker,
      (cmd) => {
        const script = cmd.join(" ");
        if (script.includes("state=repo")) {
          return { exitCode: 0, stdout: `state=repo\norigin=${origin}\ndirty=0\nahead=0\n` };
        }
        return { exitCode: 0, stdout: HUGE_DF };
      },
      execLog,
      nameOf(containers),
    );
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: configured }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    await sandbox.ensure("swap");
    expect(outcomes[0]!.kind).toBe("skipped"); // 第一次：本来就是这个仓库

    configured = "https://github.com/acme/new.git"; // owner 改了配置
    sandbox.invalidateClone("swap");
    await sandbox.ensure("swap");

    expect(outcomes[1]!.kind).toBe("switched");
    expect(execLog.filter((c) => c.cmd.join(" ").includes("git clone --")).length).toBe(1);
  });

  it("㉑（I5）onCloneOutcome 回调自身抛出异常 → 不传导，ensure 仍正常返回", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-cbthrows", state: "running", labels: { "mrotto.workspace": "cbthrows" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter(), execLog, nameOf(containers));
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
      onCloneOutcome: () => {
        throw new Error("simulated store.append failure (disk full)");
      },
    });

    await expect(sandbox.ensure("cbthrows")).resolves.toBeDefined();
  });

  it("㉒（I5）意外异常兜底路径上回调也抛 → 同样不传导", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-cbthrows2", state: "running", labels: { "mrotto.workspace": "cbthrows2" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ cloneStreamError: true }), execLog, nameOf(containers));
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
      onCloneOutcome: () => {
        throw new Error("simulated store.append failure (disk full)");
      },
    });

    await expect(sandbox.ensure("cbthrows2")).resolves.toBeDefined();
  });

  it("㉔（M8）每条 exec 都带 WorkingDir=/work，且各自套了 timeout（clone 600s，其余默认 30s）", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-timeouts", state: "running", labels: { "mrotto.workspace": "timeouts" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter(), execLog, nameOf(containers));
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git", pat: "p" }),
    });

    await sandbox.ensure("timeouts");

    expect(execLog.length).toBeGreaterThan(0);
    for (const rec of execLog) {
      expect(rec.workingDir).toBe("/work");
      expect(rec.cmd.slice(0, 2)).toEqual(["/usr/bin/timeout", "-k"]);
      const secs = rec.cmd[3];
      expect(secs).toBe(rec.cmd.join(" ").includes("git clone --") ? "600" : "30");
    }
  });

  it("㉕（M8）clone 超时（exitCode 124）→ reason 带「命令超时」友好文案", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-timeout", state: "running", labels: { "mrotto.workspace": "timeout" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ cloneExit: 124 }), execLog, nameOf(containers));
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    await sandbox.ensure("timeout");

    expect((outcomes[0] as { reason: string }).reason).toContain("命令超时");
  });

  it("㉖（复审二轮防患）探测脚本里 safe.directory 在 rev-parse 之前", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-safedir", state: "running", labels: { "mrotto.workspace": "safedir" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter(), execLog, nameOf(containers));
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
    });

    await sandbox.ensure("safedir");

    const probe = execLog[0]!.cmd.join(" ");
    expect(probe.indexOf("safe.directory /work")).toBeGreaterThanOrEqual(0);
    expect(probe.indexOf("safe.directory /work")).toBeLessThan(probe.indexOf("rev-parse HEAD"));
  });

  it("㉗（复审二轮竞态修复）clone 进行中调 invalidateClone——新 attempt 等旧的收尾才起步，不重叠", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-race2", state: "running", labels: { "mrotto.workspace": "race2" } },
    ]);
    const execLog: ExecLog = [];
    let releaseClone: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseClone = resolve;
    });
    const wrapped = withCloneExec(
      docker,
      (cmd) => {
        const script = cmd.join(" ");
        if (script.includes("state=repo")) return { exitCode: 0, stdout: "state=empty\n" };
        if (script.includes("git clone --")) return { exitCode: 0, gate };
        return { exitCode: 0, stdout: HUGE_DF };
      },
      execLog,
      nameOf(containers),
    );
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
    });

    const first = sandbox.ensure("race2");
    await waitUntil(() => execLog.some((c) => c.cmd.join(" ").includes("git clone --")));
    sandbox.invalidateClone("race2");
    const second = sandbox.ensure("race2");

    // 旧 attempt 还卡在 clone 上——新的一条 clone 都不该起。两层原因叠在
    // 一起，缺一条都不该放行：① ensure 去重（#835①）让这次调用直接并进
    // 上一次；② 就算绕过它，ensureRepoCloned 也要等旧 attempt settle
    expect(execLog.filter((c) => c.cmd.join(" ").includes("git clone --")).length).toBe(1);

    releaseClone!();
    await Promise.all([first, second]);
    // 合并进来的那次不会补跑——invalidateClone 的效力落在**下一次**
    // ensure 上，不是"当场再来一遍"。这条是 #835① 的去重与 invalidate
    // 的交互，写进断言免得下次有人以为是 bug：真正重要的是"改了配置之后
    // 总会有一次重新尝试"，而不是"必须是紧挨着的那一次调用"
    expect(execLog.filter((c) => c.cmd.join(" ").includes("git clone --")).length).toBe(1);

    await sandbox.ensure("race2");
    expect(execLog.filter((c) => c.cmd.join(" ").includes("git clone --")).length).toBe(2);
  });

  it("（#836）磁盘可用空间低于下限 → 不开始 clone，说明原因", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-nospace", state: "running", labels: { "mrotto.workspace": "nospace" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ dfStdout: "1048576\n" }), execLog, nameOf(containers)); // 1 GiB
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    await sandbox.ensure("nospace");

    expect(execLog.some((c) => c.cmd.join(" ").includes("git clone --"))).toBe(false);
    expect(execLog.some((c) => c.cmd.join(" ").includes("find /work"))).toBe(false); // 空间不够时连清都别清
    expect(outcomes[0]!.kind).toBe("failed");
    expect((outcomes[0] as { reason: string }).reason).toContain("可用空间不足");
  });

  it("（#836）df 读不出数字（输出格式不认识）→ 放行，不因为一个猜不出来就拒绝 clone", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-weirddf", state: "running", labels: { "mrotto.workspace": "weirddf" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ dfStdout: "Avail\n" }), execLog, nameOf(containers));
    const outcomes: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
      onCloneOutcome: (_w, o) => outcomes.push(o),
    });

    await sandbox.ensure("weirddf");

    expect(outcomes[0]!.kind).toBe("cloned");
  });

  it("（#835）clone 命令带 GIT_TERMINAL_PROMPT=0——私有仓库没配 PAT 时明确失败，不靠环境碰运气", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-noprompt", state: "running", labels: { "mrotto.workspace": "noprompt" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter(), execLog, nameOf(containers));
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
    });

    await sandbox.ensure("noprompt");

    const clone = execLog.find((c) => c.cmd.join(" ").includes("git clone --"));
    expect(clone!.cmd.join(" ")).toContain("GIT_TERMINAL_PROMPT=0");
  });

  it("（#835②）reconcile 删掉容器+卷之后，同一个 workspaceId 再被 ensure → 重新 clone，不吃旧缓存", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-gone", state: "running", labels: { "mrotto.workspace": "gone" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter(), execLog, nameOf(containers));
    let clock = 1000;
    const sandbox = createSandbox(wrapped, {
      now: () => clock,
      orphanGraceMs: 10,
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/widgets.git" }),
    });

    await sandbox.ensure("gone");
    expect(execLog.filter((c) => c.cmd.join(" ").includes("git clone --")).length).toBe(1);

    await sandbox.reconcile(new Set()); // 首见孤儿：只标记
    clock += 1000;
    const { removed } = await sandbox.reconcile(new Set()); // 过 grace：真删
    expect(removed).toContain("gone");

    await sandbox.ensure("gone"); // 崭新的空容器
    expect(execLog.filter((c) => c.cmd.join(" ").includes("git clone --")).length).toBe(2);
  });

  it("（#835⑤）reconcile 收走漏在机器上的一次性 clone 容器（里面有 PAT），不等 7 天孤儿宽限", async () => {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-live", state: "running", labels: { "mrotto.workspace": "live" } },
      // 上一次 daemon 被杀时漏下的那台
      { id: "c9", name: "otto-clone-live-abc-1", state: "running", labels: { "mrotto.clone": "live" } },
    ]);
    const sandbox = createSandbox(docker);

    await sandbox.reconcile(new Set(["live"]));

    expect([...containers.values()].some((c) => c.name.startsWith("otto-clone-"))).toBe(false);
    expect([...containers.values()].some((c) => c.name === "otto-ws-live")).toBe(true);
  });
});

/** 复审三轮：UI 侧"检测 repoUrl 里有没有藏凭据"这条路已经被绕过三次
    （全角 ＠ U+FF20、11 层以上嵌套 percent 编码），说明输入校验做不完美，
    安全边界必须搬到输出侧——`safeRepoLabel` 就是那道边界：只用 WHATWG URL
    解析器**自己**给出的 protocol+host+pathname 拼展示串，从不读取
    username/password 字段，解析失败一律退化成不含任何原始片段的「仓库」。
    这里把 UI 侧三轮复审找到的绕过形态全部喂一遍，加上标准 userinfo 语法
    和一些边界情况，断言输出里都不含 token 子串。 */
describe("safeRepoLabel（issue #821 复审三轮：repoUrl 里可能藏凭据，输出侧脱敏）", () => {
  const TOKEN = "ghp_supersecrettoken1234";

  /** 手搓一段"N 层嵌套 percent 编码"的 @——每多一层，就把上一层结果里的
      每个 % 再编码成 %25 一次（对应"把上一层的密文当明文再加密一遍"这个
      直觉）。11 层对应复审提到的"11 层以上嵌套 percent 编码"这个具体
      花样，不是随便选的层数。 */
  function nestedPercentEncodedAt(layers: number): string {
    let result = encodeURIComponent("@"); // 第 1 层：@ → %40
    for (let i = 1; i < layers; i++) result = result.replace(/%/g, "%25");
    return result;
  }

  it("干净的 URL（没有 userinfo）——protocol+host+path 原样展示", () => {
    expect(safeRepoLabel("https://github.com/acme/widgets.git")).toBe("https://github.com/acme/widgets.git");
  });

  it("标准 userinfo 语法（user:pass@host）——username/password 都被抹掉", () => {
    const label = safeRepoLabel(`https://user:${TOKEN}@github.com/acme/widgets.git`);
    expect(label).not.toContain(TOKEN);
    expect(label).not.toContain("user");
    expect(label).toBe("https://github.com/acme/widgets.git");
  });

  it("只有 username 没有 password（token-as-username，GitHub PAT 常见写法）——同样被抹掉", () => {
    const label = safeRepoLabel(`https://${TOKEN}@github.com/acme/widgets.git`);
    expect(label).not.toContain(TOKEN);
    expect(label).toBe("https://github.com/acme/widgets.git");
  });

  it("host 为空（file:// 之类没有 host 的合法 URL）——退化成「仓库」", () => {
    expect(safeRepoLabel("file:///etc/passwd")).toBe("仓库");
  });

  it("完全解析不出来的字符串——退化成「仓库」，不回显任何原始片段", () => {
    expect(safeRepoLabel("not a url at all")).toBe("仓库");
  });

  // ── UI 侧复审三轮找到的绕过形态：逐条喂给 safeRepoLabel，只断言"输出
  // 不含 token 子串"——不要求每条都精确落在哪个分支（有的会解析失败退化
  // 成「仓库」，有的可能解析成功但 token 只出现在 username/password 里
  // 一样被排除），因为这正是"不用逐个识别绕过花样"这个设计目标要验的事。
  const bypassForms: Array<[string, string]> = [
    ["全角 ＠（U+FF20）代替 ASCII @，无冒号（模拟 scp 语法混进 https URL）", `https://user${TOKEN}＠github.com/acme/widgets.git`],
    ["全角 ＠（U+FF20）代替 ASCII @，带冒号", `https://user:${TOKEN}＠github.com/acme/widgets.git`],
    ["11 层以上嵌套 percent 编码的 @", `https://user:${TOKEN}${nestedPercentEncodedAt(11)}github.com/acme/widgets.git`],
    ["scp 语法（user@host:path）", `git@github.com:acme/${TOKEN}.git`],
    ["protocol-relative（//host/path，没有 scheme）", `//github.com/${TOKEN}/widgets.git`],
    ["纯垃圾字符串里混了 token", `not a url, just ${TOKEN} sitting here`],
  ];

  for (const [label, url] of bypassForms) {
    it(`绕过形态——${label}——输出不含 token 子串`, () => {
      expect(safeRepoLabel(url)).not.toContain(TOKEN);
    });
  }
});

describe("createSandbox — clone 结果的端到端脱敏（issue #821 复审三轮）", () => {
  it("repoUrl 本身嵌了凭据（userinfo 语法，没有单独配 pat）——clone 成功时 onCloneOutcome 收到的 repoUrl 不含 token", async () => {
    const TOKEN = "ghp_endtoend_success_token";
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-embedcred-ok", state: "running", labels: { "mrotto.workspace": "embedcred-ok" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter({ cloneExit: 0 }), execLog);
    const results: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      // 没有单独的 pat 字段——凭据整个嵌在 repoUrl 里，正是这一轮要堵的口子
      repoConfig: async () => ({ repoUrl: `https://x:${TOKEN}@github.com/acme/widgets.git` }),
      onCloneOutcome: (_workspaceId, outcome) => results.push(outcome),
    });

    await sandbox.ensure("embedcred-ok");

    expect(results.length).toBe(1);
    expect(results[0]!.kind).toBe("cloned");
    expect(results[0]!.repoUrl).not.toContain(TOKEN);
    expect(results[0]!.repoUrl).toBe("https://github.com/acme/widgets.git");
    // Cmd 数组本来就不该含 URL 里的凭据（clone 用的是原样 repoUrl，这条
    // 断言确认"原样"不等于"把 userinfo 也原样喂给 shell"——shellQuote
    // 只是转义，不会主动剥凭据，token 仍然会出现在 Cmd 里（这是预期行为：
    // git 需要这条完整 URL 才能真的认证），这条测试只保证它不出现在
    // onCloneOutcome 的 repoUrl 里
    expect(results[0]!.repoUrl).not.toContain("x:");
  });

  it("repoUrl 嵌了凭据 + git clone 失败时把整条 URL 回显进 stderr——reason 里也不含 token", async () => {
    const TOKEN = "ghp_endtoend_fail_token";
    const rawUrl = `https://x:${TOKEN}@github.com/acme/does-not-exist.git`;
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-embedcred-fail", state: "running", labels: { "mrotto.workspace": "embedcred-fail" } },
    ]);
    const execLog: ExecLog = [];
    // 模拟 git 的真实行为：clone 失败时把它当时用的那条 URL（含凭据）
    // 原样回显进 stderr——这正是 sanitizeCloneText 要接住的情形
    const wrapped = withCloneExec(
      docker,
      cloneRouter({
                cloneExit: 128,
        cloneStderr: `fatal: unable to access '${rawUrl}/': The requested URL returned error: 403`,
      }),
      execLog,
    );
    const results: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: rawUrl }),
      onCloneOutcome: (_workspaceId, outcome) => results.push(outcome),
    });

    await sandbox.ensure("embedcred-fail");

    expect(results.length).toBe(1);
    expect(results[0]!.kind).toBe("failed");
    expect(results[0]!.repoUrl).not.toContain(TOKEN);
    expect((results[0] as { reason?: string }).reason).toBeDefined();
    expect((results[0] as { reason?: string }).reason).not.toContain(TOKEN);
    // sanitizeCloneText 应该把整条原样 URL 换成安全标签，而不只是抠掉
    // token 子串——顺带确认这一点（reason 里不该有原样 rawUrl）
    expect((results[0] as { reason?: string }).reason).not.toContain(rawUrl);
  });

  it("repoUrl 用绕过 UI 检测的全角 ＠ 编码嵌了凭据——clone 失败时 repoUrl/reason 都不含 token", async () => {
    const TOKEN = "ghp_fullwidth_bypass_token";
    // 全角 ＠ 会让 new URL(...) 直接抛异常（已在实现里验证过）——这条
    // 测试模拟"UI 检测被绕过、这串字符串就这样一路传到了 runtime"的情形
    const rawUrl = `https://x${TOKEN}＠github.com/acme/widgets.git`;
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-fullwidth-e2e", state: "running", labels: { "mrotto.workspace": "fullwidth-e2e" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ cloneExit: 128, cloneStderr: `fatal: unable to access '${rawUrl}/'` }),
      execLog,
    );
    const results: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: rawUrl }),
      onCloneOutcome: (_workspaceId, outcome) => results.push(outcome),
    });

    await sandbox.ensure("fullwidth-e2e");

    expect(results.length).toBe(1);
    expect(results[0]!.repoUrl).not.toContain(TOKEN);
    expect(results[0]!.repoUrl).toBe("仓库"); // 解析失败——safeRepoLabel 的通用退化文案
    expect((results[0] as { reason?: string }).reason).not.toContain(TOKEN);
  });

  it("repoUrl 解析失败时的内部错误消息（safeHostOf 抛出）不回显原始 repoUrl", async () => {
    // repoUrl 解析不出来 + 配了 pat（走 safeHostOf 那条路）——用一个
    // new URL() 也解析不了的字符串
    const TOKEN = "ghp_safehostof_token";
    const rawUrl = `not-a-valid-url-with-${TOKEN}`;
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-safehostof", state: "running", labels: { "mrotto.workspace": "safehostof" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter(), execLog);
    const results: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: rawUrl, pat: "ghp_separate_pat" }),
      onCloneOutcome: (_workspaceId, outcome) => results.push(outcome),
    });

    await sandbox.ensure("safehostof");

    expect(results.length).toBe(1);
    expect(results[0]!.kind).toBe("failed");
    expect(results[0]!.repoUrl).not.toContain(TOKEN);
    expect((results[0] as { reason?: string }).reason).not.toContain(TOKEN);
    expect((results[0] as { reason?: string }).reason).not.toContain(rawUrl);
  });

  // ── 复审四轮：reason 通道单独还漏（同一文件第二条出境通道）───────────
  // 上面几条测试证明了 repoUrl 字段和"stderr 原样回显整条 URL"这个情形
  // 下 reason 字段的安全性，但漏了一类更刁钻的情形：repoUrl 解析失败
  // （fail-closed 分支该接管的时候），git（或它调用的 ssh）在报错前会
  // **改写**这条 URL 再回显——百分号编码非 ASCII 字符、解码已有的 %XX、
  // 或者只回显 user@host 这一小段——改写后的文本跟原始 cfg.repoUrl 逐字
  // 比对不上，旧版 sanitizeCloneText 的"整条子串替换"直接落空，SECRET
  // 就从 reason 漏出去了。这里把复审实测出的 3 个真实案例原样搬进来。
  it("（复审四轮①）全角 ＠ 解析失败 + git 把 ＠ 百分号编码后回显——reason 不含 SECRET", async () => {
    const SECRET = "ghp_fourthround_fullwidth_secret";
    const rawUrl = `https://user${SECRET}＠github.com/acme/widgets.git`;
    // 模拟 git 在报错前把非 ASCII 的全角 ＠（UTF-8 是 EF BC A0）百分号
    // 编码后再回显——这条字符串跟 rawUrl 逐字对不上，正是漏洞成因
    const gitEcho = `fatal: unable to access 'https://user${SECRET}%EF%BC%A0github.com/acme/widgets.git/': Failed to connect`;
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-r4-fullwidth", state: "running", labels: { "mrotto.workspace": "r4-fullwidth" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ cloneExit: 128, cloneStderr: gitEcho }),
      execLog,
    );
    const results: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: rawUrl }),
      onCloneOutcome: (_workspaceId, outcome) => results.push(outcome),
    });

    await sandbox.ensure("r4-fullwidth");

    expect(results.length).toBe(1);
    expect(results[0]!.repoUrl).not.toContain(SECRET);
    expect((results[0] as { reason?: string }).reason).toBeDefined();
    expect((results[0] as { reason?: string }).reason).not.toContain(SECRET);
    // fail-closed：整条改写成固定文案，不放行 git 的自由文本
    expect((results[0] as { reason?: string }).reason).toBe("（错误详情已省略：仓库地址无法解析，可能含凭据）");
  });

  it("（复审四轮②）scp 语法解析失败 + ssh 只回显 user@host 片段——reason 不含 SECRET", async () => {
    const SECRET = "ghp_fourthround_scp_secret";
    const rawUrl = `${SECRET}@github.com:acme/widgets.git`; // scp 语法，SECRET 冒充 git 用户名
    // ssh 失败时经常只回显 user@host 这一小段，不包含冒号后面的 path——
    // 这段片段跟完整的 rawUrl 逐字对不上
    const gitEcho = `ssh: connect to host github.com port 22: Permission denied (publickey) for ${SECRET}@github.com`;
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-r4-scp", state: "running", labels: { "mrotto.workspace": "r4-scp" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ cloneExit: 128, cloneStderr: gitEcho }),
      execLog,
    );
    const results: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: rawUrl }),
      onCloneOutcome: (_workspaceId, outcome) => results.push(outcome),
    });

    await sandbox.ensure("r4-scp");

    expect(results.length).toBe(1);
    expect(results[0]!.repoUrl).not.toContain(SECRET);
    expect((results[0] as { reason?: string }).reason).not.toContain(SECRET);
    expect((results[0] as { reason?: string }).reason).toBe("（错误详情已省略：仓库地址无法解析，可能含凭据）");
  });

  it("（复审四轮③）%40 解析失败 + git 解码后回显——reason 不含 SECRET", async () => {
    const SECRET = "ghp_fourthround_percent40_secret";
    const rawUrl = `https://user:${SECRET}%40github.com/acme/widgets.git`; // 单层 %40，new URL() 拒绝
    // git 在报错前把 %40 解码成字面 @ 再回显——解码后的文本跟原样保留
    // %40 的 rawUrl 逐字对不上
    const gitEcho = `fatal: unable to access 'https://user:${SECRET}@github.com/acme/widgets.git/': The requested URL returned error: 403`;
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-r4-percent40", state: "running", labels: { "mrotto.workspace": "r4-percent40" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ cloneExit: 128, cloneStderr: gitEcho }),
      execLog,
    );
    const results: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: rawUrl }),
      onCloneOutcome: (_workspaceId, outcome) => results.push(outcome),
    });

    await sandbox.ensure("r4-percent40");

    expect(results.length).toBe(1);
    expect(results[0]!.repoUrl).not.toContain(SECRET);
    expect((results[0] as { reason?: string }).reason).not.toContain(SECRET);
    expect((results[0] as { reason?: string }).reason).toBe("（错误详情已省略：仓库地址无法解析，可能含凭据）");
  });

  it("（复审四轮，正常路径不受影响）repoUrl 能正常解析时，clone 失败的排错信息照旧透传", async () => {
    const { docker } = makeFakeDocker([
      { id: "c1", name: "otto-ws-r4-normal", state: "running", labels: { "mrotto.workspace": "r4-normal" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(
      docker,
      cloneRouter({ cloneExit: 128, cloneStderr: "fatal: repository not found" }),
      execLog,
    );
    const results: CloneOutcome[] = [];
    const sandbox = createSandbox(wrapped, {
      repoConfig: async () => ({ repoUrl: "https://github.com/acme/does-not-exist.git" }), // 干净的、能正常解析的 URL
      onCloneOutcome: (_workspaceId, outcome) => results.push(outcome),
    });

    await sandbox.ensure("r4-normal");

    expect(results.length).toBe(1);
    // 能解析的正常路径不受 fail-closed 影响——排错信息照旧，不是固定文案
    expect((results[0] as { reason?: string }).reason).toContain("repository not found");
    expect((results[0] as { reason?: string }).reason).not.toBe("（错误详情已省略：仓库地址无法解析，可能含凭据）");
  });
});

/** 决策表本身（issue #832）——纯函数，不经 docker。上面那批 e2e 测的是
    "接线对不对"，这一批测的是"判据本身对不对"：一张表能不能一眼看全，
    正是把它从 performClone 里抽出来的理由。 */
describe("parseWorkState / decideCloneAction / sameRepo（issue #832 决策表）", () => {
  const URL_A = "https://github.com/acme/widgets.git";
  const URL_B = "https://github.com/acme/other.git";

  it("parseWorkState：三种简单态", () => {
    expect(parseWorkState("state=empty\n")).toEqual({ kind: "empty" });
    expect(parseWorkState("state=foreign\n")).toEqual({ kind: "foreign" });
    expect(parseWorkState("state=partial\n")).toEqual({ kind: "partial" });
  });

  it("parseWorkState：repo 态带 origin/dirty/ahead", () => {
    expect(parseWorkState(`state=repo\norigin=${URL_A}\ndirty=0\nahead=0\n`)).toEqual({
      kind: "repo",
      origin: URL_A,
      dirty: false,
      ahead: false,
    });
    expect(parseWorkState(`state=repo\norigin=${URL_A}\ndirty=1\nahead=2\n`)).toMatchObject({
      dirty: true,
      ahead: true,
    });
  });

  it("parseWorkState：ahead=unknown（没有 upstream）算「有本地领先提交」——拿不准按最坏情况", () => {
    expect(parseWorkState(`state=repo\norigin=${URL_A}\ndirty=0\nahead=unknown\n`)).toMatchObject({ ahead: true });
    // 字段整个缺席也一样
    expect(parseWorkState(`state=repo\norigin=${URL_A}\n`)).toMatchObject({ ahead: true, dirty: true });
  });

  it("parseWorkState：认不出的输出 → unknown，不退化成任何一态", () => {
    expect(parseWorkState("").kind).toBe("unknown");
    expect(parseWorkState("bash: git: command not found\n").kind).toBe("unknown");
  });

  it("sameRepo：结尾 .git / 斜杠 / host 大小写 都算同一个仓库", () => {
    expect(sameRepo("https://github.com/acme/widgets.git", "https://github.com/acme/widgets")).toBe(true);
    expect(sameRepo("https://GitHub.com/acme/widgets", "https://github.com/acme/widgets/")).toBe(true);
    expect(sameRepo("https://github.com/acme/widgets", "https://github.com/acme/other")).toBe(false);
  });

  it("sameRepo：origin 里带凭据（当初就是这么 clone 的）不影响判定——否则会白清空一次", () => {
    expect(sameRepo("https://x:ghp_tok@github.com/acme/widgets.git", "https://github.com/acme/widgets.git")).toBe(true);
  });

  it("sameRepo：空 origin（手工 git init、没有 remote）不算同一个仓库", () => {
    expect(sameRepo("", "https://github.com/acme/widgets.git")).toBe(false);
  });

  it("decideCloneAction：整张表", () => {
    expect(decideCloneAction({ kind: "empty" }, URL_A)).toEqual({ action: "clone" });
    expect(decideCloneAction({ kind: "partial" }, URL_A)).toEqual({ action: "clone" });
    expect(decideCloneAction({ kind: "foreign" }, URL_A).action).toBe("refuse");
    expect(decideCloneAction({ kind: "unknown", detail: "boom" }, URL_A).action).toBe("refuse");
    expect(decideCloneAction({ kind: "repo", origin: URL_A, dirty: false, ahead: false }, URL_A)).toEqual({
      action: "skip",
    });
    expect(decideCloneAction({ kind: "repo", origin: URL_B, dirty: true, ahead: false }, URL_A).action).toBe("refuse");
    expect(decideCloneAction({ kind: "repo", origin: URL_B, dirty: false, ahead: true }, URL_A).action).toBe("refuse");
    expect(decideCloneAction({ kind: "repo", origin: URL_B, dirty: false, ahead: false }, URL_A)).toEqual({
      action: "switch",
      from: URL_B,
    });
  });

  it("decideCloneAction：同一个仓库时 dirty/ahead 一律不拦——本来就不动它", () => {
    expect(decideCloneAction({ kind: "repo", origin: URL_A, dirty: true, ahead: true }, URL_A)).toEqual({
      action: "skip",
    });
  });

  it("decideCloneAction：换仓库被拒时，理由里的旧仓库地址已经脱敏（origin 可能带凭据）", () => {
    const TOKEN = "ghp_origin_embedded_token";
    const decision = decideCloneAction(
      { kind: "repo", origin: `https://x:${TOKEN}@github.com/acme/old.git`, dirty: true, ahead: false },
      URL_A,
    );
    expect(decision.action).toBe("refuse");
    expect((decision as { reason: string }).reason).not.toContain(TOKEN);
  });

  it("cloneOutcomeText：每个 kind 都有一句人话，且不吞掉 reason", () => {
    expect(cloneOutcomeText({ kind: "cloned", repoUrl: URL_A })).toContain(URL_A);
    expect(cloneOutcomeText({ kind: "switched", repoUrl: URL_A, from: URL_B })).toContain(URL_B);
    expect(cloneOutcomeText({ kind: "skipped", repoUrl: URL_A })).toContain("已经是");
    expect(cloneOutcomeText({ kind: "refused", repoUrl: URL_A, reason: "因为某某" })).toContain("因为某某");
    expect(cloneOutcomeText({ kind: "failed", repoUrl: URL_A, reason: "403" })).toContain("403");
  });
});
