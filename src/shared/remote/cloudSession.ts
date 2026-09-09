// cs（cloud session）帧协议——团队云会话的线上约定（ADR-0199）。
// 与 wire.ts 同纪律：多端共用一份，只有类型 + 纯函数。
// 帧走 relay 的 payload 通道（cid 定向），内容是 base64url(JSON)。
// 事件只发给已过 hello 验籍的 cid——房名可猜，所以不存在房间级广播。

import type { SessionEvent } from "../../session/events.js";
import { b64decode, b64encode } from "./b64.js";
import { MAX_FRAME_BYTES } from "./wire.js";

/** 16（issue #1107）：`CsDown` 加 `delta` 帧——云会话的助手输出**流式下行**。
    与本机会话的 delta 同一份契约（`persistencePolicy` 的 `TransientPushKind`）：
    碎片是临时 UI 预览不是事实，**不进事件日志**，终态 `assistant_message`
    整份覆盖预览。帧不带 seq、不进 backlog、不参与去重；`text` 走**累计快照**
    语义（这只 agent 这一轮到此刻的完整正文），不是增量——中继掉帧、客户端
    中途 join、gone 后重连都不会在预览上咬出洞。runtime 侧按 agent 合帧
    （50ms，deltaStream.ts），不经任何限速桶（限速只管上行帧；下行的泄洪闸
    就是合帧本身 + 中继 256 KiB 单帧上限）。
    15（#1103）：Git 凭据回来了，但形状换了——**按「团队 + 主机」存，不绑仓库**。
    新增上行 `git_credential{workspaceId, host, token}`（`token: ""` = 删掉这台主机）
    与下行 `git_credential_result`；`workspace_state` 多一格 `gitHosts`。
    `CsGitHost = {host, addedBy, addedAt}` —— **没有 `hasToken`**：在这张清单里
    就等于有 token，一个恒为 true 的字段只会让人猜它什么时候是 false。
    **token 从不下行**（同 #834 那条纪律，只是那时下行的是 `hasPat` 布尔）。
    写/删只有 owner（判据同 `sandbox_approval`，ADR-0243：它花的是 owner 的额度、
    动的是共用的卷），读给任何在籍成员——「这个团队能认证 github.com」不是秘密，
    那把钥匙才是。
    14（#1102）：**repo 那一组整个走了**——`config` / `config_result` 两条帧删除，
    `welcome.repo` 与 `workspace_state.repo` 删除，`CsRepoState` 删除。团队不再
    绑一个仓库：ADR-0234 把仓库配置搬进设置页时，主语还是「这个团队的仓库是
    哪个」，而真正的主语是「水獭在哪儿干活」（ADR-0251 已经为「文件」那一页立过
    同一句）。仓库改由片 4（#1105）的 `clone_repo` 工具拉进来，**路径由用户自己
    决定**，凭据按「团队 + 主机」存（片 2，#1103）。
    `workspace` / `workspace_state` 这对帧**不删**：它还驮着 `modelRoute`
    ——ADR-0246 那句「起不了 turn」在设置页是它唯一的落点。
    减字段照样进位，理由同下面 7 那条。
    12（#1066）：再加一对 `files_search` / `files_search_result`（控制房读帧）——
    工作文件夹**搜得动**了，照右侧栏那个 Files 面板的规矩：直接输入 = 按文件名过滤，
    `?文本` = 内容搜索。容器镜像里有 ripgrep 13（`/usr/bin/rg`，真机验过），且
    `-w /work` 下 `rg --json` / `rg --files` 输出的相对路径与本机面板逐字同形，
    所以**判据共用 `src/shared/files.ts` 的 `parseRgJson`/`matchesFilter`/
    `classifyRgError` 那三个纯函数**，不另写一份（同 wire.ts 的纪律：两份迟早分家）。
    `CsWorkHit` 与本机的 `FileHit` 结构相同但**各是各的类型**——后者住在 Files 面板
    那一层，收窄/扩宽它会把本机那条路一起打红。
    11（#1056）：加一对 `files` / `files_result`（控制房读帧）——**工作文件夹看得见了**。
    这一页原来叫「仓库」，整页正文的头一句在解释「你可能用不到这一页」；而真正的主语
    是「水獭在哪儿干活」：每个团队都有一个共用工作目录（一容器一卷，ADR-0232），
    Git 仓库只是往那个目录里装东西的一种方式，而且是此前唯一做出来的一种。列得出
    内容之后，不配仓库的那半边人（文案、运营）打开这一页才有东西可看。
    读帧给**所有在籍成员**，判据同 `workspace`：卷是共用的，不是谁的私产。
    路径归一化 `src/shared/remote/workPath.ts` 三端共用；服务端在容器里还有第二道
    （realpath 之后必须仍在 /work 下）。文件内容有 `CS_WORK_FILE_MAX_BYTES` 上限，
    超了照发前半段并把 `truncated` 说出口——**不是**静默截断。
    10（#1044）：加一对 `delete` / `delete_result`（控制房帧，形状与 `archive`
    逐字相同）——**彻底删除一条云会话**。原来这颗钮不存在，理由是 0016 迁移把
    `wss_delete_publisher` 钉死在 `kind='package'`，云会话的创建者删不掉自己那行
    workspace_sessions（ADR-0235）。那条前提只对**客户端直连 Supabase** 成立：
    runtime 拿的是 service key，`EventStore.purge()` 也早就有（本机「彻底删除」
    用的就是它）。所以删不掉不是做不到，是没做。删除是不可逆的，且抹掉的是
    **一群人**的记录，谁能按由服务端判（与 archive 同一条：owner 或建的人）。
    9（#993，ADR-0235）：归档也搬进**控制房**——同上一条的判据：归档一条会话
    不该以「你此刻正开着它」为前提（界面上那颗钮因此只能待在会话头部，而它属于
    侧栏那条会话行的 ⋮ 菜单，同本地会话）。`archive` 帧带 `workspaceId` + `sessionId`、
    只在控制房接，新增 `archive_result` 回执（控制房没有会话房那条 `session_archived`
    广播可当回执）。会话房的 `archive` 删了——出现在会话房视为越权，同 create/config。
    8（#991，ADR-0234）：仓库配置从会话房搬进**控制房**——仓库是团队的属性，
    配它不该以「开着一条这个团队的云会话」为前提（文案类团队压根没有仓库，
    头部常驻一格「未配仓库」是噪音）。`CsUp` 的 `config` 帧改带 `workspaceId`、
    只在控制房接；新增 `workspace{workspaceId}` 读帧，回 `workspace_state{repo,
    modelRoute}`（与 welcome 上那两格同形）；`config_result` 带回 `workspaceId`。
    会话房的 `config` 删了——出现在会话房视为越权，同 create。
    7（#981，ADR-0233）：云会话不再支持团队自带 key——`config` 帧去掉 `model`，
    welcome/config_result 去掉 `model` 一格，`CsModelRoute` 去掉 `workspace`。
    减字段也进位：握手是精确相等，而「新桌面还画着一格永远为 null 的模型配置」
    正是这次要消灭的假话。
    6（#957 第三批）：`CsUp` 加 `stop`（谁能停与 approve 同一判据）；`CsDown` 加
    `say_result`/`approve_result`/`stop_result` 三条回执——桌面此前对 say/approve
    发出去之后没有任何确认信号，草稿清空/审批卡收起全靠乐观 UI，限速或权限被拒
    时界面已经把话当成发出去了。回执形状照 `config_result` 的先例：不复用
    `error`，那条帧还承载 backlog 跳过等不相干消息，await 它会被无关 error
    提前唤醒。旧 runtime × 新桌面 / 新 runtime × 旧桌面都走既有
    version_mismatch，不做双版本兼容。
    13（issue #1064）：`say` 多了 `memberMentions` 一格——「这句话点到了哪几个
    人类成员」。**加字段照样进位**（同下面 4 那条）：老 runtime 收到带这一格的
    say 会照常处理（多余字段被 decode 丢掉），但那意味着**通知静默不发**，而
    握手精确相等本来就把这种"看起来能用、其实少一半"的组合挡在外面。
    5（issue #945）：welcome/config_result 多了 `modelRoute` 一格——runtime 用
    decideRuntimeRoute 算好「这个团队此刻的 turn 会走哪条路」下发，客户端不再
    拿 `model === null` 推断「起不了 turn」（订阅用户走托管路照跑，那句是假的）。
    4（issue #844）：welcome/config_result 多了 `model` 一格，config 帧多了
    `model` 字段、`repoUrl` 变成可选（模型配置与仓库配置是两件独立的事，
    改一个不该被迫连另一个一起发）。
    3（issue #819）：denied 多了一个 `rate_limited` 码。
    2（issue #834）：welcome 多了 `repo`，下行多了 `config_result`。
    握手是**精确相等**（frameHandler 的 version_mismatch），两端同一个仓库
    一起发版，所以加字段照样要进位——桌面拿着 v1 连上 v2 的 runtime 会在
    hello 那一步就被明确拒绝，而不是收到一条它读不懂的 welcome 之后静默
    少一格状态。**加一个枚举值同理**：老客户端的 isValidCsDeniedCode 认不出
    `rate_limited`，decodeCsDown 回 null，那一帧被静默忽略，于是 create()
    要白等满超时才回一句"云端无响应"——把"你被限速了"说成"对面没回话"。 */
