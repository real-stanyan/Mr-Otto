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
  /** 让下一次 ensure() 重新跑一次 clone 流程（不管上一次结果是成功/
      失败/幂等跳过）——owner 纠正 cs_config 里的 repoUrl/PAT 之后如果
      不调这个，cloneAttempts 缓存的结果会一直挡着，只有重启 daemon 才会
      重新尝试，而且没有任何提示告诉 owner「你的修正没生效」（复审 I4）。
      daemon.ts 的 saveConfig 落盘成功后调它。
      **不会打断正在跑的 attempt**（复审二轮竞态修复）：只是标记"过期"，
      真正的旧 attempt 该怎么跑完还怎么跑完（含它自己的凭据清理）；下一次
      ensure() 会等它完全收尾之后才起新的 attempt，不是立刻并发起一个——
      同一工作区可能有多个 session，跨 session 没有互斥，直接摘掉正在
      pending 的缓存会让两个 attempt 同时动同一个容器/卷/凭据文件。 */
  invalidateClone(workspaceId: string): void;
}

/** owner 经 cs_config 发来的工作区云配置（issue #821 slice 1）——落点见
    daemon.ts 的 workspaceConfigStore，这里只描述 ensure() 消费它需要的形状 */
export interface WorkspaceRepoConfig {
  repoUrl: string;
  pat?: string;
}

/** 一次 clone 判定的结局。**`repoUrl` 字段从不是原始配置的 repoUrl，
    永远是 `safeRepoLabel(...)` 的输出**（复审三轮：UI 侧"检测输入里有没
    有藏凭据"这条路已经被绕过三次——全角 ＠ U+FF20、11 层以上嵌套 percent
    编码——说明输入校验做不完美，安全边界必须搬到输出侧）。这个类型是要
    经 `onCloneOutcome` 广播给整个工作区的东西（daemon.ts 的
    `notifyWorkspace` 发 `chat_message` 给全体成员），原始 repoUrl（可能带
    userinfo 语法嵌进去的凭据）绝不允许流到这里——真正需要原始 repoUrl 的
    地方只有 `performClone` 内部（拿去跑 `git clone`），出了那个函数就再
    也摸不到它，不依赖任何一处调用方"记得脱敏"。`reason` 同理已经过
    `sanitizeCloneText` 脱敏（既擦 pat，也擦 repoUrl 里可能藏的凭据），
    可以直接落日志/`chat_message`，不需要调用方再处理一遍。

    **判据是 `kind` 这个事实，不是 `ok` + `reason` 那组线索**（issue #832，
    照 ADR-0193 那条教训：三处消费方各自从一组线索里猜同一件事时，
    "一致地猜错"比"一处错"更难发现）。上一版只有 `{ok:true}|{ok:false}`
    两态，于是"幂等跳过"这件事在类型里根本没有位置——它被实现成"压根不
    回调"，而那正是 issue #832 症状①（改了仓库地址，跳过分支静默吃掉整次
    修正）能瞒住所有人的原因：没有回调 = 没有任何一处消费方有机会说话。
    五个 kind 各自对应一条**说得出口**的处置：
      cloned   真的跑了一次 clone 且成功
      switched 换了仓库：旧克隆是干净的，清空后重新 clone（`from` 是旧
               仓库的安全标签，同样过 safeRepoLabel——它是从 /work 里
               `git config --get remote.origin.url` 读回来的，那条 URL
               完全可能是当初带着凭据 clone 下来的）
      skipped  幂等：/work 已经是这个仓库的完整克隆，什么都没做
      refused  **拒绝动 /work**：里面有不属于这次 clone 的东西（水獭的
               产出 / 另一个仓库的未提交改动 / 未推送的提交）。这条与
               failed 分开是因为处置不同——failed 是"该做的没做成"，
               refused 是"故意没做，且需要人来决定" */
export type CloneOutcome =
  | { kind: "cloned"; repoUrl: string }
  | { kind: "switched"; repoUrl: string; from: string }
  | { kind: "skipped"; repoUrl: string }
  | { kind: "refused"; repoUrl: string; reason: string }
  | { kind: "failed"; repoUrl: string; reason: string };

/** 一条 CloneOutcome 的人话。放这儿（而不是 daemon.ts）是为了能单测——
    daemon.ts 自己不进 vitest（见该文件头注释），而这几句是真的会被广播给
    工作区全员看的东西。**每个 kind 都有一句**，包括 skipped：它会进
    "当前状态"那一格（#834 的 welcome.repo），只是不进聊天流刷屏。 */
export function cloneOutcomeText(o: CloneOutcome): string {
  switch (o.kind) {
    case "cloned":
      return `仓库克隆成功：${o.repoUrl}`;
    case "switched":
      return `已切换仓库：${o.from} → ${o.repoUrl}（旧克隆是干净的，已清空重新克隆）`;
    case "skipped":
      return `工作目录已经是 ${o.repoUrl} 的克隆，没有重新克隆`;
    case "refused":
      return `没有克隆 ${o.repoUrl}：${o.reason}`;
    case "failed":
      return `仓库克隆失败（${o.repoUrl}）：${o.reason}`;
  }
}

const DEFAULT_IMAGE = "otto-sandbox";
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const WORKSPACE_LABEL = "mrotto.workspace";
/** 一次性 clone 旁路容器的标签（issue #835⑤）——reconcile 靠它认出
    "daemon 上次崩在 clone 中途、漏在这台机器上的那台容器"。这种残骸里有
    PAT，不能等孤儿宽限那 7 天，见 sweepCloneContainers */
const CLONE_LABEL = "mrotto.clone";

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

