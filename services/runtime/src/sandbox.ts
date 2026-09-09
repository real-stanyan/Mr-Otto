// 沙箱编排 — 每团队一容器一卷，dockerode 直管（ADR-0199）。
// 命名约定 `otto-ws-<workspaceId>`：容器名与卷名共用同一个字符串，
// ensure/destroy/reconcile 都靠它按名找容器，不额外维护一张 workspaceId→containerId 表。
//
// 孤儿回收两阶段：reconcile 第一次见到"标签里的 workspace 不在 validIds 里"的容器只记一笔
// markedTs（内存 + 注入的 orphans 存取器落盘），过 orphanGraceMs（默认 7 天）才真删——
// 宽限期是留给"workspace 记录还没同步过来"这种误判空间，不是立刻判死刑。

import { Writable } from "node:stream";
import type { ContainerLike } from "../../../src/world/dockerWorld.js";
import type { CsWorkHit, CsWorkNode } from "../../../src/shared/remote/cloudSession.js";
import {
  buildWorkReadScript,
  buildWorkSearchScript,
  parseWorkReadOutput,
  parseWorkSearchOutput,
} from "./workFiles.js";

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

/** 容器停着就起一下。**`listedState` 是 `listContainers` 那一刻的快照，不是此刻的
    真相**，所以这里必须容忍 304。

    dockerode 把 docker 的 `304 container already started` 抛成异常，而 304 说的
    恰恰是我们想要的状态。三处调用方（`ensure` / `readWork` / `searchWork`）都是
    「先 list 再按 State 决定要不要 start」，两条帧同时进来时会双双看到 stopped、
    双双 start，赢的那条把容器拉起来，输的那条拿 304 抛出去——于是「打开团队
    「文件」tab」在容器被 idle 回收之后大概率读不出内容，而症状看着像随机
    （issue #1097：这一页展开着几层就同时发几条 `files` 帧，「刷新」更是一次全发）。

    只吞 304，其余照抛：`start()` 真失败（镜像没了、磁盘满了）必须继续是错误，
    否则下一步 `exec` 会拿到一句难懂得多的话。 */