export const CS_PROTOCOL_VERSION = 16;
export const CS_MAX_TEXT_BYTES = 64 * 1024;

/** 一次回多少字节的文件内容（#1056）。中继单帧上限是 256 KiB（wire.ts 的
    `MAX_FRAME_BYTES`），这里取它的四分之一——JSON 转义、字段名、base64 都还要占
    地方，而「一个文件看不看得完」不该是靠贴着上限赌出来的。超了发前半段 +
    `truncated: true`，界面照实说「只显示前 64 KB」 */
export const CS_WORK_FILE_MAX_BYTES = 64 * 1024;

/** 「有一条事件太大，没发给你」这一类 error 帧的识别标记（终审 I2）。
    服务端两条路各产出一条这样的帧——backlog 分片时的
    `frameHandler.chunkBacklogFrames`（skip 分支）与直播扇出时的
    `daemon.globalSend`（编码失败的占位）——客户端
    （`main/cloudSessionClient.ts`）靠 `msg.includes(...)` 认出它、据此挂历史
    缺口横幅。**判据不是整句相等**：文案要带上 type/seq 才对排查有用，所以只能
    子串匹配；而子串两端各写一份字面量的话，改一个字这道判断就静默失效——
    而它修的正是「失败无声」（同 daemon 看门狗不认日志文案那条纪律）。
    放在协议文件里而不是任一端：它就是一条线上约定，形状同 wire.ts 的纪律。 */
export const BACKLOG_SKIP_MARKER = "已跳过";

/** 一个团队能认证哪台主机（#1103）。**这里没有 token**——它从不下行。
    `addedBy` 是 uid（渲染层自己去名单里换名字，同 `fromUid` 的纪律：改名不断账）。 */
export interface CsGitHost {
  host: string;
  addedBy: string;
  addedAt: number;
}

