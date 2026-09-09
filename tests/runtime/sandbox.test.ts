import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  cloneWithSidecar,
  createSandbox,
  safeRepoLabel,
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

/** 决策表本身（issue #832）——纯函数，不经 docker。上面那批 e2e 测的是
    "接线对不对"，这一批测的是"判据本身对不对"：一张表能不能一眼看全，
    正是把它从 performClone 里抽出来的理由。 */
// ── 容器已经在跑时 dockerode 的 304（issue #1097）────────────────────────
// `findByName` 回的 `State` 是 list 那一刻的快照。这一页展开着几层就同时发几条
// `files` 帧（「刷新」更是一次全发），它们都看到 stopped、都去 start()，赢的
// 那条把容器拉起来，输的那条拿 `(HTTP code 304) container already started` 抛
// 出去——真机日志里就是这一行，症状是「文件」tab 读不出内容且看着像随机。

/** 让 start() 按 dockerode 的形状抛（`statusCode` 由 docker-modem 的
    `buildPayload` 挂上，见 modem.js:395），并保持 state 不变——304 的语义是
    「别人已经把它起起来了」，所以状态照样得是 running */
function withStartError(docker: DockerLike, err: Error, containers: Map<string, FakeContainer>): DockerLike {
  return {
    ...docker,
    getContainer(id: string) {
      const base = docker.getContainer(id);
      return {
        ...base,
        start: async () => {
          const c = containers.get(id);
          if (c) c.state = "running"; // 赢下竞态的那条帧干的事
          throw err;
        },
      };
    },
  };
}

function code304(): Error {
  return Object.assign(new Error("(HTTP code 304) container already started - "), { statusCode: 304 });
}

/** 一层目录的 stdout：header 行 + NUL 收尾的记录（字段顺序见 workFiles.ts 的
    parseEntries，名字放最后因为文件名里换行和制表符都合法） */
const DIR_STDOUT = "dir\n" + "f\t12\t1757300000\tmenu.md\0" + "d\t0\t1757300000\tmarketing\0";

describe("createSandbox — 容器已经在跑时的 304（issue #1097）", () => {
  const stopped = () => [{ id: "c1", name: "otto-ws-ws1", state: "exited", labels: { "mrotto.workspace": "ws1" } }];

  it("readWork：start() 抛 304 = 别人已经起好了，照常读出内容，不当失败", async () => {
    const { docker, containers } = makeFakeDocker(stopped());
    const execLog: ExecLog = [];
    const withExec = withCloneExec(docker, () => ({ exitCode: 0, stdout: DIR_STDOUT }), execLog, nameOf(containers));
    const sandbox = createSandbox(withStartError(withExec, code304(), containers));

    const node = await sandbox.readWork("ws1", "");

    expect(node.kind).toBe("dir");
    // 目录排在文件前面（排序在 workFiles.ts 那一侧，这里只是照它写）
    expect(node.kind === "dir" && node.entries.map((e) => e.name)).toEqual(["marketing", "menu.md"]);
  });

  it("searchWork：同一条路，304 不该把搜索打成失败", async () => {
    const { docker, containers } = makeFakeDocker(stopped());
    const execLog: ExecLog = [];
    const withExec = withCloneExec(docker, () => ({ exitCode: 0, stdout: "files\t0\n" }), execLog, nameOf(containers));
    const sandbox = createSandbox(withStartError(withExec, code304(), containers));

    await expect(sandbox.searchWork("ws1", "奶茶", false)).resolves.toEqual([]);
  });

  it("ensure：同上——两条会话同时起 turn 撞得上同一个竞态", async () => {
    const { docker, containers } = makeFakeDocker(stopped());
    const execLog: ExecLog = [];
    const withExec = withCloneExec(docker, () => ({ exitCode: 0, stdout: "" }), execLog, nameOf(containers));
    const sandbox = createSandbox(withStartError(withExec, code304(), containers));

    await expect(sandbox.ensure("ws1")).resolves.toBeDefined();
  });

  it("304 之外的 start 失败照旧抛出去 —— 镜像没了/磁盘满了不许被吞掉", async () => {
    const { docker, containers } = makeFakeDocker(stopped());
    const execLog: ExecLog = [];
    const withExec = withCloneExec(docker, () => ({ exitCode: 0, stdout: DIR_STDOUT }), execLog, nameOf(containers));
    const boom = Object.assign(new Error("(HTTP code 500) server error - no space left on device"), { statusCode: 500 });
    const sandbox = createSandbox(withStartError(withExec, boom, containers));

    await expect(sandbox.readWork("ws1", "")).rejects.toThrow("no space left on device");
  });

  it("列表说它已经在跑时压根不 start —— 少打一次 docker 往返", async () => {
    const running = [{ id: "c1", name: "otto-ws-ws1", state: "running", labels: { "mrotto.workspace": "ws1" } }];
    const { docker, containers, calls } = makeFakeDocker(running);
    const execLog: ExecLog = [];
    const withExec = withCloneExec(docker, () => ({ exitCode: 0, stdout: DIR_STDOUT }), execLog, nameOf(containers));
    const sandbox = createSandbox(withExec);

    await sandbox.readWork("ws1", "");

    expect(calls.filter((c) => c.startsWith("start:"))).toEqual([]);
  });
});