// ── git clone（issue #821 slice 1；issue #832 / #835 改判了 2、3、4 三条）──
// 设计要点（对照 docs/superpowers/specs/2026-08-31-workspace-phase2-design.md:87
// 的原始设想，token 走 stdin 而不是原文说的"exec 传参"——容器里跑着 agent
// 自己的 bash，argv 会出现在 `ps aux` 里，等于把 PAT 摆在 agent 面前）：
//   1. PAT 只经 stdin 喂给 `git credential approve`；Cmd 数组、日志、
//      onCloneOutcome 的输出一律不含它（redactPat 兜底）。clone 本身用原样
//      的 https URL，不拼 token 进 URL。
//   2. **凭据不进水獭那台容器**（issue #835⑤ 推翻了原来的"用完即焚"）：
//      clone 跑在一台**一次性旁路容器**里（挂同一个卷，见 withCloneContainer），
//      PAT 只存在于那台容器的可写层，容器一删凭据跟着没。原来那套
//      `cleanupCredentials` / `cleanupResidualCredentialsIfAny` / try-finally
//      整个删掉了——它们存在的唯一理由就是"凭据跟水獭共用一个可写层"，
//      而那个前提本身才是缺陷：`~/.git-credentials` 就在水獭自己那台容器
//      里，水獭之前起的后台进程读得到（前台工具调用被 ensure() 串住，
//      后台 bash 不受这条约束），而且清理是尽力而为——cleanup 自己失败
//      的话 PAT 要留到下一次 ensure() 命中幂等分支才有机会补救。
//      旁路容器打 `mrotto.clone` 标签，reconcile 会收走 daemon 崩溃时漏下
//      的那台（里面有 PAT）。
//   3. **要不要 clone 是一张说得出理由的决策表，不是一个布尔**（issue
//      #832，见 decideCloneAction）。上一版只问"能不能 `rev-parse HEAD`"，
//      于是两头都错：答"能"就跳过 ⇒ owner 换了仓库地址永远不生效，而且
//      跳过分支从不通报，人完全看不出；答"不能"就 `find -delete` ⇒ 一个
//      "用了一阵才配仓库"的工作区，水獭之前的产出被无声清空，而本期不许
//      push = 没有任何远程备份。现在 /work 的现状先探成 WorkState 四态，
//      再由纯函数决定 clone / switch / skip / refuse，**每条分支都有回执**。
//   4. clone 失败绝不向上抛出——ensure() 永远正常返回容器，只是内容是
//      空的；onCloneOutcome 回调自己抛出也不例外（复审 I5）。
//   5. 除 clone 本身给 10 分钟外，其余每条 exec 都套一个较短的默认超时
//      （复审 I6：ensure() 是 dockerWorld 拿容器句柄的唯一入口，任何一条
//      卡住不返回，这个工作区之后所有工具调用永久挂起，没有看门狗）。
//   6. owner 纠正配置后可以调 `Sandbox.invalidateClone` 让下一次 ensure()
//      重新尝试，不用等 daemon 重启（复审 I4）——但它只标记"过期"，不会
//      打断正在跑的旧 attempt；新 attempt 必须等旧的完全收尾才起步，
//      串行而不是并发（复审二轮竞态修复：同一 workspaceId 可能被多个
//      session 共用，跨 session 没有互斥，直接摘掉 pending 的缓存会让
//      两个 attempt 同时动同一个容器/卷）。
//   7. 结果经 onCloneOutcome 回调通报，sandbox.ts 自己不做任何 console/IO。

/** git credential 协议要求 username 字段非空；PAT 场景下主流 provider
    （GitHub/GitLab/Bitbucket）不校验这个值本身、只认 password 里的
    token——固定占位符即可，不必问用户要真实用户名。用 GitHub Apps 同款
    惯例 "x-access-token"。 */
const CREDENTIAL_USERNAME = "x-access-token";
/** clone 本身的超时上限——大仓库真的可能要跑到接近这个数量级 */
const CLONE_TIMEOUT_SEC = 600;
/** 除 clone 本身外，其余每条 exec（凭据配置/幂等检查/清理…）的默认超时——
    同 src/world/dockerWorld.ts exec() 的默认 30s 对齐，不是随便选的数字
    （复审 I6：这些命令没一条应该跑很久，卡住只可能是异常状态，不该无限
    等）。 */
const DEFAULT_EXEC_TIMEOUT_SEC = 30;
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

// ── repoUrl 本身可能藏凭据（复审三轮）─────────────────────────────────────
// owner 填的 repoUrl 理论上不该带凭据（PAT 走独立的 pat 字段），但用户
// 完全可能自己塞一条 `https://user:pass@host/x.git` 进来（或者是 UI 侧
// 输入检测想拦却没拦住的某种绕过形态——那条检测已经被绕过三轮：全角 ＠
// U+FF20、11 层以上嵌套 percent 编码）。UI 那边的教训是：靠"识别输入里
// 有没有藏凭据"这条路做不完美，每堵一个新花样都只是又添一条黑名单规则。
// 这里换一种做法——不猜"这串像不像藏了凭据"，只用 WHATWG URL 解析器
// **自己**给出的字段（协议+host+路径，从不读 username/password）拼展示串；
// 解析失败就整体退化成不含任何原始片段的通用文案。经验证（Node 内置
// URL）：全角 ＠、嵌套 percent 编码、scp 语法（user@host:path）、
// protocol-relative（//host/path）全部会让 `new URL(...)` 直接抛异常，
// 不会被解析成"看似正常的 host"——落进这里的 catch 分支，不会漏出任何
// 原始片段。真正的安全边界不是这个函数猜得准不准，是 CloneResult.repoUrl
// 这个字段**结构上**永远只存这个函数的输出（见该类型的注释）——即使
// 未来又出现第四种绕过输入检测的编码花样，也不需要专门再堵一次，因为
// 这个函数从来没有"认出凭据再擦掉"这一步，它是白名单，不是黑名单。
export function safeRepoLabel(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    if (!url.host) return "仓库"; // 有 scheme 但没有 host（比如 file:// 之类）——没有安全的部分可展示
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "仓库"; // 解析不出来的串——UI 侧三轮绕过形态全部落在这一分支
  }
}