/** 仓库地址的**结构化白名单**校验（issue #834）——两端共用一份。

    刻意不是"检测这串里有没有藏凭据"那种黑名单：那条路在 #821 被复审
    连破三轮（全角 ＠、11 层嵌套 percent 编码…）——**输入校验做不完美，
    所以安全边界搬到输出侧**（`safeRepoLabel`）。这里只问四个
    URL 解析器**自己**答得上来的问题：解析得开吗、是不是 https、
    userinfo 空不空、host 有没有。凭据在 git URL 里只能住在 userinfo，
    所以"username/password 都是空"这一条是结构性的，不依赖认出任何花样。

    服务端必须自己校验一次，不能只靠渲染层：一个改造过的客户端可以直接发
    一条 `ext::sh -c ...` 上来，那会以 root 在容器里执行。

    **#1102 之后消费方换了人**：原来是 `config` 帧（团队绑一个仓库），
    现在是片 4（#1105）的 `clone_repo` 工具。校验的对象一个字没变——还是
    「用户给的一个仓库地址」，所以这个函数原样留着。 */
export function validateRepoUrl(raw: string): { ok: true; url: string } | { ok: false; message: string } {
  const url = raw.trim();
  if (url === "") return { ok: false, message: "仓库地址不能为空。" };
  if (url.length > 2048) return { ok: false, message: "仓库地址太长了。" };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      message: "这不是一条完整的仓库地址。云沙箱只支持 https:// 形式，不支持 SSH（git@host:path 写法）。",
    };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, message: `云沙箱只支持 https:// 的仓库地址（收到的是 ${parsed.protocol}）。` };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      message: "地址里不能带用户名或 token——token 请填到单独的 Personal Access Token 栏，地址只填不带凭据的那一段。",
    };
  }
  if (parsed.host === "") return { ok: false, message: "仓库地址里没有主机名。" };
  return { ok: true, url };
}

/** 这个团队此刻的 turn 会走哪条路（issue #945；ADR-0233 收成两态）。与 runtime 的
    `decideRuntimeRoute` 同源：hosted 带**实际会用的**型号（网关第一款，按 agent 各自的
    白名单会有差异，这一格答的是团队默认那份）。blocked = 所有者没有活跃订阅 / 额度
    用完——云会话统一走所有者的订阅额度，没有第二条路。
    null = **runtime 探测本身抛错**——「拿不到」≠「起不了」，客户端别下结论。
    **edge 挂掉不长这样**：runtime 的订阅探针把失败缓存成「没有订阅」，所以一次 edge
    故障在这一格上表现为 `blocked`，与同一分钟真跑一个 turn 得到的结论一致 */
export type CsModelRoute =
  | { kind: "hosted"; model: string }
  | { kind: "blocked" };

/** 工作文件夹里的一项（#1056）。`kind` 用 `find -printf %y` 那个字母的语义：
    目录 / 普通文件 / 其余一切（软链、设备、socket…）。`other` 不细分——这一页
    是给人看「水獭做了什么」的，把 fifo 和 socket 分开陈列没有任何人受益 */
export interface CsWorkEntry {
  name: string;
  kind: "dir" | "file" | "other";
  /** 字节数；目录这一格没有意义，一律 0 */
  size: number;
  mtimeMs: number;
}

/** `files` 读帧看到的东西（#1056）。
    **`absent` 与空目录是两回事**：前者 = 这个团队的容器还没建起来（第一次真让
    水獭干活时才建），后者 = 建起来了、里面还没有东西。两句话该说的不一样，合成
    一句就会对一个刚建群的人说「你的文件夹是空的」——而那个文件夹此刻并不存在。
    `binary` 单列一档，因为「读不出人话」不是失败：那是一张图、一个 zip，界面上
    该画的是名字和大小，不是一屏乱码。 */
/** 一条搜索命中（#1066）。结构与本机 Files 面板的 `FileHit` 相同——名字模式没有
    行号和行文本，两个字段都是 `null`；内容模式两个都有。故意不共用那个类型：
    它住在 Files 面板那一层，改它会把本机那条路一起打红 */
export interface CsWorkHit {
  /** 相对工作文件夹的路径，直接可以拿去发 `files` 帧 */
  rel: string;
  line: number | null;
  text: string | null;
}

/** 一次搜索最多回多少条。名字模式宽一些（一行就是一个路径），内容模式每条还带
    一行正文。两个数与本机面板的 `MAX_NAME_HITS`/`MAX_CONTENT_HITS` 取同一档 */
export const CS_WORK_NAME_HITS_MAX = 500;
export const CS_WORK_CONTENT_HITS_MAX = 200;

export type CsWorkNode =
  | { kind: "absent" }
  | { kind: "missing" }
  | { kind: "dir"; entries: CsWorkEntry[]; truncated: boolean }
  | { kind: "file"; text: string; truncated: boolean; size: number }
  | { kind: "binary"; size: number };

export function csCtlChannel(): string {
  return "cs-ctl";
}

export function csChannel(workspaceId: string, sessionId: string): string {
  return `cs-${workspaceId}-${sessionId}`;
}

/** 标准 UUID 的十六进制形状（8-4-4-4-12，全小写——workspaceId 来自 Supabase
    的 `gen_random_uuid()`，sessionId 来自 Node 的 `crypto.randomUUID()`，
    两者的规范文本形式都是小写）。 */
const UUID_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CS_SESSION_CHANNEL_RE = new RegExp(`^cs-${UUID_SEGMENT}-${UUID_SEGMENT}$`);

