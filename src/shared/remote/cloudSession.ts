// cs（cloud session）帧协议——工作区云会话的线上约定（ADR-0199）。
// 与 wire.ts 同纪律：多端共用一份，只有类型 + 纯函数。
// 帧走 relay 的 payload 通道（cid 定向），内容是 base64url(JSON)。
// 事件只发给已过 hello 验籍的 cid——房名可猜，所以不存在房间级广播。

import type { SessionEvent } from "../../session/events.js";
import { b64decode, b64encode } from "./b64.js";
import { MAX_FRAME_BYTES } from "./wire.js";

/** 10（#1044）：加一对 `delete` / `delete_result`（控制房帧，形状与 `archive`
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
    8（#991，ADR-0234）：仓库配置从会话房搬进**控制房**——仓库是工作区的属性，
    配它不该以「开着一条这个工作区的云会话」为前提（文案类工作区压根没有仓库，
    头部常驻一格「未配仓库」是噪音）。`CsUp` 的 `config` 帧改带 `workspaceId`、
    只在控制房接；新增 `workspace{workspaceId}` 读帧，回 `workspace_state{repo,
    modelRoute}`（与 welcome 上那两格同形）；`config_result` 带回 `workspaceId`。
    会话房的 `config` 删了——出现在会话房视为越权，同 create。
    7（#981，ADR-0233）：云会话不再支持工作区自带 key——`config` 帧去掉 `model`，
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
    5（issue #945）：welcome/config_result 多了 `modelRoute` 一格——runtime 用
    decideRuntimeRoute 算好「这个工作区此刻的 turn 会走哪条路」下发，客户端不再
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
export const CS_PROTOCOL_VERSION = 10;
export const CS_MAX_TEXT_BYTES = 64 * 1024;

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

/** clone 判定的结局种类。与 runtime 侧 `CloneOutcome["kind"]` 是同一组值，
    但**这份是线上契约**：daemon 往 CsRepoState 里塞 outcome.kind 时由 tsc
    对齐两边（真分叉了 daemon 编译不过），不需要两处人肉同步。 */
export type CsCloneKind = "cloned" | "switched" | "skipped" | "refused" | "failed";

/** 一个工作区此刻的仓库配置 + 最近一次 clone 的结局（issue #834）。
    协议上原本**只有写路径**：owner 发一条 config 上去，服务端静默保存，
    没有回执也没有任何查询窗口——弹窗只能每次开成空白，clone 结果只在
    "恰好开着会话"的人的聊天流里出现一次。这个类型是那扇窗户。
    **token 本身永远不下行**，只回一个布尔。 */
export interface CsRepoState {
  /** 当前配的仓库地址（进服务端时已经过 validateRepoUrl，不含 userinfo） */
  url: string;
  hasPat: boolean;
  /** 最近一次 clone 判定。null = 还没判过（刚配完、还没有人触发工具调用） */
  clone: { kind: CsCloneKind; text: string; at: number } | null;
}

/** 仓库地址的**结构化白名单**校验（issue #834）——两端共用一份。

    刻意不是"检测这串里有没有藏凭据"那种黑名单：那条路在 #821 被复审
    连破三轮（全角 ＠、11 层嵌套 percent 编码…），教训写在
    `src/renderer/src/lib/cloudRepoUrl.ts` 的文件头。这里只问四个
    URL 解析器**自己**答得上来的问题：解析得开吗、是不是 https、
    userinfo 空不空、host 有没有。凭据在 git URL 里只能住在 userinfo，
    所以"username/password 都是空"这一条是结构性的，不依赖认出任何花样。

    服务端必须自己校验一次（frameHandler 的 config 分支），不能只靠渲染层：
    渲染层那份的定位是"提交前的早期 UX 提示"，一个改造过的客户端可以
    直接发一条 `ext::sh -c ...` 上来，那会以 root 在容器里执行。 */
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