/** clone 流程里任何要交给 onCloneResult 的自由文本（git 的 stdout/stderr、
    捕获到的异常消息）都要过这个函数，不能只调 redactPat——PAT 是我们自己
    塞进凭据里的字符串，redactPat 擦得掉；但 repoUrl 本身也可能被用户
    塞了凭据（见 safeRepoLabel 的注释），而且 git 的错误消息经常把它执行
    失败时用的那条 URL **原样回显**（比如 "fatal: unable to access
    'https://user:pass@host/x.git/'"）——这条泄漏路径不在 pat 变量里，
    redactPat 管不到。

    repoUrl **能解析**时做三件事：① 走 redactPat；② 把整条 repoUrl 子串
    （如果原样出现）换成 safeRepoLabel 的结果；③ repoUrl 解析得出的
    username/password（如果非空）各自的原文也擦掉，兜底"工具只把凭据
    片段打进日志、没抄整条 URL"的情形。

    repoUrl **解析失败**时——fail-closed（复审四轮）：不再对 text 做任何
    部分脱敏，整段换成固定文案。原因见下面 catch 分支的注释：②那种逐字
    子串匹配一旦 git 在报错前哪怕只改写了 URL 的一个字符（百分号编码/
    解码/只回显片段），就会失效，而这时③又用不了（parse 都失败了，没有
    username/password 可比对）——复审四轮就是拿这个盲点实测出了 3 个真实
    泄漏案例。跟 redactPat 一样是尽力而为，不是形式化证明——真正的安全
    边界是 CloneResult.repoUrl 从来不存原始 repoUrl，这个函数是给 reason
    这种自由文本字段的第二道防线，不是唯一防线。 */
function sanitizeCloneText(text: string, cfg: { repoUrl: string; pat?: string }): string {
  let url: URL;
  try {
    url = new URL(cfg.repoUrl);
  } catch {
    // repoUrl 解析不出来——fail-closed（复审四轮，跟 safeRepoLabel 同一条
    // 原则）：不能只靠"整条 cfg.repoUrl 子串替换"兜底。git（或它调用的
    // ssh）在报错前经常会**改写**这条 URL 再回显——百分号编码非 ASCII
    // 字符、解码已有的 %XX、或者干脆只回显 user@host 这一小段而不是整条
    // URL——改写后的文本跟原始 cfg.repoUrl 逐字比对不上，子串替换直接
    // 落空；而这里又拿不到 username/password 做第二道匹配（parse 都
    // 失败了）。继续放行这段自由文本，就是继续赌"这次 git 没有在输出里
    // 留下凭据碎片"——赌输一次就是把凭据广播给工作区全体成员（复审四轮
    // 实测出的 3 个真实案例：全角 ＠ 被百分号编码回显、scp 语法被 ssh
    // 回显 user@host 片段、%40 被解码回显，都属于"整条子串匹配对不上"）。
    // 宁可损失这条路径下的排错细节，也不放行任何一个字符——owner 少看到
    // 一点排错信息，换来的是 token 结构上不可能从这条路径出现在 reason
    // 里。能正常解析的路径（下面 try 之后的部分）不受影响，排错信息照旧。
    return "（错误详情已省略：仓库地址无法解析，可能含凭据）";
  }

  let result = redactPat(text, cfg.pat);
  result = result.split(cfg.repoUrl).join(safeRepoLabel(cfg.repoUrl));
  if (url.password) result = result.split(url.password).join("***");
  if (url.username) result = result.split(url.username).join("***");
  return result;
}

/** git credential 协议的 host 字段——用 URL.host（含端口，如果有）而不是
    hostname：credential store 按这个字段匹配，得和 clone 用的 URL 对得上 */