/** 精确判定「这是不是一条 cs 房间名」——不是「以 `cs-` 开头」（终审复审
    R1）。用于 edge.ts 的角色收口（role=host 只认平台身份）：好友代理的
    channelId 是 `b64encode(randomBytes(32))`（proxyInvite.ts），base64url
    字母表含 `-`（b64.ts），约 1/262144 的邀请码会生成 `cs-` 开头的房名——
    收口判据若只看前缀，撞上时代理房间里真人的 host 会被误降级成
    guest，A/B 双方都变 guest 后 relay.ts 的 `peersOf`/`otherRole` 只配对
    异角色，永远配不上、也没有任何报错（正是 relay.ts 文件头警告的那种
    失败形态）。精确匹配 `cs-ctl` 或 `cs-<uuid>-<uuid>`——要求精确长度 +
    十六进制字母表 + 固定短横线位置，随机 base64url 串撞不上；`Cs-`/
    `xcs-` 这类变体本来就落进空房间，不受影响。
    房名的构造（上面两个函数）与识别（这个函数）刻意放在同一处、同源于
    这份协议文件——分了家迟早会漂。 */
export function isCsChannel(channel: string): boolean {
  return channel === csCtlChannel() || CS_SESSION_CHANNEL_RE.test(channel);
}

export type CsDeniedCode =
  | "bad_jwt"
  | "not_member"
  | "version_mismatch"
  | "not_authorized"
  | "no_session"
  /** 超速了，稍后重试（issue #819）。**只用于控制房的 create**：会话房里
      客户端把 denied 当终态（markDenied 会直接断连接），而限速是"待会儿
      再来"，两者语义相反——会话房里的限速回的是 `error` 帧 */
  | "rate_limited";

/** 成员 → runtime */
export type CsUp =
  | { t: "hello"; v: number; jwt: string }
  | { t: "create"; workspaceId: string }
  /** 一条群发言。`mentions` = 点到的 **agent id**（起 turn 的那一族），
      `memberMentions` = 点到的**人类成员 uid**（协议 13，#1064）——两族分开带，
      因为它们的去处根本不同：前者进 `resolveTargets` 决定起几条 turn（花钱），
      后者只进收件箱（不起 turn、不花钱，只让被 @ 的人收到一条提醒）。
      合成一格再让服务端去分，等于要求服务端认得出哪个 id 是人——它只有 agent
      名单，人类 uid 会被静默丢掉，那正是 ADR-0252 留下的那半个承诺。
      服务端仍按此刻的成员名单复核并剔掉发言人自己，客户端这份不是权威 */
  | { t: "say"; text: string; mention: boolean; mentions?: string[]; memberMentions?: string[] }
  | { t: "backlog"; afterSeq: number }
  | { t: "approve"; callId: string; decision: "approved" | "denied" }
  /** 读这个团队此刻的路由 + Git 凭据清单（控制房帧，协议 8；协议 15 多了后者）：
      回 `workspace_state`。任何在籍成员都能读——路由本来就在 welcome 上给所有人看，
      凭据清单里没有 token（有哪几台主机不是秘密，那把钥匙才是） */
  | { t: "workspace"; workspaceId: string }
  /** 存 / 删一台主机的 Git 凭据（控制房帧，协议 15，#1103）。**owner 才受理**，
      服务端判。`token` 两态：非空 = 存这一把（同一台主机再存就是换新），
      `""` = **删掉这台主机**。
      没有第三态——「省略 = 保持不变」在这里没有意义：主机那一格本来就是主键，
      改 token 就是重新存一次。（这一点与 #834 那个 `pat` 三态不同，那时地址与
      token 是同一条记录的两格，密码框预填不了才需要「省略 = 别动」） */
  | { t: "git_credential"; workspaceId: string; host: string; token: string }
  /** 读工作文件夹的一格（控制房帧，协议 11，#1056）：回 `files_result`。
      `path` 是**相对工作文件夹**的路径（`""` = 它本身），发出去之前先过
      `normalizeWorkPath`；服务端不信任它，自己再归一化一次并在容器里
      realpath 兜底。任何在籍成员都能读——卷是整个团队共用的 */
  | { t: "files"; workspaceId: string; path: string }
  /** 搜工作文件夹（控制房帧，协议 12，#1066）：回 `files_search_result`。
      `content` = 搜正文（`?` 前缀那一路）还是只按文件名过滤。搜索**永远从工作
      文件夹的根开始**，不带 path——同本机那个面板：过滤框问的是「这个团队里
      有没有」，不是「这个目录里有没有」 */
  | { t: "files_search"; workspaceId: string; query: string; content: boolean }
  /** 收尾一条云会话——**控制房帧**（协议 9，#993）：带 workspaceId + sessionId，
      不依赖「正开着这条会话」。谁能归档由服务端判（owner 或建这条会话的人，
      issue #822 的判据原样）*/
  | { t: "archive"; workspaceId: string; sessionId: string }
  /** 彻底删除一条云会话——**控制房帧**（协议 10，#1044）：形状与 `archive` 相同，
      判据也相同（owner 或建这条会话的人，服务端自己判一次）。归档的会话同样能删，
      而且那才是最常删的一批——所以这条帧不要求会话此刻还开着房间。
      与归档的差别写在 `delete_result` 上：归档是「收尾，还看得见」，删除是
      「整段事件日志从 VPS 上抹掉，谁都再看不到」 */
  | { t: "delete"; workspaceId: string; sessionId: string }
  /** 停掉当前正在跑的这一轮 turn（#957 第三批）。谁能停与 approve 同一判据——
      发起人或 owner；已排队未跑的 job 照旧，停的是"这一轮"不是清队列。
      `seq`（add-only，协议号不变）= 客户端按的那一行开场白自己的 seq（复审
      C2-I3）。桌面按**行**画停止按钮，而不带任何 turn 标识的 stop 帧一律停
      "当前那一轮"——按第二行那颗，停掉的是第一行。服务端拿它与这一轮的采样
      边界比，更晚就回 `stop_result{ok:false}` 不动手。缺席 = 旧语义（停当前），
      旧客户端照常工作。 */
  | { t: "stop"; seq?: number };