async function startIfStopped(container: { start(): Promise<void> }, listedState: string): Promise<void> {
  if (listedState === "running") return;
  try {
    await container.start();
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 304) throw e;
  }
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
  destroy(workspaceId: string): Promise<void>; // 容器+卷一起删（团队删除级联）
  /** 容器此刻在不在跑（#1140）。只 list 不 start：wiki 快照缓存的判据是「停着 = 卷没变」，探这一下不许把它叫起来 */
  isRunning(workspaceId: string): Promise<boolean>;
  /** 读一格工作文件夹（#1056）。`path` 已过 `normalizeWorkPath`。
      **刻意不走 `ensure()`**：那条路会建容器、会跑 clone 流程、会重置 idle 计时。
      翻一眼文件是个**读**动作，不该有这些副作用——尤其不该让「打开设置页」
      触发一次可能长达十分钟的 clone。所以这里只认**已经存在**的那台容器：
      不存在 = `absent`（那意味着卷也还没有，这个团队真的一次活都没干过），
      停着就起一下（exec 要求容器在跑；起完照样 markActive，好让 sweepIdle
      认得它、30 分钟后收掉——不打点的话它反而永远没人扫）。
      抛错 = 容器里那次 exec 失败，调用方翻译成回执 */
  readWork(workspaceId: string, path: string): Promise<CsWorkNode>;
  /** 搜工作文件夹（#1066）。`content` = 搜正文还是只按文件名过滤。副作用纪律同
      `readWork`：不建容器、不跑 clone。容器不存在 = 空结果（没有卷就没有东西可搜，
      与 `absent` 说的是同一件事，而搜索这一格没有第二句话要讲） */
  searchWork(workspaceId: string, query: string, content: boolean): Promise<CsWorkHit[]>;
  /** 在团队容器里跑一段脚本（#1105 的三把 Git 刀用）。**走 `ensure()`**——
      与 `readWork` 刻意不建容器（ADR-0251）方向相反而理由一致：判据是「这个
      动作要不要往卷里写」，而 Git 那几把刀是写 */
  execWork(workspaceId: string, script: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** 在一次性旁路容器里跑一段**要凭据**的脚本（#1105）。凭据只活在那台容器的
      可写层，跑完整台删掉——ADR-0200 决策②那条不变量的另一个出口 */
  execSidecar(
    workspaceId: string,
    cfg: CloneRequest,
    script: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
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
//      "用了一阵才配仓库"的团队，水獭之前的产出被无声清空，而本期不许
//      push = 没有任何远程备份。现在 /work 的现状先探成 WorkState 四态，
//      再由纯函数决定 clone / switch / skip / refuse，**每条分支都有回执**。
//   4. clone 失败绝不向上抛出——ensure() 永远正常返回容器，只是内容是
//      空的；onCloneOutcome 回调自己抛出也不例外（复审 I5）。
//   5. 除 clone 本身给 10 分钟外，其余每条 exec 都套一个较短的默认超时
//      （复审 I6：ensure() 是 dockerWorld 拿容器句柄的唯一入口，任何一条
//      卡住不返回，这个团队之后所有工具调用永久挂起，没有看门狗）。
//   6. （#1102 删去）原来这一条讲的是 `Sandbox.invalidateClone`——owner 改
//      完仓库配置怎么让下一次 ensure() 重新 clone。团队不再绑仓库之后
//      这个问题不存在了：每次 `clone_repo` 就是一次显式调用，没有缓存要失效。
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
export function sanitizeCloneText(text: string, cfg: { repoUrl: string; pat?: string }): string {
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
    // 留下凭据碎片"——赌输一次就是把凭据广播给团队全体成员（复审四轮
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
    分叉，clone 失败的 reason 会直接进 chat_message 给团队成员看，裸
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
  // 先登记名字再建（不是建完再登记）：`sweepCloneContainers` 按标签扫，
  // 靠这份名单跳过"本进程正在用的"。反过来的话，createContainer 到
  // onCreated 之间那一小段里跑一次 reconcile，会把刚建出来的这台当成
  // 残骸删掉——窗口极小，但它引起的失败是"clone 莫名其妙失败了"，
  // 排查成本远大于把这两行换个顺序
  deps.onCreated(deps.name);
  try {
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
    }
  } finally {
    deps.onReleased(deps.name);
  }
}

/** clone 之前要求的最低可用空间（KiB）。**不是配额**（issue #836：真正的
    每卷配额要看存储驱动，overlay2+xfs prjquota 才支持 `--storage-opt
    size=`，而这台 runtime VPS 还没开出来、没法验），只是一道下限闸：
    挡不住"一个 50G 的仓库占 50G"，能挡住"磁盘已经快满了还起一次 clone
    把整台机器写死"——后者会连累这台机器上所有团队。 */
const MIN_FREE_KIB = 2 * 1024 * 1024; // 2 GiB

/** 真正跑一次 clone。**跑在旁路容器里**（调用方用 withCloneContainer 起，
    见那里的注释）：有 PAT 就先配好凭据（stdin 喂、绝不进 Cmd/URL），跑完
    整台容器删掉，凭据跟着没——所以这里没有任何 cleanup 代码，也不需要
    "确认写了凭据才清理"那套标记（issue #835⑤ 删掉的正是那一套）。

    永远返回结果，不 throw——已知的失败路径（helper 配置失败/凭据写入
    失败/空间不足/清空目标目录失败/clone 本身失败/repoUrl 解析失败/任何
    一步的 execInContainer 直接抛异常）全部转成 {ok:false, reason}。
    reason 一律过 sanitizeCloneText（既擦 pat，也擦 repoUrl 里可能藏的
    凭据）——它会被广播给团队全员。

    **#1102 之后暂时没有调用方**，片 4（#1105）的 `clone_repo` 工具接回来。
    到那时调用方的保证换了一条：目标是**用户指名的子目录**且已判定为
    `empty`（`cloneTargetState` 三态里唯一会走到这儿的那个），所以这里的
    `find -delete` 清的只可能是空目录——**新契约下它一个用户文件都碰不到**，
    这正是拆掉那张决策表之后省下的整类风险（#832 的教训是：清空是无声的，
    而它清掉的东西没有任何备份）。 */
export interface CloneRequest {
  /** https 仓库地址。**进来之前已经过 `validateRepoUrl`**（不含 userinfo） */
  repoUrl: string;
  /** 私有仓库的 token。经 stdin 喂给 `git credential approve`，绝不进 Cmd/URL */
  pat?: string;
  /** clone 进 `/work` 下的哪个子目录（#1105）。**必须已经过 `normalizeWorkPath`**。
      缺席 = `/work` 本身，那是 #1102 之前的老形状（今天没有调用方走那条）。

      给了子目录时**不做那一步 `find -delete`**：调用方（`clone_repo`）已经
      判过 `cloneTargetState === "empty"`，而那张三态表里没有任何一条会导向
      删除——#832 的教训是清空无声且不可逆 */
  subdir?: string;
}

async function performClone(
  container: ContainerLike,
  cfg: CloneRequest,
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
    // 子目录那条路（#1105）**跳过这一步**：调用方已经判过目标是空的，而这套
    // 东西里不该有任何一条会删用户文件的分支
    const clear = cfg.subdir === undefined
      ? await execInContainer(container, "find /work -mindepth 1 -delete")
      : { exitCode: 0, stdout: "", stderr: "" };
    if (clear.exitCode !== 0) {
      const detail = clear.stderr || clear.stdout || `exitCode ${clear.exitCode}`;
      return { ok: false, reason: sanitizeCloneText(`清空目标目录失败：${detail}`, cfg) };
    }

    // GIT_TERMINAL_PROMPT=0（issue #835 顺带）：私有仓库没配 PAT 时，让 git
    // **明确**报"需要凭据"而不是去摸终端——没有 tty 时它本来也会失败，但
    // 那条路的行为取决于镜像里有没有 askpass 之类的东西，不该靠环境碰运气。
    //
    // `--depth 1`（issue #836）：卷没有磁盘上限，而一个仓库最容易失控的
    // 部分是历史不是工作树（linux/chromium 这种，`.git` 比 checkout 大一个
    // 量级）。浅克隆把这一半砍掉，是 CI 的标准做法。代价是 `git log`/
    // `git blame` 只看得到 tip——**水獭自己能解**（系统提示里写了
    // `git fetch --unshallow`），比"整台 VPS 磁盘满了"这个代价小得多。
    // 这不是配额：一个 50G 的工作树照样是 50G，真配额见 #836 里验过的
    // 那两条路（这台机器 overlayfs + ext4，`--storage-opt size=` 用不了）
    const target = cfg.subdir === undefined ? "/work" : `/work/${cfg.subdir}`;
    const cloneCmd = `export GIT_TERMINAL_PROMPT=0\ngit clone --depth 1 -- ${shellQuote(repoUrl)} ${shellQuote(target)}`;
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

/** 一次带凭据的 clone：起一台一次性旁路容器（挂同一个卷）→ 配凭据 → clone →
    删容器。**这是「凭据不进水獭那台容器」这条不变量的唯一出口**（ADR-0200 决策②）。

    #1102 把它从 `ensure()` 的副作用里摘出来做成显式入口：调用方从「建容器时
    顺带 clone 绑定的那个仓库」换成片 4（#1105）那把 `clone_repo` 工具——由用户
    指名仓库与落地路径。签名里没有 workspace 配置的影子，因为不再有配置。

    永远返回结果不 throw（同 performClone）；`onCreated`/`onReleased` 让调用方
    维护「本进程正在用哪几台旁路容器」那份名单，`sweepCloneContainers` 靠它跳过。 */
export async function cloneWithSidecar(
  deps: {
    docker: DockerLike;
    image?: string;
    workspaceId: string;
    /** 旁路容器的名字。调用方保证同一时刻不重名（docker 重名直接 409） */
    containerName: string;
    onCreated?: (name: string) => void;
    onReleased?: (name: string) => void;
  },
  cfg: CloneRequest,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    return await withCloneContainer(
      {
        docker: deps.docker,
        image: deps.image ?? DEFAULT_IMAGE,
        workspaceId: deps.workspaceId,
        name: deps.containerName,
        onCreated: deps.onCreated ?? (() => {}),
        onReleased: deps.onReleased ?? (() => {}),
      },
      (container) => performClone(container, cfg),
    );
  } catch (err) {
    // 旁路容器本身建不起来/删不掉（withCloneContainer 会抛）——转成结果，
    // 理由同 performClone 的「永远返回结果」：调用方是一把要给人看回执的工具
    return { ok: false, reason: sanitizeCloneText(err instanceof Error ? err.message : String(err), cfg) };
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
  },
): Sandbox {
  const image = opts?.image ?? DEFAULT_IMAGE;
  const idleMs = opts?.idleMs ?? DEFAULT_IDLE_MS;
  const orphanGraceMs = opts?.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const now = opts?.now ?? (() => Date.now());
  const orphansStore = opts?.orphans ?? memoryOrphansStore();

  const lastActive = new Map<string, number>();

  function markActive(workspaceId: string): void {
    lastActive.set(workspaceId, now());
  }

  /** 按名查容器——docker 的 Names 带前导斜杠（"/otto-ws-x"），两种形式都认 */
  async function findByName(name: string) {
    const list = await docker.listContainers({ all: true, filters: JSON.stringify({ name: [name] }) });
    return list.find((c) => c.Names.some((n) => n === name || n === `/${name}`));
  }

  /** 同一 workspaceId 的并发 ensure() 合成一次（issue #835①）。没有这层，
      同一团队的两条会话同时起 turn 会各跑一遍"查不到 → createContainer"，
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
      await startIfStopped(container, found.State);
    }
    markActive(workspaceId);

    // clone 挂在这里——容器（不管是刚建的还是既有的）已经在跑，卷已经挂
    // 好。见文件头 git clone 设计要点块的注释；ensureRepoCloned 自己处理
    // "没配置""已经 clone 过""并发去重""失败不阻塞"这几件事，这里只是
    // 单纯地等它一下，不关心结果（结果走 onCloneResult，不走返回值）。
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

  /** 本进程此刻正在用的一次性旁路容器，按名字。`sweepCloneContainers` 靠它
      跳过"正在用的那几台"。

      **#1102 之后这个集合是空的**——团队不再绑仓库，本进程没有任何地方
      会起旁路容器。片 4（#1105）的 `clone_repo` 接回 `withCloneContainer`
      时把 `onCreated`/`onReleased` 接到这里，它就活过来了。
      **不能因为"现在总是空的"就把 sweepCloneContainers 一起删掉**：那道清扫
      收的是 daemon 被杀时漏在机器上、**里面有 PAT** 的残骸（issue #835⑤），
      而机器上此刻就可能躺着上一版留下的。 */
  const liveCloneContainers = new Set<string>();

  /** 一个 workspaceId 的容器/卷真的没了之后，把本进程对它的记忆一起丢掉
      （issue #835②）。`lastActive` 留着只会让 sweepIdle 每轮对着一个不存在
      的容器白查一次 findByName。 */
  function forget(workspaceId: string): void {
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

  /** 团队删除级联。**目前没有调用方**（issue #835③ 验过：全仓 grep 无
      命中）——runtime 没有"团队被删了"的通知源，实际的删除路径是
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

  async function isRunning(workspaceId: string): Promise<boolean> {
    const found = await findByName(containerName(workspaceId));
    return found?.State === "running";
  }

  async function readWork(workspaceId: string, path: string): Promise<CsWorkNode> {
    const found = await findByName(containerName(workspaceId));
    if (!found) return { kind: "absent" };

    const container = docker.getContainer(found.Id);
    await startIfStopped(container, found.State);
    markActive(workspaceId);

    const r = await execInContainer(container, buildWorkReadScript(path));
    if (r.exitCode !== 0) {
      throw new Error(`读工作文件夹失败（exit ${r.exitCode}）：${r.stderr.trim() || "没有错误输出"}`);
    }
    const parsed = parseWorkReadOutput(r.stdout);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.node;
  }

  async function searchWork(workspaceId: string, query: string, content: boolean): Promise<CsWorkHit[]> {
    const found = await findByName(containerName(workspaceId));
    if (!found) return [];

    const container = docker.getContainer(found.Id);
    await startIfStopped(container, found.State);
    markActive(workspaceId);

    const r = await execInContainer(container, buildWorkSearchScript(query, content));
    if (r.exitCode !== 0) {
      throw new Error(`搜工作文件夹失败（exit ${r.exitCode}）：${r.stderr.trim() || "没有错误输出"}`);
    }
    const parsed = parseWorkSearchOutput(r.stdout, query);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.hits;
  }

  async function execWork(workspaceId: string, script: string) {
    const container = await ensure(workspaceId);
    markActive(workspaceId);
    return execInContainer(container, script);
  }

  let sidecarSeq = 0;
  async function execSidecar(workspaceId: string, cfg: CloneRequest, script: string) {
    // 名字要不重（docker 重名直接 409），且带 CLONE_LABEL 让 reconcile 收得走
    // 崩在中途漏下的那台——里面有 PAT
    const name = `otto-clone-${workspaceId}-${Date.now()}-${sidecarSeq++}`;
    return withCloneContainer(
      {
        docker,
        image,
        workspaceId,
        name,
        onCreated: (n) => liveCloneContainers.add(n),
        onReleased: (n) => liveCloneContainers.delete(n),
      },
      async (container) => {
        if (cfg.pat !== undefined) {
          // 凭据先配好再跑正事——与 performClone 逐字走同一条路：**stdin，不进 argv**
          // （容器里跑着水獭自己的 bash，argv 会出现在 ps aux 里）
          const helper = await execInContainer(container, "git config --global credential.helper store");
          if (helper.exitCode !== 0) throw new Error("credential.helper 配置失败");
          const block = `protocol=https\nhost=${safeHostOf(cfg.repoUrl)}\nusername=${CREDENTIAL_USERNAME}\npassword=${cfg.pat}\n\n`;
          const fed = await execInContainer(container, "git credential approve", { stdin: block });
          if (fed.exitCode !== 0) throw new Error("凭据写入失败");
        }
        return execInContainer(container, script);
      },
    );
  }

  return { ensure, markActive, sweepIdle, reconcile, destroy, isRunning, readWork, searchWork, execWork, execSidecar };
}