function safeHostOf(repoUrl: string): string {
  try {
    return new URL(repoUrl).host;
  } catch {
    // 不回显原始 repoUrl——这条错误消息最终会经 sanitizeCloneText/
    // safeRepoLabel 处理，但那两层是第二道防线，第一道是"压根不产出
    // 带原始片段的文本"（复审三轮的教训）
    throw new Error("repoUrl 不是合法 URL，无法配置凭据");
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
    onOutput/AbortSignal 那一整套，但保留了它的两个关键行为——WorkingDir
    固定 /work、exitCode 124 补一句"命令超时"（复审 M8：两边行为不该
    分叉，clone 失败的 reason 会直接进 chat_message 给工作区成员看，裸
    `exitCode 124` 不是人话）。两边按分工不共用代码（本刀范围只能动
    services/runtime/ 下的文件）；真要合并成一份留给后续专门的 ADR/PR。

    接的是一段 bash 脚本（不是 Cmd 数组）——`/usr/bin/timeout` 包裹在这里
    统一加，调用方不用每次记得写（复审 I6）：clone 本身传
    `{timeoutSec: CLONE_TIMEOUT_SEC}` 覆盖默认的 30 秒，其余调用方一律
    吃默认值。 */
async function execInContainer(
  container: ContainerLike,
  script: string,
  opts: { stdin?: string; timeoutSec?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_EXEC_TIMEOUT_SEC;
  const cmd = ["/usr/bin/timeout", "-k", "5", String(timeoutSec), "/bin/bash", "-lc", script];
  const attachStdin = opts.stdin !== undefined;
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    ...(attachStdin ? { AttachStdin: true } : {}),
    WorkingDir: "/work",
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
  if (exitCode === 124) {
    stderr = `${stderr}\n命令超时`.trim();
  }
  return { stdout, stderr, exitCode };
}

/** /work 此刻的现状。四态取代原来那个布尔（issue #832）——布尔只能回答
    "要不要重新 clone"，而这个问题的两个答案各自都能造成损失：答"要"就
    `find -delete`（清掉的可能是水獭的产出），答"不要"就跳过（owner 换
    仓库地址的修正被静默吃掉）。分成四态之后，"清空"这个动作只发生在
    **我们自己上次留下的半成品**（partial）和**确认可丢弃的旧克隆**
    （repo + 干净 + 换仓库）两种情形，其余一律 refuse 并说明。 */
export type WorkState =
  | { kind: "empty" }
  /** 有 `.git` 且 `rev-parse HEAD` 拿得到提交 = 一个能用的克隆。
      origin 可能是空串（有人手工 `git init` 出来的，没有 remote）；
      dirty = 有未提交改动；ahead = 有还没推上去的本地提交，**拿不准时
      一律算 true**（没有 upstream / 命令失败都归到这里）——本期不允许
      push，所以"本地领先的提交"在这台机器之外没有任何副本 */
  | { kind: "repo"; origin: string; dirty: boolean; ahead: boolean }
  /** 有 `.git` 但没有可用 HEAD：git clone 在对象传输**开始前**就先建好
      `.git/`，撞 600s 超时/OOM/网络断留下的就是这个形态。这是我们自己
      上一次的残骸，清掉它不会丢任何别人的东西（复审 I3 原来判的就是
      这一态，只是当时把 foreign 也一起判进来了） */
  | { kind: "partial" }
  /** 非空、且不是 git 仓库——水獭在没配仓库那段时间的产出。绝不清空 */
  | { kind: "foreign" }
  /** 探测本身失败（容器正在重启 / exec 抛异常 / 输出解析不出来）。
      **不知道 = 不动**：这一态一律 refuse，不会退化成上面任何一态 */
  | { kind: "unknown"; detail: string };

/** 探测脚本的输出解析。每行 `键=值`，未知行忽略——脚本以后加字段不会
    让老解析器整体失败。解析不出 `state=` 就是 unknown（fail-closed）。 */
export function parseWorkState(stdout: string): WorkState {
  const fields = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const state = fields.get("state");
  if (state === "empty") return { kind: "empty" };
  if (state === "foreign") return { kind: "foreign" };
  if (state === "partial") return { kind: "partial" };
  if (state === "repo") {
    // ahead 只有明确读到 "0" 才算"没有本地领先提交"：`ahead=unknown`
    // （没有 upstream —— 水獭自己开了条新分支就是这形态）和字段整个缺席
    // 都归到"拿不准"，而拿不准要按最坏情况处理
    return {
      kind: "repo",
      origin: fields.get("origin") ?? "",
      dirty: fields.get("dirty") !== "0",
      ahead: fields.get("ahead") !== "0",
    };
  }
  return { kind: "unknown", detail: stdout.trim().slice(0, 400) || "探测脚本没有任何输出" };
}

/** 两条 git URL 指不指同一个仓库。按 URL 解析器给的 protocol+host+path 比，
    **刻意不看 userinfo**：/work 里那条 origin 完全可能是当初带着凭据 clone
    下来的（`https://token@host/x.git`），而 owner 现在填的是干净地址——
    它们是同一个仓库，判成"换了仓库"就会白清空一次工作目录。顺带吃掉
    结尾的 `.git` 与斜杠、host 大小写这三种同义写法。解析不出来的（scp
    语法之类）退回逐字比——比错了的后果是"多判一次换仓库"，而换仓库这条
    路本身还有 dirty/ahead 两道闸，不会直接毁东西。 */
export function sameRepo(a: string, b: string): boolean {
  const norm = (s: string): string => {
    const trimmed = s.trim();
    try {
      const u = new URL(trimmed);
      const path = u.pathname.replace(/\.git$/, "").replace(/\/+$/, "");
      return `${u.protocol}//${u.host.toLowerCase()}${path}`;
    } catch {
      return trimmed.replace(/\.git$/, "").replace(/\/+$/, "");
    }
  };
  return a.trim() !== "" && norm(a) === norm(b);
}

/** 决策表（issue #832）——纯函数，每条分支都**说得出理由**。
    这是这一刀的核心：上一版把这张表压成了一个布尔，于是"跳过"这一格
    连一句话都没有，owner 改了仓库地址之后没有任何一处代码有机会告诉他
    "我什么都没做"。 */
export function decideCloneAction(
  state: WorkState,
  configuredUrl: string,
):
  | { action: "clone" }
  | { action: "switch"; from: string }
  | { action: "skip" }
  | { action: "refuse"; reason: string } {
  switch (state.kind) {
    case "empty":
      return { action: "clone" };
    case "partial":
      // 我们自己上次的半成品，清掉重来（原 I3 的行为，只是不再殃及 foreign）
      return { action: "clone" };
    case "foreign":
      return {
        action: "refuse",
        reason:
          "工作目录里已经有内容，而且不是 git 仓库（多半是水獭之前干活留下的）。" +
          "不会自动清空——请换一个工作区，或者先自己把 /work 清空再重试。",
      };
    case "unknown":
      return { action: "refuse", reason: `探不清工作目录的现状，没有动它：${state.detail}` };
    case "repo": {
      if (sameRepo(state.origin, configuredUrl)) return { action: "skip" };
      const from = state.origin === "" ? "（没有 remote 的本地仓库）" : safeRepoLabel(state.origin);
      if (state.dirty) {
        return {
          action: "refuse",
          reason: `工作目录现在是 ${from} 的克隆，而且有未提交的改动。不会自动清空——先处理掉这些改动再改配置。`,
        };
      }
      if (state.ahead) {
        // 本期不允许 push，所以"本地领先的提交"在这台机器之外没有副本，
        // 清掉就是真的没了（而且 ahead 拿不准时也走这一支，见 parseWorkState）
        return {
          action: "refuse",
          reason: `工作目录现在是 ${from} 的克隆，里面有还没推送出去的提交（云沙箱不允许 push，清掉就找不回来了）。不会自动清空。`,
        };
      }
      return { action: "switch", from };
    }
  }
}

/** 探一次 /work 的现状。一条脚本一次 exec——分成几条 exec 的话，中间
    可能被水獭自己的 bash 改掉（同一个卷），拿到的就是几个时刻的拼盘。

    rev-parse 之前先注册 /work 为 safe.directory（复审二轮防患）：现在
    容器跑 root（`services/runtime/sandbox/Dockerfile` 建了 otter 用户但
    没有 `USER otter`），`.git/` 的属主就是 root；将来谁给镜像补上那行
    `USER otter`，容器进程 UID 就会和历史遗留的 root 属主对不上，
    git 2.35+ 的 dubious-ownership 保护会让 rev-parse **直接报错退出**
    （不是"没有提交"那种正常失败）。那会被这里误判成"没克隆完"，进而

    rev-parse 之前先注册 /work 为 safe.directory（复审二轮防患）：现在
    容器跑 root（`services/runtime/sandbox/Dockerfile` 建了 otter 用户但
    没有 `USER otter`），`.git/` 的属主就是 root；将来谁给镜像补上那行
    `USER otter`，容器进程 UID 就会和历史遗留的 root 属主对不上，
    git 2.35+ 的 dubious-ownership 保护会让 rev-parse **直接报错退出**
    （不是"没有提交"那种正常失败）。那会被这里误判成"没克隆完"，进而
    在 performClone 里触发 `find -delete`——清空一个其实完好、且因为
    本期不允许 push 而没有任何远程备份的工作区（agent 未推的 commit、
    未提交的改动全没）。这行命令对"容器跑 root"的现状是无害的空操作
    （属主本来就是自己），纯粹是为"以后镜像加了 USER otter"预先垫一层，
    不等那天真的踩到才修。

    脚本一律 `exit 0`——非零退出码留给"探测本身失败"这一种意思（容器
    重启中/镜像里没有 git…），落进 unknown 而不是被当成某一态。 */
async function probeWorkState(container: ContainerLike): Promise<WorkState> {
  const script = [
    "git config --global --add safe.directory /work >/dev/null 2>&1",
    'if [ -z "$(ls -A /work 2>/dev/null)" ]; then echo state=empty; exit 0; fi',
    "if [ ! -e /work/.git ]; then echo state=foreign; exit 0; fi",
    "if ! git -C /work rev-parse HEAD >/dev/null 2>&1; then echo state=partial; exit 0; fi",
    "echo state=repo",
    'echo "origin=$(git -C /work config --get remote.origin.url 2>/dev/null)"',
    'if [ -n "$(git -C /work status --porcelain 2>/dev/null)" ]; then echo dirty=1; else echo dirty=0; fi',
    // @{upstream} 不存在（水獭自己开了条新分支 / detached HEAD）时这条会
    // 失败——输出 ahead=unknown 而不是 0，parseWorkState 那边按"拿不准"处理
    'if ahead=$(git -C /work rev-list --count "@{upstream}..HEAD" 2>/dev/null); then echo "ahead=$ahead"; else echo ahead=unknown; fi',
    "exit 0",
  ].join("\n");

  try {
    const result = await execInContainer(container, script);
    if (result.exitCode !== 0) {
      const detail = result.stderr || result.stdout || `exitCode ${result.exitCode}`;
      return { kind: "unknown", detail: detail.trim().slice(0, 400) };
    }
    return parseWorkState(result.stdout);
  } catch (err) {
    return { kind: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** 一次性 clone 旁路容器（issue #835⑤）。挂**同一个卷**到 /work，跑完就
    整台删掉——PAT 只落在这台容器的可写层，它一死凭据跟着死。

    为什么不是"在水獭那台容器里写完再擦干净"（上一版的做法）：
      ① 擦不干净的窗口是真实存在的——`cleanupCredentials` 自己那条 exec
         也会失败（容器正在重启），失败之后 PAT 要留到"下一次这个
         workspaceId 被 ensure() 到并命中幂等分支"才有机会补救；
      ② 就算擦得干净，clone 那几分钟里 `~/.git-credentials` 就摆在水獭
         自己的容器里，水獭**之前起的后台进程**读得到（前台工具调用被
         ensure() 串住，后台 bash 不受这条约束）。
    换成旁路容器之后这两条都不成立，代价是每次真 clone 多一次
    create+start+remove（只在真的要 clone 时才发生，幂等跳过不付这个钱）。

    `finally` 里的 remove 是尽力而为：删不掉（docker 抖动/daemon 挂了）
    不该反过来推翻 clone 结果的判定——真漏下的那台由 reconcile 的
    sweepCloneContainers 按 `mrotto.clone` 标签收走，那条路不依赖本进程
    还活着。 */
async function withCloneContainer<T>(
  deps: {
    docker: DockerLike;
    image: string;
    workspaceId: string;
    name: string;
    onCreated: (name: string) => void;
    onReleased: (name: string) => void;
  },
  fn: (container: ContainerLike) => Promise<T>,
): Promise<T> {
  const created = await deps.docker.createContainer({
    name: deps.name,
    Image: deps.image,
    Cmd: ["sleep", "infinity"],
    Labels: { [CLONE_LABEL]: deps.workspaceId },
    HostConfig: {
      Memory: 2 * 1024 ** 3,
      NanoCpus: 2e9,
      PidsLimit: 256,
      Mounts: [{ Type: "volume", Source: containerName(deps.workspaceId), Target: "/work" }],
    },
  });
  deps.onCreated(deps.name);
  const container = deps.docker.getContainer(created.id);
  try {
    await container.start();
    return await fn(container);
  } finally {
    try {
      await container.remove({ force: true });
    } catch {
      // 见函数头注释——漏下的那台由 reconcile 按标签收走
    }
    deps.onReleased(deps.name);
  }
}

/** clone 之前要求的最低可用空间（KiB）。**不是配额**（issue #836：真正的
    每卷配额要看存储驱动，overlay2+xfs prjquota 才支持 `--storage-opt
    size=`，而这台 runtime VPS 还没开出来、没法验），只是一道下限闸：
    挡不住"一个 50G 的仓库占 50G"，能挡住"磁盘已经快满了还起一次 clone
    把整台机器写死"——后者会连累这台机器上所有工作区。 */
const MIN_FREE_KIB = 2 * 1024 * 1024; // 2 GiB

/** 真正跑一次 clone。**跑在旁路容器里**（调用方用 withCloneContainer 起，
    见那里的注释）：有 PAT 就先配好凭据（stdin 喂、绝不进 Cmd/URL），跑完
    整台容器删掉，凭据跟着没——所以这里没有任何 cleanup 代码，也不需要
    "确认写了凭据才清理"那套标记（issue #835⑤ 删掉的正是那一套）。

    永远返回结果，不 throw——已知的失败路径（helper 配置失败/凭据写入
    失败/空间不足/清空目标目录失败/clone 本身失败/repoUrl 解析失败/任何
    一步的 execInContainer 直接抛异常）全部转成 {ok:false, reason}。
    reason 一律过 sanitizeCloneText（既擦 pat，也擦 repoUrl 里可能藏的
    凭据）——它会被广播给工作区全员。

    调用方保证只在 decideCloneAction 判 clone/switch 时才进来，所以这里
    的 `find -delete` 清的要么是空目录（无操作），要么是已经判定可丢弃的
    东西（我们自己的半成品 / 干净且没有本地领先提交的旧克隆）。 */
async function performClone(
  container: ContainerLike,
  cfg: WorkspaceRepoConfig,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { repoUrl, pat } = cfg;

  try {
    // 空间下限（issue #836）：拿不到读数就放行——`df` 输出格式在不同镜像
    // 上会变，为一个"猜不出可用空间"就拒绝 clone，代价比它挡住的那点风险
    // 大。这是闸不是配额，见 MIN_FREE_KIB 的注释
    const df = await execInContainer(container, "df -Pk /work | awk 'NR==2 {print $4}'");
    const availKib = Number.parseInt(df.stdout.trim(), 10);
    if (df.exitCode === 0 && Number.isFinite(availKib) && availKib < MIN_FREE_KIB) {
      const availMib = Math.floor(availKib / 1024);
      return {
        ok: false,
        reason: `磁盘可用空间不足（剩 ${availMib} MiB，低于 ${MIN_FREE_KIB / 1024} MiB 下限），没有开始克隆。`,
      };
    }

    if (pat) {
      const helperSetup = await execInContainer(container, "git config --global credential.helper store");
      if (helperSetup.exitCode !== 0) {
        const detail = helperSetup.stderr || helperSetup.stdout || `exitCode ${helperSetup.exitCode}`;
        return { ok: false, reason: sanitizeCloneText(`credential.helper 配置失败：${detail}`, cfg) };
      }

      const host = safeHostOf(repoUrl); // 抛出的话走下面的 catch
      const credentialBlock = `protocol=https\nhost=${host}\nusername=${CREDENTIAL_USERNAME}\npassword=${pat}\n\n`;
      const approve = await execInContainer(container, "git credential approve", { stdin: credentialBlock });
      if (approve.exitCode !== 0) {
        const detail = approve.stderr || approve.stdout || `exitCode ${approve.exitCode}`;
        return { ok: false, reason: sanitizeCloneText(`凭据写入失败：${detail}`, cfg) };
      }
    }

    // find -mindepth 1 -delete 连隐藏文件一起删，但保留 /work 本身
    // （挂载点）；对本来就空的目录是无操作。
    const clear = await execInContainer(container, "find /work -mindepth 1 -delete");
    if (clear.exitCode !== 0) {
      const detail = clear.stderr || clear.stdout || `exitCode ${clear.exitCode}`;
      return { ok: false, reason: sanitizeCloneText(`清空目标目录失败：${detail}`, cfg) };
    }

    // GIT_TERMINAL_PROMPT=0（issue #835 顺带）：私有仓库没配 PAT 时，让 git
    // **明确**报"需要凭据"而不是去摸终端——没有 tty 时它本来也会失败，但
    // 那条路的行为取决于镜像里有没有 askpass 之类的东西，不该靠环境碰运气
    const cloneCmd = `export GIT_TERMINAL_PROMPT=0\ngit clone -- ${shellQuote(repoUrl)} /work`;
    const cloneResult = await execInContainer(container, cloneCmd, { timeoutSec: CLONE_TIMEOUT_SEC });
    if (cloneResult.exitCode !== 0) {
      // 最容易实际携带原始 repoUrl 的一条：git clone 失败时的 stderr
      // 经常把它当时用的那条 URL 原样回显（"fatal: unable to access
      // '<url>'"），sanitizeCloneText 就是为这种情形准备的
      const detail = cloneResult.stderr || cloneResult.stdout || `exitCode ${cloneResult.exitCode}`;
      return { ok: false, reason: sanitizeCloneText(detail, cfg) };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: sanitizeCloneText(message, cfg) };
  }
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
    /** clone 判定的结果回调——**每次判定都触发，包括 skipped**（issue
        #832 改的就是这一点：上一版只在"真的跑了一次 clone"时回调，于是
        "幂等跳过"这件事没有任何一处消费方有机会说话，owner 换了仓库
        地址的修正被静默吃掉）。调用方按 `kind` 分派：daemon.ts 把
        cloned/switched/failed/refused 通报进会话，skipped 只更新"当前
        状态"不刷屏（那才是"每次进程重启都重复刷一遍克隆成功"要防的东西
        ——防的是**刷屏**，不是防"让状态被人看见"）。
        sandbox.ts 自己不做任何 I/O 副作用。 */
    onCloneOutcome?: (workspaceId: string, outcome: CloneOutcome) => void;
  },
): Sandbox {
  const image = opts?.image ?? DEFAULT_IMAGE;
  const idleMs = opts?.idleMs ?? DEFAULT_IDLE_MS;
  const orphanGraceMs = opts?.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const now = opts?.now ?? (() => Date.now());
  const orphansStore = opts?.orphans ?? memoryOrphansStore();

  const lastActive = new Map<string, number>();

  /** 同一个 workspaceId 在本进程生命周期内只跑一次 clone 流程：不仅是
      "并发调用去重"（后来者等同一个 promise），settle 之后这个 slot 也
      刻意不从 map 里删——后续每次 ensure() 直接拿到那个已经 resolve 的
      promise、瞬间返回，不会每次工具调用都重新问一遍幂等检查，更不会在
      repoUrl 配错时让每一次工具调用都重新触发一次可能长达 10 分钟的
      clone 超时（那才是真正会拖垮云会话的问题——单次幂等检查本身很
      便宜，但"配错了就永远重试到超时"不行）。owner 纠正配置后要靠
      `invalidateClone` 显式让这份缓存失效（复审 I4）。
      已知限制：如果卷在本进程存活期间被人手动清空（不是走 reconcile/
      destroy 这两条本模块自己的路径），这份内存缓存发现不了，要等下次
      进程重启才会重新检测——这个代价换来的是不会有重试风暴，判断是值得的。

      `invalidated` 字段的存在理由（复审二轮竞态修复）：`sandbox` 是单例，
      `cloneAttempts` 按 workspaceId 键控，同一工作区的所有 session 共用
      同一个 slot（daemon.ts 里每个 session 各自的 `container: () =>
      sandbox.ensure(workspaceId)` 调的是同一个 `ensure`）；`turnCoordinator`
      的互斥只在单个 session 内，跨 session 没有互斥，`cs_config` 帧随时
      能打进来。如果 `invalidateClone` 直接 `delete` 掉一个仍在 pending 的
      slot，紧随其后另一个 session 的工具调用会以为"没有任何缓存"，立刻
      拿新配置起第二个并发 attempt——两个 attempt 同时动同一个容器/卷/
      凭据文件：新的 `find -delete` 能删掉旧的还在写的 `.git/objects`，
      旧的收尾时的 `cleanupCredentials` 也能撤掉新的刚 approve 完的凭据。
      改成只打标记：旧 attempt 该怎么跑完还怎么跑完（含它自己的
      cleanup），`ensureRepoCloned` 看到标记时才会等旧 promise 先
      settle，再起新的——串行，不是并发。 */
  interface CloneAttemptSlot {
    promise: Promise<void>;
    invalidated: boolean;
  }
  const cloneAttempts = new Map<string, CloneAttemptSlot>();

  function ensureRepoCloned(workspaceId: string, container: ContainerLike): Promise<void> {
    if (!opts?.repoConfig) return Promise.resolve();

    const existing = cloneAttempts.get(workspaceId);
    if (existing && !existing.invalidated) {
      return existing.promise; // 仍然有效（不管还在 pending 还是已经 settle），直接复用
    }

    // 走到这里：这个 workspaceId 要么从没 clone 过，要么上一个 slot 被
    // invalidateClone 标记过期了。两种情况都要新起一个 attempt；如果
    // existing 存在（哪怕它还在 pending），新 attempt 必须先等它完全
    // 收尾（`.then()` 串联，不是各跑各的）才能起步——见上面 slot 类型
    // 注释里的竞态分析。`.catch(() => {})` 纯粹防御：runCloneAttempt 本身
    // 设计上不会 reject，但万一某天有人改坏了，也不该让一次意外 reject
    // 打断"新的必须排在旧的后面"这条串行链。
    const previous = existing?.promise ?? Promise.resolve();
    const slot: CloneAttemptSlot = {
      invalidated: false,
      promise: previous.catch(() => {}).then(() => runCloneAttempt(workspaceId, container)),
    };
    cloneAttempts.set(workspaceId, slot);
    return slot.promise;
  }

  /** 让下一次 ensure() 重新跑一次 clone——**不是**立刻摘掉当前这个 slot
      （复审二轮竞态修复，见 CloneAttemptSlot 的注释）：只打一个"已过期"
      标记，真正的替换动作留给 ensureRepoCloned 在下一次被调用时，串行
      在旧 attempt（含它自己的 cleanup）收尾之后。 */
  function invalidateClone(workspaceId: string): void {
    const existing = cloneAttempts.get(workspaceId);
    if (existing) existing.invalidated = true;
  }

  /** onCloneOutcome 是调用方（daemon.ts）给的回调，可能同步做 I/O（比如
      better-sqlite3 的 store.append）而抛出（磁盘满/SQLite 损坏，复审
      I5）——回调本身失败不该让 cloneAttempts 缓存的 promise 变成
      reject，那会让 ensure() 本身 reject，违反"绝不 throw 出 ensure()"
      这条设计红线。runCloneAttempt 的所有出口都过这个函数，不直接调
      opts.onCloneOutcome。 */
  function report(workspaceId: string, outcome: CloneOutcome): void {
    try {
      opts?.onCloneOutcome?.(workspaceId, outcome);
    } catch {
      // 吞掉——sandbox.ts 不做 console 之类的 IO 副作用（同文件其余 catch
      // 块的一贯做法），可观测性交给调用方自己的回调实现负责
    }
  }

  /** 旁路 clone 容器的取名：workspaceId + 一个不会撞的后缀。两条 attempt
      在时间上是串行的（见 ensureRepoCloned），但"上一台还没删干净、下一台
      就要建"这种重叠在 docker 侧仍然可能发生，重名会直接 409。 */
  let cloneSeq = 0;
  function cloneContainerName(workspaceId: string): string {
    cloneSeq += 1;
    return `otto-clone-${workspaceId}-${now().toString(36)}-${cloneSeq}`;
  }
  /** 本进程此刻正在用的旁路容器名——reconcile 扫 `mrotto.clone` 标签时
      要跳过它们（正在跑的 clone 不能被当成残骸删掉） */
  const liveCloneContainers = new Set<string>();

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
    const config = cfg;
    const label = safeRepoLabel(config.repoUrl);

    try {
      // 探现状用**水獭那台**容器（它已经在跑，挂着同一个卷）——只有真要
      // clone 时才多起一台旁路容器，幂等跳过不付那份钱
      const state = await probeWorkState(container);
      const decision = decideCloneAction(state, config.repoUrl);

      if (decision.action === "skip") {
        report(workspaceId, { kind: "skipped", repoUrl: label });
        return;
      }
      if (decision.action === "refuse") {
        report(workspaceId, { kind: "refused", repoUrl: label, reason: decision.reason });
        return;
      }

      const from = decision.action === "switch" ? decision.from : null;
      const result = await withCloneContainer(
        {
          docker,
          image,
          workspaceId,
          name: cloneContainerName(workspaceId),
          onCreated: (name) => liveCloneContainers.add(name),
          onReleased: (name) => liveCloneContainers.delete(name),
        },
        (cloneContainer) => performClone(cloneContainer, config),
      );

      if (!result.ok) {
        report(workspaceId, { kind: "failed", repoUrl: label, reason: result.reason });
        return;
      }
      report(
        workspaceId,
        from === null ? { kind: "cloned", repoUrl: label } : { kind: "switched", repoUrl: label, from },
      );
    } catch (err) {
      // performClone 内部已经把已知失败路径都转成 {ok:false,...} 不
      // throw；这里兜的是 probeWorkState/withCloneContainer（create/start/
      // remove 三次 docker 调用）自身意外抛出的情况——绝不能让 clone 相关
      // 的失败反过来拖垮 ensure() 本身（设计点 4）。repoUrl/reason 同样要过
      // safeRepoLabel/sanitizeCloneText——这里是另一处直接构造 CloneOutcome
      // 的地方，漏了就等于给复审三轮那道边界开了个后门
      const message = err instanceof Error ? err.message : String(err);
      report(workspaceId, { kind: "failed", repoUrl: label, reason: sanitizeCloneText(message, config) });
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

  /** 同一 workspaceId 的并发 ensure() 合成一次（issue #835①）。没有这层，
      同一工作区的两条会话同时起 turn 会各跑一遍"查不到 → createContainer"，
      后者拿 docker 的 409 Conflict（容器名唯一），那次工具调用直接报错。
      clone 那层的去重管不着这里：撞的是**建容器**，发生在 clone 之前。
      settle 之后立刻摘掉（不像 cloneAttempts 那样长留）——容器可能被
      sweepIdle 停掉，下一次 ensure 必须重新查一遍状态、必要时重新 start。

      与 invalidateClone 的交互（测试 ㉗ 钉住）：clone 还在跑的时候来的
      第二次 ensure 会**并进**上一次，所以它不会当场再跑一遍 clone——
      invalidateClone 的效力落在这一次 settle 之后的**下一次** ensure 上。
      这是有意的：owner 改配置那一刻正在跑的 clone 该跑完（它自己的旁路
      容器还开着），排一次重复的并发 clone 只会让两条 attempt 抢同一个卷。 */
  const ensureInFlight = new Map<string, Promise<ContainerLike>>();

  function ensure(workspaceId: string): Promise<ContainerLike> {
    const inflight = ensureInFlight.get(workspaceId);
    if (inflight) return inflight;
    const p = ensureOnce(workspaceId).finally(() => {
      ensureInFlight.delete(workspaceId);
    });
    ensureInFlight.set(workspaceId, p);
    return p;
  }

  async function ensureOnce(workspaceId: string): Promise<ContainerLike> {
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

  /** 一个 workspaceId 的容器/卷真的没了之后，把本进程对它的记忆一起丢掉
      （issue #835②）。少了这一步，`cloneAttempts` 里那条 settle 完刻意
      不删的记录会继续挡着：下次这个 workspaceId 又被 ensure() 到（工作区
      被误判成孤儿删掉、后来又活过来），拿到的是一台崭新的空容器，而缓存
      说"已经试过 clone 了"——于是它**再也不会 clone**，要等 daemon 重启。
      `lastActive` 同理：留着只会让 sweepIdle 每轮对着一个不存在的容器白
      查一次 findByName。 */
  function forget(workspaceId: string): void {
    cloneAttempts.delete(workspaceId);
    lastActive.delete(workspaceId);
  }

  /** 收走漏在机器上的一次性 clone 容器（issue #835⑤）。这种残骸里有 PAT，
      不能等孤儿宽限那 7 天——它出现的原因只有一个：daemon 在 clone 中途
      被杀（withCloneContainer 的 finally 没跑成）。本进程正在用的那几台
      按名字跳过；**别的进程正在用的那几台管不着**——同一台机器上不该有
      两个 runtime daemon（systemd 单实例），真出现了那也是更该修的问题。 */
  async function sweepCloneContainers(): Promise<void> {
    const list = await docker.listContainers({ all: true, filters: JSON.stringify({ label: [CLONE_LABEL] }) });
    for (const c of list) {
      const names = c.Names.map((n) => (n.startsWith("/") ? n.slice(1) : n));
      if (names.some((n) => liveCloneContainers.has(n))) continue;
      try {
        await docker.getContainer(c.Id).remove({ force: true });
      } catch {
        // 尽力而为：删不掉的下一轮再试（reconcile 每 5 分钟跑一次）。
        // 抛出去会让整轮 reconcile 腰斩，孤儿判定跟着停摆
      }
    }
  }

  async function reconcile(validWorkspaceIds: ReadonlySet<string>): Promise<{ marked: string[]; removed: string[] }> {
    const marked: string[] = [];
    const removed: string[] = [];
    const orphans = orphansStore.load();

    await sweepCloneContainers();

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
        forget(workspaceId); // 见 forget 的注释（issue #835②）
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
        forget(workspaceId); // 同上
        removed.push(workspaceId);
      }
    }

    orphansStore.save(orphans);
    return { marked, removed };
  }

  /** 工作区删除级联。**目前没有调用方**（issue #835③ 验过：全仓 grep 无
      命中）——runtime 没有"工作区被删了"的通知源，实际的删除路径是
      reconcile 的两阶段孤儿回收（mark → 7 天宽限 → remove）。留着这个
      方法是为了将来真接上删除事件时有个口子；在那之前，**reconcile 才是
      唯一会真的删东西的地方**，读这个文件的人别被这个方法误导。 */
  async function destroy(workspaceId: string): Promise<void> {
    const name = containerName(workspaceId);
    const found = await findByName(name);
    if (found) {
      await docker.getContainer(found.Id).remove({ force: true }); // 先删容器
    }
    await docker.getVolume(name).remove(); // 容器不存在时只走这一步，不炸
    forget(workspaceId); // 见 forget 的注释（issue #835②）
  }

  return { ensure, markActive, sweepIdle, reconcile, destroy, invalidateClone };
}