/** runtime → 成员 */
export type CsDown =
  | {
      t: "welcome";
      v: number;
      sessionId: string;
      lastSeq: number;
      initiatorUid: string | null;
      ownerUid: string;
      /** 这个团队此刻的 turn 会走哪条路（issue #945）：hosted / blocked / 探不到 */
      modelRoute: CsModelRoute | null;
    }
  | { t: "created"; workspaceId: string; sessionId: string; channel: string }
  /** `v`（add-only，协议号不变）= **服务端**此刻的协议号（复审 C2-I6）。
      `version_mismatch` 是严格相等判出来的，而只有码没有版本号的话，桌面
      分不清"我旧了"还是"云端旧了"——这两件事该做的动作相反（更新 app vs
      联系维护者去部署 runtime），一句含糊的"版本不匹配"两边都指不出来。
      只有 `version_mismatch` 带它，别的码带上没有意义。缺席 = 老服务端，
      桌面退回原来那句通用文案。 */
  | { t: "denied"; code: CsDeniedCode; v?: number }
  | { t: "event"; event: SessionEvent }
  /** 助手输出的流式帧（协议 16，#1107）——**临时预览，不是事实**：不落日志、
      不带 seq、不进 backlog、不参与去重。`text` 是**累计快照**（这只 agent
      这一轮到此刻为止的完整正文），不是增量——中继掉帧 / 客户端中途 join /
      gone 后重连都不会在预览上咬出洞，丢一帧只是少一次刷新。同一 agent 的
      终态 `assistant_message` 事件到达时整份覆盖预览（与本地
      `streamingBySession` 同一份契约）。`agentId` 是 stable key 不是名字。
      `kind` 与 `ModelAdapter` 的 `DeltaKind` 同值；runtime 今天只发
      "content"（终态气泡不画 reasoning，预览也不画） */
  | { t: "delta"; agentId: string; kind: "content" | "reasoning"; text: string }
  | { t: "backlog"; events: SessionEvent[]; done: boolean }
  /** archive 的回执（协议 9，#993）。会话房那条路靠 `session_archived` 广播当回执
      （所有人都看得见的那一份），控制房没有房间可广播，得单独回一条 */
  | { t: "archive_result"; workspaceId: string; sessionId: string; ok: boolean; message?: string }
  /** delete 的回执（协议 10，#1044）。删除没有任何广播可当回执——房间收掉了，
      日志也没了，房里的人拿到的是 `session_archived`（删除先走一遍归档那条路，
      让还在看的人知道发生了什么）。`ok=false` 的 message 分得清三种：这条会话
      不存在 / 这一刻读不到（查询挂了，**不是**「不存在」）/ 删库那一步失败 */
  | { t: "delete_result"; workspaceId: string; sessionId: string; ok: boolean; message?: string }
  /** `workspace` 读帧的答复（协议 8，#991；协议 15 加 `gitHosts`）。#1102 摘掉
      `repo` 之后这对帧本来只剩 `modelRoute`——留着它是因为 ADR-0246 那句
      「起不了 turn」在设置页是它唯一的落点。
      `gitHosts` 缺席（`null`）= **这一刻读不到**，不是「一台都没配」：前者该说
      「读不到」，后者该画空态，两句话不一样（同 ADR-0243 对 `sandbox_approval`
      三态的处置） */
  | { t: "workspace_state"; workspaceId: string; modelRoute: CsModelRoute | null; gitHosts: CsGitHost[] | null }
  /** `git_credential` 的回执（协议 15，#1103）。形状照 `archive_result` 的先例：
      不复用 `error`（那条帧还承载别的消息，await 它会被不相干的 error 提前唤醒）。
      成功时带回**服务端此刻的**清单，界面直接换上——省一次往返，也省掉「我存完了
      但列表还是旧的」那种自相矛盾的中间态（#843 症状 1 的一般形式） */
  | { t: "git_credential_result"; workspaceId: string; ok: boolean; message?: string; gitHosts: CsGitHost[] | null }
  /** `files` 读帧的答复（协议 11，#1056）。`path` 回带是为了对上号（一条连接
      只问一次，但认一下比赌顺序便宜，同 workspace_state）。`ok=false` 的 message
      分得清「路径不合法」「容器里读失败」两种——两种该做的动作不一样 */
  | { t: "files_result"; workspaceId: string; path: string; ok: boolean; node?: CsWorkNode; message?: string }
  /** `files_search` 的答复（协议 12，#1066）。`hits: []` 与 `ok:false` 是两回事：
      前者 = 搜过了，没有；后者 = 没搜成。合成一句就会把「rg 挂了」说成「仓里没有」 */
  | { t: "files_search_result"; workspaceId: string; query: string; ok: boolean; hits?: CsWorkHit[]; message?: string }
  /** say 的回执（#957 第三批）。同 config_result 的纪律——不复用 error。
      ok=false 时 message 说明为什么（限速 / 不在籍 / 抛错），文案不变，只是
      换了个帧承载。 */
  | { t: "say_result"; ok: boolean; message?: string }
  /** approve 的回执（#957 第三批）。callId 让桌面把它跟自己发出去的那次
      approve 对上号——`pendingApprove` 是按 callId 分 Map 的。 */
  | { t: "approve_result"; callId: string; ok: boolean; message?: string }
  /** stop 的回执（#957 第三批）。ok=false 常见两种：没有在跑的 turn、或
      发起人/owner 之外的人点了停。 */
  | { t: "stop_result"; ok: boolean; message?: string }
  | { t: "error"; msg: string };

