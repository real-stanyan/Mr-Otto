// 沙箱编排 — 每工作区一容器一卷，dockerode 直管（ADR-0199）。
// 命名约定 `otto-ws-<workspaceId>`：容器名与卷名共用同一个字符串，
// ensure/destroy/reconcile 都靠它按名找容器，不额外维护一张 workspaceId→containerId 表。
//
// 孤儿回收两阶段：reconcile 第一次见到"标签里的 workspace 不在 validIds 里"的容器只记一笔
// markedTs（内存 + 注入的 orphans 存取器落盘），过 orphanGraceMs（默认 7 天）才真删——
// 宽限期是留给"workspace 记录还没同步过来"这种误判空间，不是立刻判死刑。

import { Writable } from "node:stream";
import type { ContainerLike } from "../../../src/world/dockerWorld.js";

/** dockerode 顶层句柄的最小注入面 */
export interface DockerLike {
  listContainers(opts: {
    all: boolean;
    filters: string;
  }): Promise<{ Id: string; Names: string[]; State: string; Labels: Record<string, string> }[]>;
  getContainer(id: string): {
    start(): Promise<void>;
    stop(): Promise<void>;
    remove(opts: { force: boolean }): Promise<void>;
    update(opts: Record<string, unknown>): Promise<void>;
  } & ContainerLike;
  createContainer(opts: Record<string, unknown>): Promise<{ id: string }>;
  listVolumes(opts: { filters: string }): Promise<{ Volumes: { Name: string; Labels: Record<string, string> | null }[] }>;
  getVolume(name: string): { remove(): Promise<void> };
}

/** 孤儿标记表的存取——测试给内存假货，daemon 给 `/var/lib/otto-runtime/orphans.json` 的文件版 */
export interface OrphansStore {
  load(): Record<string, number>;
  save(m: Record<string, number>): void;
}

export interface Sandbox {
  ensure(workspaceId: string): Promise<ContainerLike>;
  markActive(workspaceId: string): void; // 每条 turn 起跑时打点
  sweepIdle(runningWorkspaces: ReadonlySet<string>): Promise<string[]>; // 停掉的 workspaceId 列表；跑着 turn 的不停
  reconcile(validWorkspaceIds: ReadonlySet<string>): Promise<{ marked: string[]; removed: string[] }>;
  destroy(workspaceId: string): Promise<void>; // 容器+卷一起删（工作区删除级联）
}

/** owner 经 cs_config 发来的工作区云配置（issue #821 slice 1）——落点见
    daemon.ts 的 workspaceConfigStore，这里只描述 ensure() 消费它需要的形状 */
export interface WorkspaceRepoConfig {
  repoUrl: string;
  pat?: string;
}

/** 一次 clone 尝试的结局——ok:false 时 reason 已经过脱敏（见 redactPat），
    可以直接落日志/chat_message，不需要调用方再处理一遍 */
export type CloneResult = { ok: true; repoUrl: string } | { ok: false; repoUrl: string; reason: string };

const DEFAULT_IMAGE = "otto-sandbox";
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const WORKSPACE_LABEL = "mrotto.workspace";

function containerName(workspaceId: string): string {
  return `otto-ws-${workspaceId}`;
}

function memoryOrphansStore(): OrphansStore {
  let data: Record<string, number> = {};
  return {
    load: () => ({ ...data }),
    save: (m: Record<string, number>) => {
      data = { ...m };
    },
  };
}

// ── git clone（issue #821 slice 1）─────────────────────────────────────────
// 设计要点（对照 docs/superpowers/specs/2026-08-31-workspace-phase2-design.md:87
// 的原始设想，token 走 stdin 而不是原文说的"exec 传参"——容器里跑着 agent
// 自己的 bash，argv 会出现在 `ps aux` 里，等于把 PAT 摆在 agent 面前）：
//   1. PAT 只经 stdin 喂给 `git credential approve`；Cmd 数组、日志、
//      onCloneResult 的输出一律不含它（redactPat 兜底）。clone 本身用原样
//      的 https URL，不拼 token 进 URL。
//   2. clone 跑完（成功或失败）立刻 `git credential reject` + 删凭据文件 +
//      unset credential.helper——代价是 agent 之后不能 git push，本期
//      有意不做推送，是最小权限的取舍，不是漏做。
//   3. 幂等判据是容器内 `test -d /work/.git`（卷是持久的，容器被 reconcile
//      删掉重建也可能已经 clone 过）。
//   4. clone 失败绝不向上抛出——ensure() 永远正常返回容器，只是内容是空的。
//   5. 结果经 onCloneResult 回调通报，sandbox.ts 自己不做任何 console/IO。