// ── 凭据不进水獭那台容器（ADR-0200 决策②）────────────────────────────────
// #1102 把 clone 从 `ensure()` 的副作用摘成显式入口 `cloneWithSidecar`，原来
// 那批经 `ensure()` 驱动的用例跟着被测机制一起走了（决策表、幂等缓存、
// invalidateClone —— 那些机制本身没了）。**这一组是没走的那半**：它守的不是
// 「什么时候 clone」，而是「clone 的时候凭据在哪儿」，而那条不变量一个字都没变。
//
// 它们现在直接打 `cloneWithSidecar`，不再绕 `ensure()`——片 4（#1105）的
// `clone_repo` 工具调的就是这个入口，所以这组用例覆盖的正是产品路径。

describe("cloneWithSidecar —— 凭据只在一次性旁路容器里（#1102）", () => {
  const REPO = "https://github.com/acme/widgets.git";

  function setup(routerOverrides: Parameters<typeof cloneRouter>[0] = {}) {
    const { docker, containers } = makeFakeDocker([
      { id: "c1", name: "otto-ws-w1", state: "running", labels: { "mrotto.workspace": "w1" } },
    ]);
    const execLog: ExecLog = [];
    const wrapped = withCloneExec(docker, cloneRouter(routerOverrides), execLog, nameOf(containers));
    return { docker: wrapped, containers, execLog };
  }

  const run = (docker: DockerLike, cfg: { repoUrl: string; pat?: string }) =>
    cloneWithSidecar({ docker, workspaceId: "w1", containerName: "otto-clone-w1-1" }, cfg);

  it("PAT 经 stdin 传入，Cmd 数组里一个字都没有", async () => {
    const PAT = "ghp_secret_token_value";
    const { docker, execLog } = setup();

    expect(await run(docker, { repoUrl: REPO, pat: PAT })).toEqual({ ok: true });

    const clone = execLog.find((c) => c.cmd.join(" ").includes("git clone --"));
    expect(clone).toBeDefined();
    expect(clone!.cmd.join(" ")).not.toContain(PAT);
    // 浅克隆（issue #836）：一个仓库最容易失控的部分是历史不是工作树，而卷没有
    // 磁盘上限。水獭要历史时自己 `git fetch --unshallow`
    expect(clone!.cmd.join(" ")).toContain("--depth 1");

    const approve = execLog.find((c) => c.cmd.join(" ").includes("git credential approve"));
    expect(approve).toBeDefined();
    expect(approve!.cmd.join(" ")).not.toContain(PAT);
    expect(approve!.stdin).toContain(`password=${PAT}`);
  });

  it("凭据相关的 exec 一条都没落在水獭那台容器上", async () => {
    const PAT = "ghp_never_in_workspace_container";
    const { docker, execLog } = setup();

    await run(docker, { repoUrl: REPO, pat: PAT });

    // 水獭那台容器（otto-ws-w1）上一条 exec 都不该有——整个 clone 在旁路容器里
    expect(execLog.filter((c) => c.containerName === "otto-ws-w1")).toEqual([]);
    const credential = execLog.filter((c) => c.cmd.join(" ").includes("git credential approve"));
    expect(credential.length).toBe(1);
    expect(credential[0]!.containerName).toBe("otto-clone-w1-1");
    for (const rec of execLog) expect(rec.cmd.join(" ")).not.toContain(PAT);
  });

  it("旁路容器挂同一个卷 + 打 mrotto.clone 标签，跑完被 remove(force)", async () => {
    const { docker, containers } = setup();
    const calls: string[] = [];
    const spied: DockerLike = {
      ...docker,
      createContainer: async (opts) => {
        calls.push(JSON.stringify(opts));
        return docker.createContainer(opts);
      },
    };

    await run(spied, { repoUrl: REPO });

    const args = JSON.parse(calls[0]!) as Record<string, unknown>;
    expect(args["name"]).toBe("otto-clone-w1-1");
    expect(args["Labels"]).toMatchObject({ "mrotto.clone": "w1" });
    expect(JSON.stringify(args["HostConfig"])).toContain("otto-ws-w1"); // 同一个卷
    // 跑完不该留下任何 otto-clone-*
    expect([...containers.values()].some((c) => c.name.startsWith("otto-clone-"))).toBe(false);
  });

  it("clone 失败时旁路容器照样被删 —— 残骸里有 PAT，绝不能留", async () => {
    const { docker, containers } = setup({ cloneExit: 128, cloneStderr: "fatal: repository not found" });

    const r = await run(docker, { repoUrl: REPO, pat: "ghp_x" });

    expect(r.ok).toBe(false);
    expect([...containers.values()].some((c) => c.name.startsWith("otto-clone-"))).toBe(false);
  });

  it("失败原因过脱敏 —— repoUrl 里用 userinfo 藏的凭据不许出现在 reason 里", async () => {
    const SECRET = "ghp_hidden_in_url";
    const { docker } = setup({
      cloneExit: 128,
      // git 经常把整条命令原样回显进 stderr，这正是 sanitizeCloneText 存在的理由
      cloneStderr: `fatal: could not read from 'https://x-access-token:${SECRET}@github.com/acme/widgets.git'`,
    });

    const r = await run(docker, { repoUrl: `https://x-access-token:${SECRET}@github.com/acme/widgets.git` });

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).not.toContain(SECRET);
  });

  it("没配 PAT 时带 GIT_TERMINAL_PROMPT=0 —— 私有仓库明确失败，不靠环境碰运气", async () => {
    const { docker, execLog } = setup();

    await run(docker, { repoUrl: REPO });

    const clone = execLog.find((c) => c.cmd.join(" ").includes("git clone --"));
    expect(clone!.cmd.join(" ")).toContain("GIT_TERMINAL_PROMPT=0");
    // 没有 pat 就不该有 credential approve 这一步
    expect(execLog.some((c) => c.cmd.join(" ").includes("git credential approve"))).toBe(false);
  });

  it("磁盘可用空间低于下限 → 不开始 clone，说明原因（#836）", async () => {
    const { docker, execLog } = setup({ dfStdout: "1024\n" }); // 1 MiB

    const r = await run(docker, { repoUrl: REPO });

    expect(r.ok).toBe(false);
    expect(execLog.some((c) => c.cmd.join(" ").includes("git clone --"))).toBe(false);
  });

  it("df 读不出数字 → 放行，不因为一个猜不出来就拒绝 clone（#836）", async () => {
    const { docker, execLog } = setup({ dfStdout: "Filesystem  1024-blocks\n" });

    expect(await run(docker, { repoUrl: REPO })).toEqual({ ok: true });
    expect(execLog.some((c) => c.cmd.join(" ").includes("git clone --"))).toBe(true);
  });
});

describe("isRunning（#1140，spec §3.3）", () => {
  it("容器 running → true；exited / 不存在 → false；只 list 不 start", async () => {
    const running = makeFakeDocker([{ id: "c1", name: "otto-ws-w1", state: "running", labels: { "mrotto.workspace": "w1" } }]);
    expect(await createSandbox(running.docker).isRunning("w1")).toBe(true);
    const stopped = makeFakeDocker([{ id: "c1", name: "otto-ws-w1", state: "exited", labels: { "mrotto.workspace": "w1" } }]);
    expect(await createSandbox(stopped.docker).isRunning("w1")).toBe(false);
    expect(await createSandbox(stopped.docker).isRunning("w2")).toBe(false);
    expect(stopped.calls.some((c) => c.startsWith("start"))).toBe(false);
  });
});