export function encodeCs(msg: CsUp | CsDown): string {
  // Check size limit for say.text
  if (msg.t === "say" && msg.text.length > 0) {
    const textBytes = new TextEncoder().encode(msg.text).byteLength;
    if (textBytes > CS_MAX_TEXT_BYTES) {
      throw new Error(
        `say.text exceeds ${CS_MAX_TEXT_BYTES} bytes: ${textBytes}`
      );
    }
  }

  const json = JSON.stringify(msg);
  const utf8 = new TextEncoder().encode(json);
  const encoded = b64encode(utf8);

  // Check entire frame size limit
  const frameBytes = new TextEncoder().encode(encoded).byteLength;
  if (frameBytes > MAX_FRAME_BYTES) {
    throw new Error(
      `cs frame exceeds ${MAX_FRAME_BYTES} bytes: ${frameBytes}`
    );
  }

  return encoded;
}

/** `undefined` 或一个纯字符串数组。两格点名（agent / 人类成员）共用这一条：
    形状不对整帧拒掉，不悄悄丢字段 */
function isOptionalStringArray(v: unknown): boolean {
  if (v === undefined) return true;
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isValidCsDeniedCode(v: unknown): v is CsDeniedCode {
  return (
    v === "bad_jwt" ||
    v === "not_member" ||
    v === "version_mismatch" ||
    v === "not_authorized" ||
    v === "no_session" ||
    v === "rate_limited"
  );
}

/** 线上防呆（issue #945）：缺席、`null`、形状不对一律降级成 null，**不拒整帧**。
    解码永远向后兼容——一个还没升级的 runtime 发来的 welcome 少这一格是正常的，
    把它判成无效帧等于让客户端白等满超时。hosted 必须带非空 model：没有型号的
    hosted 界面上写不出任何有意义的东西，那和「探不到」是同一种处境 */
/** 线上防呆（#1103）：缺席 / `null` / 不是数组 → `null`（= 这一刻读不到），
    **不拒整帧**。是数组时逐条过滤，形状不对的那条丢掉而不是整份判 null——
    一条坏记录不该让整张清单消失。空数组原样保留：`[]`（一台都没配）与
    `null`（读不到）是两回事，合并它们就是把「读不到」画成空态。 */
function normalizeGitHosts(v: unknown): CsGitHost[] | null {
  if (!Array.isArray(v)) return null;
  const out: CsGitHost[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.host !== "string" || o.host === "") continue;
    if (typeof o.addedBy !== "string" || typeof o.addedAt !== "number") continue;
    out.push({ host: o.host, addedBy: o.addedBy, addedAt: o.addedAt });
  }
  return out;
}

function normalizeModelRoute(v: unknown): CsModelRoute | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.kind === "hosted") return typeof o.model === "string" && o.model !== "" ? { kind: "hosted", model: o.model } : null;
  if (o.kind === "blocked") return { kind: "blocked" };
  return null;
}


/** 线上防呆（#1056）：认不出的形状一律回 null，调用方按「读到了但看不懂」处理。
    与 normalizeModelRoute 同纪律——**不拒整帧**，因为 `ok=false` 那一路的
    message 仍然是有用的信息 */
/** 命中列表的线上防呆（#1066）。**一条形状不对整份判无效**——少一条的清单和
    完整的长得一模一样，同 normalizeWorkNode 里目录项那条 */
function normalizeWorkHits(v: unknown): CsWorkHit[] | null {
  if (!Array.isArray(v)) return null;
  const out: CsWorkHit[] = [];
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null) return null;
    const h = raw as Record<string, unknown>;
    if (typeof h.rel !== "string") return null;
    if (h.line !== null && typeof h.line !== "number") return null;
    if (h.text !== null && typeof h.text !== "string") return null;
    out.push({ rel: h.rel, line: h.line as number | null, text: h.text as string | null });
  }
  return out;
}

function normalizeWorkNode(v: unknown): CsWorkNode | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.kind === "absent") return { kind: "absent" };
  if (o.kind === "missing") return { kind: "missing" };
  if (o.kind === "dir") {
    if (!Array.isArray(o.entries)) return null;
    const entries: CsWorkEntry[] = [];
    for (const raw of o.entries) {
      if (typeof raw !== "object" || raw === null) return null;
      const e = raw as Record<string, unknown>;
      if (typeof e.name !== "string" || typeof e.size !== "number" || typeof e.mtimeMs !== "number") return null;
      if (e.kind !== "dir" && e.kind !== "file" && e.kind !== "other") return null;
      entries.push({ name: e.name, kind: e.kind, size: e.size, mtimeMs: e.mtimeMs });
    }
    return { kind: "dir", entries, truncated: o.truncated === true };
  }
  if (o.kind === "file") {
    if (typeof o.text !== "string" || typeof o.size !== "number") return null;
    return { kind: "file", text: o.text, truncated: o.truncated === true, size: o.size };
  }
  if (o.kind === "binary") {
    if (typeof o.size !== "number") return null;
    return { kind: "binary", size: o.size };
  }
  return null;
}

function isSessionEvent(v: unknown): v is SessionEvent {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  // 浅校验 SessionEventBase 的三个必填字段。
  // 逐子类型的形状验证属于 EventStore 落盘侧的责任，
  // 这层是线上防呆，只验 base 字段。
  return (
    typeof obj.type === "string" &&
    typeof obj.seq === "number" &&
    typeof obj.sessionId === "string" &&
    typeof obj.ts === "number"
  );
}