/** git credential 协议要求 username 字段非空；PAT 场景下主流 provider
    （GitHub/GitLab/Bitbucket）不校验这个值本身、只认 password 里的
    token——固定占位符即可，不必问用户要真实用户名。用 GitHub Apps 同款
    惯例 "x-access-token"。 */
const CREDENTIAL_USERNAME = "x-access-token";
/** clone 的超时上限——大仓库真的可能要跑到接近这个数量级 */
const CLONE_TIMEOUT_SEC = 600;
const EXEC_INSPECT_MAX_ATTEMPTS = 5;
const EXEC_INSPECT_RETRY_DELAY_MS = 40;

/** 单引号包裹 + `'\''` 转义——同 src/world/dockerWorld.ts 的 shellQuote，
    但两个模块按分工不允许互相 import（本刀只能动 services/runtime/ 下的
    文件），故在此复制一份而不是导出那边的私有函数 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** 防御性脱敏：clone 流程设计上 PAT 从不进 URL/Cmd，理论上不会出现在任何
    stderr 里，但"理论上"不是保证——错误可能来自意料之外的路径。任何要
    对外暴露（onCloneResult/日志）的文本都过一遍这个函数再交出去 */
function redactPat(text: string, pat: string | undefined): string {
  if (!pat) return text;
  return text.split(pat).join("***");
}

/** git credential 协议的 host 字段——用 URL.host（含端口，如果有）而不是
    hostname：credential store 按这个字段匹配，得和 clone 用的 URL 对得上 */
function safeHostOf(repoUrl: string): string {
  try {
    return new URL(repoUrl).host;
  } catch {
    throw new Error(`repoUrl 不是合法 URL，无法配置凭据: ${repoUrl}`);
  }
}

async function inspectExecExitCode(exec: { inspect(): Promise<{ ExitCode: number | null }> }): Promise<number> {
  for (let attempt = 1; attempt <= EXEC_INSPECT_MAX_ATTEMPTS; attempt++) {
    const { ExitCode } = await exec.inspect();
    if (ExitCode !== null) return ExitCode;
    if (attempt < EXEC_INSPECT_MAX_ATTEMPTS) {
      await new Promise((res) => setTimeout(res, EXEC_INSPECT_RETRY_DELAY_MS));
    }
  }
  throw new Error(`exec 退出码不可得（inspect 连续 ${EXEC_INSPECT_MAX_ATTEMPTS} 次仍为 null）`);
}

/** src/world/dockerWorld.ts 的 runExec 精简版，只服务 clone 流程：不需要
    onOutput/AbortSignal 那一整套。两边按分工不共用代码（本刀范围只能动
    services/runtime/ 下的文件）；真要合并成一份留给后续专门的 ADR/PR。 */
async function execInContainer(
  container: ContainerLike,
  cmd: string[],
  opts: { stdin?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const attachStdin = opts.stdin !== undefined;
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    ...(attachStdin ? { AttachStdin: true } : {}),
  });
  const stream = await exec.start(attachStdin ? { hijack: true, stdin: true } : {});

  let stdout = "";
  let stderr = "";
  const stdoutSink = new Writable({
    write(chunk, _enc, cb) {
      stdout += chunk.toString("utf8");
      cb();
    },
  });
  const stderrSink = new Writable({
    write(chunk, _enc, cb) {
      stderr += chunk.toString("utf8");
      cb();
    },
  });
  container.modem.demuxStream(stream, stdoutSink, stderrSink);

  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
    if (opts.stdin !== undefined) {
      stream.write(opts.stdin);
      stream.end();
    }
  });

  const exitCode = await inspectExecExitCode(exec);
  return { stdout, stderr, exitCode };
}

async function checkGitDirExists(container: ContainerLike): Promise<boolean> {
  const result = await execInContainer(container, ["/bin/bash", "-lc", "test -d /work/.git"]);
  return result.exitCode === 0;
}

/** 用完即焚：clone 跑完（不管成不成功）都撤掉这一次性凭据——reject 掉
    credential store 里的条目、删掉凭据文件本身、unset 全局 helper 配置。
    尽力而为（try/catch 吞掉失败）：清理本身失败不该反过来推翻 clone 结果
    的判定，那个判定已经由调用方决定；已知风险见 report「已知限制」——
    如果这一步本身失败，PAT 会残留在容器的 credential store 文件里，直到
    容器下次被清理或重新 clone 覆盖。 */