/** 这个工作区此刻的 turn 会走哪条路（issue #945；ADR-0233 收成两态）。与 runtime 的
    `decideRuntimeRoute` 同源：hosted 带**实际会用的**型号（网关第一款，按 agent 各自的
    白名单会有差异，这一格答的是工作区默认那份）。blocked = 所有者没有活跃订阅 / 额度
    用完——云会话统一走所有者的订阅额度，没有第二条路。
    null = **runtime 探测本身抛错**——「拿不到」≠「起不了」，客户端别下结论。
    **edge 挂掉不长这样**：runtime 的订阅探针把失败缓存成「没有订阅」，所以一次 edge
    故障在这一格上表现为 `blocked`，与同一分钟真跑一个 turn 得到的结论一致 */
export type CsModelRoute =
  | { kind: "hosted"; model: string }
  | { kind: "blocked" };

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
  | { t: "say"; text: string; mention: boolean; mentions?: string[] }
  | { t: "backlog"; afterSeq: number }
  | { t: "approve"; callId: string; decision: "approved" | "denied" }
  /** 工作区的仓库配置——**控制房帧**（协议 8，#991）：带 `workspaceId`，不依赖
      任何一条会话。ADR-0233 之后只剩仓库这一组（模型统一走所有者订阅）。两格
      各自可选，都不给是无操作。`pat` 三态——省略 = 保持不变，`""` = 显式清除，
      非空 = 换成新的。密码框永远预填不了，"留空 = 清掉"会让"顺手改个地址"
      静默毁掉一个私有仓库的 token */
  | {
      t: "config";
      workspaceId: string;
      repoUrl?: string;
      pat?: string;
    }
  /** 读这个工作区的仓库状态 + 路由（控制房帧，协议 8）：回 `workspace_state`。
      任何在籍成员都能读——这两格本来就在 welcome 上给所有人看 */
  | { t: "workspace"; workspaceId: string }
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
      /** 这个工作区此刻的仓库配置与最近一次 clone 结局（issue #834）。
          搭在 welcome 上而不是另开一个查询往返：任何人一 join 就看得见，
          不用等"恰好有人在配"或"恰好开着会话时 clone 跑了一次" */
      repo: CsRepoState | null;
      /** 这个工作区此刻的 turn 会走哪条路（issue #945）：hosted / blocked / 探不到 */
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
  | { t: "backlog"; events: SessionEvent[]; done: boolean }
  /** config 的回执（issue #834）。**不复用 `error`**：那条帧还承载
      backlog 跳过、审批失效之类跟配置无关的消息，客户端 await 它会被
      一条不相干的 error 提前唤醒。ok=false 时 message 说明为什么被拒
      （服务端校验不通过 / 保存失败），repo 是**服务端此刻的真实状态**，
      成功失败都带——失败时它正好告诉 owner「那你现在配的还是这个」 */
  | {
      t: "config_result";
      /** 协议 8：回执说的是哪个工作区（控制房一条连接可以连着问几个） */
      workspaceId: string;
      ok: boolean;
      message?: string;
      repo: CsRepoState | null;
      /** 存完之后再探一次的路由判定（issue #945）——仓库配置不影响路由，带上只是
          让回执与 welcome 同形，界面一处画法 */
      modelRoute: CsModelRoute | null;
    }
  /** archive 的回执（协议 9，#993）。会话房那条路靠 `session_archived` 广播当回执
      （所有人都看得见的那一份），控制房没有房间可广播，得单独回一条 */
  | { t: "archive_result"; workspaceId: string; sessionId: string; ok: boolean; message?: string }
  /** delete 的回执（协议 10，#1044）。删除没有任何广播可当回执——房间收掉了，
      日志也没了，房里的人拿到的是 `session_archived`（删除先走一遍归档那条路，
      让还在看的人知道发生了什么）。`ok=false` 的 message 分得清三种：这条会话
      不存在 / 这一刻读不到（查询挂了，**不是**「不存在」）/ 删库那一步失败 */
  | { t: "delete_result"; workspaceId: string; sessionId: string; ok: boolean; message?: string }
  /** `workspace` 读帧的答复（协议 8，#991）：与 welcome / config_result 上那两格同形 */
  | { t: "workspace_state"; workspaceId: string; repo: CsRepoState | null; modelRoute: CsModelRoute | null }
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

function isCsCloneKind(v: unknown): v is CsCloneKind {
  return v === "cloned" || v === "switched" || v === "skipped" || v === "refused" || v === "failed";
}