export function decodeCsUp(b64: string): CsUp | null {
  try {
    const bytes = b64decode(b64);
    if (!bytes) return null;

    const json = new TextDecoder().decode(bytes);
    const msg = JSON.parse(json) as unknown;

    if (typeof msg !== "object" || msg === null) return null;
    const obj = msg as Record<string, unknown>;

    const t = obj.t;

    if (t === "hello") {
      if (
        typeof obj.v === "number" &&
        typeof obj.jwt === "string"
      ) {
        return { t: "hello", v: obj.v, jwt: obj.jwt };
      }
      return null;
    }

    if (t === "create") {
      if (typeof obj.workspaceId === "string") {
        return { t: "create", workspaceId: obj.workspaceId };
      }
      return null;
    }

    if (t === "say") {
      if (typeof obj.text === "string" && typeof obj.mention === "boolean") {
        // 形状不对就整帧拒掉,不是悄悄把字段丢了当没带 —— 后者会让一句
        // "@运营" 静默变成"谁都没点名",而那两件事该做的动作不一样。
        // memberMentions 同一条纪律：丢掉它 = 被 @ 的人永远收不到那条提醒，
        // 而发言人那侧完全无声（#1064）
        if (!isOptionalStringArray(obj.mentions)) return null;
        if (!isOptionalStringArray(obj.memberMentions)) return null;
        const say: Extract<CsUp, { t: "say" }> = { t: "say", text: obj.text, mention: obj.mention };
        if (obj.mentions !== undefined) say.mentions = obj.mentions as string[];
        if (obj.memberMentions !== undefined) say.memberMentions = obj.memberMentions as string[];
        return say;
      }
      return null;
    }

    if (t === "backlog") {
      if (typeof obj.afterSeq === "number") {
        return { t: "backlog", afterSeq: obj.afterSeq };
      }
      return null;
    }

    if (t === "approve") {
      if (
        typeof obj.callId === "string" &&
        (obj.decision === "approved" || obj.decision === "denied")
      ) {
        return { t: "approve", callId: obj.callId, decision: obj.decision };
      }
      return null;
    }

    if (t === "workspace") {
      if (typeof obj.workspaceId === "string") return { t: "workspace", workspaceId: obj.workspaceId };
      return null;
    }

    if (t === "git_credential") {
      // 三格全必填且都是 string：少一格就不知道在动谁的哪台主机，而 token 的
      // 空串是**有意义的取值**（删掉这台），不能与"没带这个键"混为一谈
      const { workspaceId, host, token } = obj;
      if (typeof workspaceId !== "string" || typeof host !== "string" || typeof token !== "string") return null;
      return { t: "git_credential", workspaceId, host, token };
    }

    if (t === "files_search") {
      // content 必填布尔：缺席意味着发送方在猜默认值，而两种模式跑的是两条命令
      if (typeof obj.workspaceId === "string" && typeof obj.query === "string" && typeof obj.content === "boolean") {
        return { t: "files_search", workspaceId: obj.workspaceId, query: obj.query, content: obj.content };
      }
      return null;
    }

    if (t === "files") {
      // path 必填（`""` 是合法值，代表工作文件夹本身）——缺席意味着发送方在
      // 猜默认值，而这一层不该替它猜
      if (typeof obj.workspaceId === "string" && typeof obj.path === "string") {
        return { t: "files", workspaceId: obj.workspaceId, path: obj.path };
      }
      return null;
    }

    if (t === "archive") {
      // 协议 9 起 workspaceId + sessionId 必填——不知道归档谁的话，这条帧没有意义
      if (typeof obj.workspaceId === "string" && typeof obj.sessionId === "string") {
        return { t: "archive", workspaceId: obj.workspaceId, sessionId: obj.sessionId };
      }
      return null;
    }

    if (t === "delete") {
      // 同 archive：不知道删谁的话这条帧没有意义，两格都必填
      if (typeof obj.workspaceId === "string" && typeof obj.sessionId === "string") {
        return { t: "delete", workspaceId: obj.workspaceId, sessionId: obj.sessionId };
      }
      return null;
    }

    if (t === "stop") {
      // 缺席即不带（旧客户端）；带了就校验形状——非负整数以外一律判**整帧
      // 无效**，而不是"当没带过"：后者会把一条本该被拒的停止悄悄升级成
      // "停掉当前那一轮"，正是这个字段要防的那件事
      if (obj.seq === undefined) return { t: "stop" };
      if (!Number.isInteger(obj.seq) || (obj.seq as number) < 0) return null;
      return { t: "stop", seq: obj.seq as number };
    }

    return null;
  } catch {
    return null;
  }
}