async function cleanupCredentials(container: ContainerLike, repoUrl: string): Promise<void> {
  try {
    const host = safeHostOf(repoUrl);
    const rejectBlock = `protocol=https\nhost=${host}\nusername=${CREDENTIAL_USERNAME}\n\n`;
    await execInContainer(
      container,
      [
        "/bin/bash",
        "-lc",
        "git credential reject; rm -f ~/.git-credentials; git config --global --unset credential.helper; true",
      ],
      { stdin: rejectBlock },
    );
  } catch {
    // 见函数头注释——尽力而为，不让清理失败拖累 clone 结果本身
  }
}

/** 真正跑一次 clone：有 PAT 就先配好一次性凭据（stdin 喂、绝不进 Cmd/URL），
    clone 完（不管成败）都烧掉凭据。永远返回 CloneResult，不 throw——已知
    的失败路径（helper 配置失败/凭据写入失败/clone 本身失败/repoUrl 解析
    失败）全部转成 {ok:false, reason}；调用方 runCloneAttempt 再兜一层
    意料之外的异常。 */
async function performClone(container: ContainerLike, cfg: WorkspaceRepoConfig): Promise<CloneResult> {
  const { repoUrl, pat } = cfg;

  if (pat) {
    const helperSetup = await execInContainer(container, [
      "/bin/bash",
      "-lc",
      "git config --global credential.helper store",
    ]);
    if (helperSetup.exitCode !== 0) {
      const detail = helperSetup.stderr || helperSetup.stdout || `exitCode ${helperSetup.exitCode}`;
      return { ok: false, repoUrl, reason: redactPat(`credential.helper 配置失败：${detail}`, pat) };
    }

    let host: string;
    try {
      host = safeHostOf(repoUrl);
    } catch (err) {
      return { ok: false, repoUrl, reason: err instanceof Error ? err.message : String(err) };
    }

    const credentialBlock = `protocol=https\nhost=${host}\nusername=${CREDENTIAL_USERNAME}\npassword=${pat}\n\n`;
    const approve = await execInContainer(container, ["/bin/bash", "-lc", "git credential approve"], {
      stdin: credentialBlock,
    });
    if (approve.exitCode !== 0) {
      await cleanupCredentials(container, repoUrl); // helper 已经配上了，即使 approve 失败也要撤回
      const detail = approve.stderr || approve.stdout || `exitCode ${approve.exitCode}`;
      return { ok: false, repoUrl, reason: redactPat(`凭据写入失败：${detail}`, pat) };
    }
  }

  const cloneCmd = `/usr/bin/timeout -k 5 ${CLONE_TIMEOUT_SEC} git clone -- ${shellQuote(repoUrl)} /work`;
  const cloneResult = await execInContainer(container, ["/bin/bash", "-lc", cloneCmd]);

  if (pat) {
    await cleanupCredentials(container, repoUrl); // 成功失败都烧——PAT 只值这一次 clone 的信任
  }

  if (cloneResult.exitCode !== 0) {
    const detail = cloneResult.stderr || cloneResult.stdout || `exitCode ${cloneResult.exitCode}`;
    return { ok: false, repoUrl, reason: redactPat(detail, pat) };
  }
  return { ok: true, repoUrl };
}