/** 线上防呆：形状不对就整条帧判 null（同本文件其余 decode 的一贯做法）。
    `clone` 允许缺席——`null` 与"没这个键"都归成 null，少一次两端为了一个
    可选字段各自较劲的机会。 */
function isCsRepoState(v: unknown): v is CsRepoState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.url !== "string" || typeof o.hasPat !== "boolean") return false;
  if (o.clone === undefined || o.clone === null) return true;
  if (typeof o.clone !== "object") return false;
  const c = o.clone as Record<string, unknown>;
  return isCsCloneKind(c.kind) && typeof c.text === "string" && typeof c.at === "number";
}

/** 线上防呆（issue #945）：缺席、`null`、形状不对一律降级成 null，**不拒整帧**。
    解码永远向后兼容——一个还没升级的 runtime 发来的 welcome 少这一格是正常的，
    把它判成无效帧等于让客户端白等满超时。hosted 必须带非空 model：没有型号的
    hosted 界面上写不出任何有意义的东西，那和「探不到」是同一种处境 */
function normalizeModelRoute(v: unknown): CsModelRoute | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.kind === "hosted") return typeof o.model === "string" && o.model !== "" ? { kind: "hosted", model: o.model } : null;
  if (o.kind === "blocked") return { kind: "blocked" };
  return null;
}

/** decode 出来的 CsRepoState 一律走这里补齐 `clone`——调用方拿到的永远是
    `{url, hasPat, clone: X | null}`，不必再判"这个键在不在" */
function normalizeRepoState(v: unknown): CsRepoState | null {
  if (v === null || v === undefined) return null;
  if (!isCsRepoState(v)) return null;
  const o = v as unknown as { url: string; hasPat: boolean; clone?: CsRepoState["clone"] };
  return { url: o.url, hasPat: o.hasPat, clone: o.clone ?? null };
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
        if (obj.mentions === undefined) return { t: "say", text: obj.text, mention: obj.mention };
        // 形状不对就整帧拒掉,不是悄悄把字段丢了当没带 —— 后者会让一句
        // "@运营" 静默变成"谁都没点名",而那两件事该做的动作不一样
        if (!Array.isArray(obj.mentions) || obj.mentions.some((m) => typeof m !== "string")) return null;
        return { t: "say", text: obj.text, mention: obj.mention, mentions: obj.mentions as string[] };
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

    if (t === "config") {
      // 两格各自可选：类型不对（不是 string）一律判整帧无效——半个配置比没有
      // 配置更危险。`model` 那半边随 ADR-0233 删了：老客户端多发的 model 字段
      // 这里直接忽略（握手是精确相等，本来也连不上）。协议 8 起 workspaceId
      // 必填——缺了就不知道在配谁的仓库
      const { workspaceId, repoUrl, pat } = obj;
      if (typeof workspaceId !== "string") return null;
      if (repoUrl !== undefined && typeof repoUrl !== "string") return null;
      if (pat !== undefined && typeof pat !== "string") return null;

      const result: CsUp = { t: "config", workspaceId };
      if (typeof repoUrl === "string") result.repoUrl = repoUrl;
      if (typeof pat === "string") result.pat = pat;
      return result;
    }

    if (t === "workspace") {
      if (typeof obj.workspaceId === "string") return { t: "workspace", workspaceId: obj.workspaceId };
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
          repo: normalizeRepoState(obj.repo),
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

    if (t === "workspace_state") {
      if (typeof obj.workspaceId === "string") {
        return {
          t: "workspace_state",
          workspaceId: obj.workspaceId,
          repo: normalizeRepoState(obj.repo),
          modelRoute: normalizeModelRoute(obj.modelRoute),
        };
      }
      return null;
    }

    if (t === "config_result") {
      if (
        typeof obj.workspaceId === "string" &&
        typeof obj.ok === "boolean" &&
        (obj.message === undefined || typeof obj.message === "string")
      ) {
        const result: CsDown = {
          t: "config_result",
          workspaceId: obj.workspaceId,
          ok: obj.ok,
          repo: normalizeRepoState(obj.repo),
          modelRoute: normalizeModelRoute(obj.modelRoute),
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