export function decodeCsDown(b64: string): CsDown | null {
  try {
    const bytes = b64decode(b64);
    if (!bytes) return null;

    const json = new TextDecoder().decode(bytes);
    const msg = JSON.parse(json) as unknown;

    if (typeof msg !== "object" || msg === null) return null;
    const obj = msg as Record<string, unknown>;

    const t = obj.t;

    if (t === "welcome") {
      if (
        typeof obj.v === "number" &&
        typeof obj.sessionId === "string" &&
        typeof obj.lastSeq === "number" &&
        (obj.initiatorUid === null || typeof obj.initiatorUid === "string") &&
        typeof obj.ownerUid === "string"
      ) {
        return {
          t: "welcome",
          v: obj.v,
          sessionId: obj.sessionId,
          lastSeq: obj.lastSeq,
          initiatorUid: obj.initiatorUid as string | null,
          ownerUid: obj.ownerUid,
          modelRoute: normalizeModelRoute(obj.modelRoute),
        };
      }
      return null;
    }

    if (t === "archive_result") {
      if (
        typeof obj.workspaceId === "string" &&
        typeof obj.sessionId === "string" &&
        typeof obj.ok === "boolean" &&
        (obj.message === undefined || typeof obj.message === "string")
      ) {
        const result: CsDown = { t: "archive_result", workspaceId: obj.workspaceId, sessionId: obj.sessionId, ok: obj.ok };
        if (typeof obj.message === "string") result.message = obj.message;
        return result;
      }
      return null;
    }

    if (t === "delete_result") {
      if (
        typeof obj.workspaceId === "string" &&
        typeof obj.sessionId === "string" &&
        typeof obj.ok === "boolean" &&
        (obj.message === undefined || typeof obj.message === "string")
      ) {
        const result: CsDown = { t: "delete_result", workspaceId: obj.workspaceId, sessionId: obj.sessionId, ok: obj.ok };
        if (typeof obj.message === "string") result.message = obj.message;
        return result;
      }
      return null;
    }

    if (t === "files_search_result") {
      if (
        typeof obj.workspaceId === "string" &&
        typeof obj.query === "string" &&
        typeof obj.ok === "boolean" &&
        (obj.message === undefined || typeof obj.message === "string")
      ) {
        const result: CsDown = { t: "files_search_result", workspaceId: obj.workspaceId, query: obj.query, ok: obj.ok };
        const hits = normalizeWorkHits(obj.hits);
        if (hits) result.hits = hits;
        if (typeof obj.message === "string") result.message = obj.message;
        return result;
      }
      return null;
    }

    if (t === "files_result") {
      if (
        typeof obj.workspaceId === "string" &&
        typeof obj.path === "string" &&
        typeof obj.ok === "boolean" &&
        (obj.message === undefined || typeof obj.message === "string")
      ) {
        const result: CsDown = { t: "files_result", workspaceId: obj.workspaceId, path: obj.path, ok: obj.ok };
        const node = normalizeWorkNode(obj.node);
        if (node) result.node = node;
        if (typeof obj.message === "string") result.message = obj.message;
        return result;
      }
      return null;
    }

    if (t === "workspace_state") {
      if (typeof obj.workspaceId === "string") {
        return {
          t: "workspace_state",
          workspaceId: obj.workspaceId,
          modelRoute: normalizeModelRoute(obj.modelRoute),
          gitHosts: normalizeGitHosts(obj.gitHosts),
        };
      }
      return null;
    }

    if (t === "git_credential_result") {
      if (
        typeof obj.workspaceId === "string" &&
        typeof obj.ok === "boolean" &&
        (obj.message === undefined || typeof obj.message === "string")
      ) {
        const result: CsDown = {
          t: "git_credential_result",
          workspaceId: obj.workspaceId,
          ok: obj.ok,
          gitHosts: normalizeGitHosts(obj.gitHosts),
        };
        if (typeof obj.message === "string") result.message = obj.message;
        return result;
      }
      return null;
    }

    if (t === "say_result") {
      if (typeof obj.ok === "boolean" && (obj.message === undefined || typeof obj.message === "string")) {
        const result: CsDown = { t: "say_result", ok: obj.ok };
        if (typeof obj.message === "string") result.message = obj.message;
        return result;
      }
      return null;
    }

    if (t === "approve_result") {
      if (
        typeof obj.callId === "string" &&
        typeof obj.ok === "boolean" &&
        (obj.message === undefined || typeof obj.message === "string")
      ) {
        const result: CsDown = { t: "approve_result", callId: obj.callId, ok: obj.ok };
        if (typeof obj.message === "string") result.message = obj.message;
        return result;
      }
      return null;
    }

    if (t === "stop_result") {
      if (typeof obj.ok === "boolean" && (obj.message === undefined || typeof obj.message === "string")) {
        const result: CsDown = { t: "stop_result", ok: obj.ok };
        if (typeof obj.message === "string") result.message = obj.message;
        return result;
      }
      return null;
    }

    if (t === "created") {
      if (
        typeof obj.workspaceId === "string" &&
        typeof obj.sessionId === "string" &&
        typeof obj.channel === "string"
      ) {
        return {
          t: "created",
          workspaceId: obj.workspaceId,
          sessionId: obj.sessionId,
          channel: obj.channel,
        };
      }
      return null;
    }

    if (t === "denied") {
      if (isValidCsDeniedCode(obj.code)) {
        // `v` 与 `stop.seq` 同一套规矩：缺席即不带，带了形状不对判**整帧
        // 无效**——一个撒谎的版本号会把方向指反，比没有版本号更糟
        if (obj.v === undefined) return { t: "denied", code: obj.code };
        if (!Number.isInteger(obj.v) || (obj.v as number) < 0) return null;
        return { t: "denied", code: obj.code, v: obj.v as number };
      }
      return null;
    }

    if (t === "event") {
      if (isSessionEvent(obj.event)) {
        return { t: "event", event: obj.event };
      }
      return null;
    }

    if (t === "delta") {
      // text 允许空串之外的一切字符串；kind 认不出一律拒整帧——content 与
      // reasoning 在界面上是两个槽，猜错了比不显示更糟
      if (
        typeof obj.agentId === "string" &&
        typeof obj.text === "string" &&
        (obj.kind === "content" || obj.kind === "reasoning")
      ) {
        return { t: "delta", agentId: obj.agentId, kind: obj.kind, text: obj.text };
      }
      return null;
    }

    if (t === "backlog") {
      if (
        Array.isArray(obj.events) &&
        typeof obj.done === "boolean"
      ) {
        // Validate each event
        if (!obj.events.every(isSessionEvent)) {
          return null;
        }
        return {
          t: "backlog",
          events: obj.events as SessionEvent[],
          done: obj.done,
        };
      }
      return null;
    }

    if (t === "error") {
      if (typeof obj.msg === "string") {
        return { t: "error", msg: obj.msg };
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}