export function createSandbox(
  docker: DockerLike,
  opts?: {
    image?: string;
    idleMs?: number;
    orphanGraceMs?: number;
    now?: () => number;
    orphans?: OrphansStore;
    /** 工作区云配置（repoUrl/PAT）的按需查询——ensure() 首次遇到一个
        workspaceId 时才会调一次（见 cloneAttempts 的"只跑一次"注释），不是
        每次工具执行都查。没配置回调 = 不做任何 clone 相关的事，维持现状
        （空容器）；查询本身抛错也一样按"没配"处理，不算 clone 失败。 */
    repoConfig?: (workspaceId: string) => Promise<WorkspaceRepoConfig | undefined>;
    /** clone 尝试的结果回调——只在**真的跑过一次 clone**时触发（已经
        clone 过、幂等跳过的情况不算，见 runCloneAttempt）。daemon.ts 用它
        落 console + 通报活跃会话；sandbox.ts 自己不做任何 I/O 副作用。 */
    onCloneResult?: (workspaceId: string, result: CloneResult) => void;
  },
): Sandbox {
  const image = opts?.image ?? DEFAULT_IMAGE;
  const idleMs = opts?.idleMs ?? DEFAULT_IDLE_MS;
  const orphanGraceMs = opts?.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const now = opts?.now ?? (() => Date.now());
  const orphansStore = opts?.orphans ?? memoryOrphansStore();

  const lastActive = new Map<string, number>();

  /** 同一个 workspaceId 在本进程生命周期内只跑一次 clone 流程：不仅是
      "并发调用去重"（后来者等同一个 promise），settle 之后这个 promise 也
      刻意不从 map 里删——后续每次 ensure() 直接拿到那个已经 resolve 的
      promise、瞬间返回，不会每次工具调用都重新问一遍
      `test -d /work/.git`，更不会在 repoUrl 配错时让每一次工具调用都
      重新触发一次可能长达 10 分钟的 clone 超时（那才是真正会拖垮云会话
      的问题——单次幂等检查本身很便宜，但"配错了就永远重试到超时"不行）。
      已知限制：如果卷在本进程存活期间被人手动清空（不是走 reconcile/
      destroy 这两条本模块自己的路径），这份内存缓存发现不了，要等下次
      进程重启才会重新检测——这个代价换来的是不会有重试风暴，判断是值得的。 */
  const cloneAttempts = new Map<string, Promise<void>>();

  function ensureRepoCloned(workspaceId: string, container: ContainerLike): Promise<void> {
    if (!opts?.repoConfig) return Promise.resolve();
    let attempt = cloneAttempts.get(workspaceId);
    if (!attempt) {
      attempt = runCloneAttempt(workspaceId, container);
      cloneAttempts.set(workspaceId, attempt);
    }
    return attempt;
  }

  async function runCloneAttempt(workspaceId: string, container: ContainerLike): Promise<void> {
    const repoConfig = opts?.repoConfig;
    if (!repoConfig) return;

    let cfg: WorkspaceRepoConfig | undefined;
    try {
      cfg = await repoConfig(workspaceId);
    } catch {
      return; // 配置查询本身失败——不算"clone 失败"，静默维持现状（空容器）
    }
    if (!cfg?.repoUrl) return; // 没配 repo，现状行为（空容器）

    try {
      const alreadyCloned = await checkGitDirExists(container);
      if (alreadyCloned) return; // 幂等：卷里已有克隆结果（可能来自上一个
      // 进程生命周期），不重复也不通报——onCloneResult 只在真的跑了一次
      // clone 时触发，不然每次进程重启都会对旧结果重复刷一遍"克隆成功"

      const outcome = await performClone(container, cfg);
      opts?.onCloneResult?.(workspaceId, outcome);
    } catch (err) {
      // performClone 内部已经把已知失败路径都转成 {ok:false,...} 不
      // throw；这里兜的是 checkGitDirExists/performClone 自身意外抛出的
      // 情况——绝不能让 clone 相关的失败反过来拖垮 ensure() 本身（设计点 4）
      const reason = redactPat(err instanceof Error ? err.message : String(err), cfg.pat);
      opts?.onCloneResult?.(workspaceId, { ok: false, repoUrl: cfg.repoUrl, reason });
    }
  }

  function markActive(workspaceId: string): void {
    lastActive.set(workspaceId, now());
  }

  /** 按名查容器——docker 的 Names 带前导斜杠（"/otto-ws-x"），两种形式都认 */
  async function findByName(name: string) {
    const list = await docker.listContainers({ all: true, filters: JSON.stringify({ name: [name] }) });
    return list.find((c) => c.Names.some((n) => n === name || n === `/${name}`));
  }

  async function ensure(workspaceId: string): Promise<ContainerLike> {
    const name = containerName(workspaceId);
    const found = await findByName(name);

    let container: ReturnType<DockerLike["getContainer"]>;
    if (!found) {
      const created = await docker.createContainer({
        name,
        Image: image,
        Cmd: ["sleep", "infinity"],
        Labels: { [WORKSPACE_LABEL]: workspaceId },
        HostConfig: {
          Memory: 2 * 1024 ** 3,
          NanoCpus: 2e9,
          PidsLimit: 512,
          Mounts: [{ Type: "volume", Source: name, Target: "/work" }],
        },
      });
      container = docker.getContainer(created.id);
      await container.start();
    } else {
      container = docker.getContainer(found.Id);
      if (found.State !== "running") {
        await container.start();
      }
    }
    markActive(workspaceId);

    // clone 挂在这里——容器（不管是刚建的还是既有的）已经在跑，卷已经挂
    // 好。见文件头 git clone 设计要点块的注释；ensureRepoCloned 自己处理
    // "没配置""已经 clone 过""并发去重""失败不阻塞"这几件事，这里只是
    // 单纯地等它一下，不关心结果（结果走 onCloneResult，不走返回值）。
    await ensureRepoCloned(workspaceId, container);
    return container;
  }

  async function sweepIdle(runningWorkspaces: ReadonlySet<string>): Promise<string[]> {
    const stopped: string[] = [];
    for (const [workspaceId, t] of lastActive) {
      if (runningWorkspaces.has(workspaceId)) continue;
      if (now() - t <= idleMs) continue;

      const found = await findByName(containerName(workspaceId));
      if (found && found.State === "running") {
        await docker.getContainer(found.Id).stop();
        stopped.push(workspaceId);
      }
    }
    return stopped;
  }

  /** 单个 workspaceId 在本轮 reconcile 里的判定：合法就清掉旧标记（反悔路径——
      一次 Supabase 抖动的误标记不该在下一次抖动时越过 grace 直接被判死刑）；
      不合法则走"首见只标记 / 已标记且过 grace 才删"两段式。 */
  function classifyOrphan(
    workspaceId: string,
    valid: boolean,
    orphans: Record<string, number>,
  ): "valid" | "mark" | "wait" | "remove" {
    if (valid) {
      if (workspaceId in orphans) delete orphans[workspaceId];
      return "valid";
    }
    const markedAt = orphans[workspaceId];
    if (markedAt === undefined) {
      orphans[workspaceId] = now();
      return "mark";
    }
    if (now() - markedAt > orphanGraceMs) {
      delete orphans[workspaceId];
      return "remove";
    }
    return "wait";
  }

  async function reconcile(validWorkspaceIds: ReadonlySet<string>): Promise<{ marked: string[]; removed: string[] }> {
    const marked: string[] = [];
    const removed: string[] = [];
    const orphans = orphansStore.load();

    const list = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [WORKSPACE_LABEL] }),
    });

    const containerWorkspaceIds = new Set<string>();

    for (const c of list) {
      const workspaceId = c.Labels[WORKSPACE_LABEL];
      if (!workspaceId) continue;
      containerWorkspaceIds.add(workspaceId);

      const verdict = classifyOrphan(workspaceId, validWorkspaceIds.has(workspaceId), orphans);
      if (verdict === "mark") {
        marked.push(workspaceId);
      } else if (verdict === "remove") {
        await docker.getContainer(c.Id).remove({ force: true }); // 先删容器
        await docker.getVolume(containerName(workspaceId)).remove(); // 卷被容器占用，顺序反了会失败
        removed.push(workspaceId);
      }
    }

    // 无容器的孤儿卷：容器已经没了（比如上一轮 reconcile 中途崩溃，或者被手动删过），
    // 卷却还在。卷没有 label，只能按名字前缀 "otto-ws-" 反推 workspaceId——这是唯一
    // 能用的线索，真实 docker 里卷的 filters 也不像容器那样可靠，干脆全列出来自己过滤。
    const { Volumes } = await docker.listVolumes({ filters: JSON.stringify({}) });
    const PREFIX = "otto-ws-";
    for (const v of Volumes) {
      if (!v.Name.startsWith(PREFIX)) continue;
      const workspaceId = v.Name.slice(PREFIX.length);
      if (containerWorkspaceIds.has(workspaceId)) continue; // 有同名容器，上面那段已经处理过

      const verdict = classifyOrphan(workspaceId, validWorkspaceIds.has(workspaceId), orphans);
      if (verdict === "mark") {
        marked.push(workspaceId);
      } else if (verdict === "remove") {
        await docker.getVolume(v.Name).remove(); // 没有容器可删，只删卷
        removed.push(workspaceId);
      }
    }

    orphansStore.save(orphans);
    return { marked, removed };
  }

  async function destroy(workspaceId: string): Promise<void> {
    const name = containerName(workspaceId);
    const found = await findByName(name);
    if (found) {
      await docker.getContainer(found.Id).remove({ force: true }); // 先删容器
    }
    await docker.getVolume(name).remove(); // 容器不存在时只走这一步，不炸
  }

  return { ensure, markActive, sweepIdle, reconcile, destroy };
}
