// frameHandler —— cid 世界的纯协调层（ADR-0199）：不碰网络，daemon 只做
// 「transport ↔ 它」的搬运（cid→transport 路由、事件扇出的已验籍名单，都是
// daemon.ts 装配层的活）。控制房（create 流程）与会话房（say/backlog/approve/
// config/archive）共用同一份 cid→{uid,label} 表：cid 由 relay 的 newCid()
// 现铸（`c${randomUUID().replace(/-/g,"").slice(0,12)}`，src/shared/remote/
// wire.ts:121）——12 个十六进制字符 = **48 bit** 随机（不是 UUID 的 ~122
// bit：版本位/变体位落在被截掉的那一段之后，slice(0,12) 反而躲过了它们，
// 所以这 48 bit 是纯随机，但只有 48 bit）。扁平 Map 撞号时是**静默覆盖**
// （后来者的 hello 直接顶掉先来者的 {uid,label}，不报错）不是报错；48 bit
// 空间的生日界在 2^24（约一千七百万）条并发连接附近才开始有感知的碰撞率，
// 这台 runtime 的真实并发规模远低于这个量级，可以接受——换来的是
// onGone(cid) 不用带房间信息也能正确清表（FrameHandler 接口就是这个形状：
// onGone 只认 cid）。
//
// 房名可猜（csChannel 是纯字符串拼接），所以「连上了」不代表「有权限」——
// 每条非 hello 的帧都先过这张表，没过表的 cid 什么都做不了。

import { validateGitHost } from "../../../src/shared/remote/gitHost.js";
import {
  BACKLOG_SKIP_MARKER,
  CS_PROTOCOL_VERSION,
  csChannel,
  decodeCsUp,
  encodeCs,
  type CsUp,
  type CsDeniedCode,
  type CsDown,
  type CsGitHost,
  type CsModelRoute,
  type CsWorkHit,
  type CsWorkNode,
  type CsWikiWriteReq,
} from "../../../src/shared/remote/cloudSession.js";
import { normalizeWorkPath } from "../../../src/shared/remote/workPath.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { throttleMessage, TURN_BUCKET, type FrameRateLimiter } from "./rateLimit.js";
import { SayRejectedError, type CloudSession } from "./sessionService.js";

/** backlog 一次性下发的分片阈值(终审 C2):明显低于 wire.ts 的 MAX_FRAME_BYTES
    (256 KiB,那是 base64 编码后的整帧硬上限)——留出安全边际。水獭在沙箱里
    read_file 一个 ~190KB+ 的 package-lock/打包产物/日志很常见,不分片时这类
    事件会让 encodeCs 直接抛错:daemon.ts 的 globalSend 扇出时 roster 后半收
    不到(静默分叉),backlog 重放时异常被 daemon.ts 的 .catch 吞掉、连 error
    帧都不回,客户端死等 done:true 永远停在 connecting。 */
const BACKLOG_CHUNK_BYTES = 128 * 1024;

function jsonByteLength(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).byteLength;
}

/** 把 backlog 要发的全量事件切成若干条 CsDown 帧:累计字节不超过
    maxChunkBytes 就合并进同一片。单条事件自己就超过阈值的——分片救的是
    "多条加起来大",救不了"一条本身就大",这种直接跳过、换一条可见的
    error 帧,不让它绑架同一批其余事件(整条云会话卡死)。**保证最后一条
    一定是 done:true 的 backlog 帧**,即使末尾全是被跳过的事件——否则客户端
    永远等不到 done:true,原地卡在 connecting(终审 C2 的原始复现)。 */
export function chunkBacklogFrames(
  events: SessionEvent[],
  maxChunkBytes: number = BACKLOG_CHUNK_BYTES
): CsDown[] {
  type Unit = { kind: "chunk"; events: SessionEvent[] } | { kind: "skip"; event: SessionEvent };
  const units: Unit[] = [];
  let current: SessionEvent[] = [];
  let currentBytes = 0;

  const flush = (): void => {
    units.push({ kind: "chunk", events: current });
    current = [];
    currentBytes = 0;
  };

  for (const e of events) {
    const bytes = jsonByteLength(e);
    if (bytes > maxChunkBytes) {
      if (current.length > 0) flush();
      units.push({ kind: "skip", event: e });
      continue;
    }
    if (current.length > 0 && currentBytes + bytes > maxChunkBytes) flush();
    current.push(e);
    currentBytes += bytes;
  }
  flush(); // 收尾:即使 current 是空数组,也要保证末尾是一条 done:true 的 backlog 帧

  return units.map(
    (u, i): CsDown =>
      u.kind === "skip"
        ? {
            t: "error",
            msg: `一条历史事件过大${BACKLOG_SKIP_MARKER}(type=${u.event.type}, seq=${u.event.seq}):单条超过下发上限`,
          }
        : { t: "backlog", events: u.events, done: i === units.length - 1 }
  );
}

/** encodeCs 的安全版本(终审 C2):daemon.ts 的 globalSend 既是广播 for-of
    循环体(对 roster 里每个 cid 广播同一条事件),也是上面 backlog 分片下发
    的落点——一条事件编码失败(超过 MAX_FRAME_BYTES)不许把异常甩给调用方:
    那个循环会被腰斩,后半 roster 静默收不到广播;再往上游,daemon.ts 的
    onEvent 钩子挂在 engine.ts 的 append() 里,那里没有 try/catch,一路能把
    整条 turn 带走。返回 null = 编码失败,调用方据此跳过这一次发送、只记
    日志不重抛。放在这个文件(而不是 daemon.ts 本体)是为了能单测——
    daemon.ts 自己不进 vitest(见该文件头注释),纯逻辑照旧全部下沉到已经
    有测试覆盖的这一层。 */
export function safeEncodeCs(msg: CsDown, onError: (err: unknown) => void): string | null {
  try {
    return encodeCs(msg);
  } catch (err) {
    onError(err);
    return null;
  }
}

export interface FrameHandlerDeps {
  /** JWT → uid。**异步**（与 brief 草图的同步签名不同,是本任务落地时的必要修正）：
      真实实现要过 services/edge/src/jwt.ts 的 verifyJwt,那是 WebCrypto
      （crypto.subtle.verify）,天生是 async 的——sync 签名在这里不可实现。
      这份接口只在本任务内定义、内消费（daemon.ts 是唯一装配者），改成
      async 不影响任何已交付任务的契约 */
  verifyJwt: (token: string) => Promise<{ userId: string } | null>;
  isMember: (workspaceId: string, uid: string) => Promise<boolean>;
  labelOf: (uid: string) => Promise<string>; // profiles 查询，查不到回 uid.slice(0,8)
  sessions: {
    get(workspaceId: string, sessionId: string): CloudSession | null;
    create(workspaceId: string, byUid: string): Promise<{ sessionId: string }>;
    ownerOf(workspaceId: string): Promise<string>;
    /** 收尾一条云会话（issue #822）：落日志（CloudSession.archive）+ 写
        Supabase 那行的 archived 列 + 收掉房间。三件事在 daemon 里，因为
        只有它同时握着 supabase 句柄和 transport。false = 已经归档过了 */
    archive(workspaceId: string, sessionId: string, byLabel: string): Promise<boolean>;
    /** 这条会话是谁建的（#1044）。`get()` 只认**活着的**房间，而归档的会话恰恰是
        最常被删的那批——所以这一格从 Supabase 那行现查。
        `null` = 确认这个团队里没有这条会话；**查询本身挂了要 throw**，
        不许兜底成 null：那等于把「这一刻读不到」说成「不存在」，同 ADR-0243
        那条纪律（读不到 ≠ 没有）。 */
    creatorOf(workspaceId: string, sessionId: string): Promise<string | null>;
    /** 彻底删除一条云会话（#1044）：先按归档那条路收尾（落 `session_archived`
        并广播 → 停这一轮 → 等排空 → 收房间），再删 Supabase 那行，最后
        `EventStore.purge` 抹掉整段日志。false = 删库那一步失败（日志还在，
        这条会话还能重开）。归档过的会话直接走后两步。 */
    remove(workspaceId: string, sessionId: string, byLabel: string): Promise<boolean>;
  };
  /** 这个团队能认证哪几台 Git 主机（#1103）。**实现必须保证不下发 token 本身**
      ——同 #834 那条 `hasPat` 纪律，只是这次连布尔都不用回：在清单里就等于有。
      抛异常 = 这一刻读不到，调用方回 `gitHosts: null`（不是空数组，见协议注释） */
  gitHosts: (workspaceId: string) => CsGitHost[];
  /** 存 / 删一台主机的凭据（#1103）。`token: ""` = 删。owner 判据在调用点，
      不在这里——这一层只管落盘 */
  putGitCredential: (workspaceId: string, host: string, token: string, addedBy: string) => void;
  /** 这个团队此刻的 turn 会走哪条路（issue #945）。async：要问一次订阅快照
      （hostedProbe 有 60s 缓存）。`ownerUid` 由调用点递进来而不是让实现自己再查
      一次——这一层每条 welcome/config 都已经 await 过 `sessions.ownerOf`，那是一次
      未缓存的 Supabase 往返，实现里再查一遍就是同一帧上打两到三次。
      回 null = **探测这一步自己抛了**（配置读取失败之类），客户端按「不知道」画；
      注意 edge 挂掉不走这条路——`createHostedProbe` 把失败缓存成「没有订阅」，
      于是那一分钟里这一格答 `blocked`，与同一分钟的 turn 得到的结论一致 */
  modelRoute: (workspaceId: string, ownerUid: string) => Promise<CsModelRoute | null>;
  /** 读一格工作文件夹（#1056）。**必需不是可选**（同 rateLimit / log 的理由）：
      写成可选的话，忘接线那天这一页安静地永远回「读不到」，而这一层没有任何
      别的信号能说出「其实是没接上」。`path` 这一层再归一化一次——客户端那次
      是省往返，不是安全边界。抛错 = 容器里读失败，回执照实说 */
  readWork: (workspaceId: string, path: string) => Promise<CsWorkNode>;
  /** 搜工作文件夹（#1066）。同 `readWork` 是必需的：忘接线那天这一格安静地
      永远搜不出东西，而「搜过了没有」与「压根没搜」在界面上长得一模一样 */
  searchWork: (workspaceId: string, query: string, content: boolean) => Promise<CsWorkHit[]>;
  /** 设置页改一页 wiki（协议 17，#1140）。**必需**（同 readWork 的理由）：写成可选的话，
      忘接线那天这条帧安静地永远拒——而这一层没有任何别的信号能说出「其实是没接上」。
      走 wikiService 与工具同一条写入路径（盖章 / 重生成 index / log / journal）；
      抛出的 Error.message 是给人看的那句（预算 / 路径 / 保留页），原样进回执 */
  writeWiki: (workspaceId: string, req: CsWikiWriteReq, author: { uid: string; label: string }) => Promise<void>;
  /** 三档令牌桶（issue #819）。**必需，不是可选**：过渡期烧的是维护者的
      模型 key，一个"忘了接线"的默认值等于把闸门悄悄拆了——这种东西不该
      靠记性，该靠编译错误。桶按 uid 分而不是按 cid：按 cid 分等于"多开
      几条连接就能多刷几次"。构造见 rateLimit.ts 的 createFrameRateLimiter */
  rateLimit: FrameRateLimiter;
  send: (cid: string, msg: CsDown) => void;
  /** 复审补漏：踢人只清 frameHandler 自己的验籍表（cids）是不够的——daemon.ts
      的实时广播走另一张表（roomRosters，只在 transport.onGone 时才清），
      不摘掉的话，被判定为"已不在籍"的 cid 仍然会继续收到该会话后续每一条
      onEvent 广播。`requireStillMember` 命中时调这个钩子，让 daemon 把
      同一个 cid 从广播名单/路由表里一并摘掉——**不关闭底层连接**（连接
      归 transport 管，这里只是不再主动往它发东西）。可选 = 不给就不摘
      （daemon.ts 是唯一装配者，总会给；测试假货可以留空）。daemon 侧的
      实现要求幂等——同一个 cid 既可能从这里被摘、也可能随后真的
      onGone，两条路径不能打架 */
  dropCid?: (cid: string) => void;
  /** 记一句。**必需不是可选**（同 rateLimit 的理由）：拒绝是这一层唯一的失败
      出口，而"拒绝了却没人知道"正是 #913/#915 各花掉半小时的那种形态——写成
      可选的话，忘接线的那天它会安静地什么都不记，而那正是最需要它的那天。 */
  log: (message: string) => void;
}

export interface FrameHandler {
  /** 控制房帧（create 流程） */
  onCtlFrame(cid: string, raw: string): Promise<void>;
  /** 会话房帧。房间身份 = (workspaceId, sessionId) 由 daemon 按 transport 归属传入 */
  onSessionFrame(workspaceId: string, sessionId: string, cid: string, raw: string): Promise<void>;
  onGone(cid: string): void;
}

interface CidEntry {
  uid: string;
  label: string;
}

/** hello 校验链的共用前半段：协议版本 → JWT 验签。会话房在此之上还要查
    在籍与 session 是否存在（见 onSessionFrame）；控制房到此为止——它不
    属于任何具体 workspace，在籍要留到 create 时才有 workspaceId 可查 */
async function verifyHello(
  deps: FrameHandlerDeps,
  v: number,
  jwt: string
): Promise<{ uid: string } | { denied: "version_mismatch" | "bad_jwt" }> {
  if (v !== CS_PROTOCOL_VERSION) return { denied: "version_mismatch" };
  const identity = await deps.verifyJwt(jwt);
  if (!identity) return { denied: "bad_jwt" };
  return { uid: identity.userId };
}

export function createFrameHandler(deps: FrameHandlerDeps): FrameHandler {
  const cids = new Map<string, CidEntry>();

  function deny(cid: string, code: CsDeniedCode): void {
    // 每一次拒绝都记一笔（issue #915）：真机上「新建云会话」回
    // not_authorized 的那次，服务器日志里一个字都没有，于是「谁拒的、为什么」
    // 只能靠读代码倒推。cid + code 就够定位，uid 不记——它是身份，而这条日志
    // 会进 journal
    deps.log(`拒绝 cid=${cid}：${code}`);
    // version_mismatch 单独带上**服务端**的协议号（复审 C2-I6）：判据是严格
    // 相等，只回一个码的话桌面分不清是自己旧了还是云端旧了，而这两件事该做的
    // 动作相反。别的码不带——它们与版本无关，带上只会让人以为那也是版本问题
    deps.send(
      cid,
      code === "version_mismatch"
        ? { t: "denied", code, v: CS_PROTOCOL_VERSION }
        : { t: "denied", code }
    );
  }

  /** 每个 cid 一条串行链（issue #915）。
   *
   *  病因：桌面的 create() 在**同一个 tick 里**连发 hello + create，而
   *  daemon 的接线是「来一帧起一个 promise」。hello 那条要 await 验签 **再**
   *  await labelOf（一次真 Supabase 往返），create 在这个窗口里被处理时
   *  `cids` 还是空的，于是落进「第一帧不是 hello」那条分支，回 not_authorized。
   *  `labelOf` 是网络调用 ⇒ 这不是偶发竞态，是近乎必然：云会话大概从来没建成过。
   *
   *  粒度是 **cid 不是全局**：两个不同客户端之间没有顺序要求，全局串行会把一个
   *  慢查询变成所有人的队头阻塞。
   *
   *  被否掉的修法记在 issue #915：在 await 之前先登记 cid（窗口变小但没消失，
   *  而且等于在验签完成前把未验籍的 cid 当已验籍——把竞态换成安全洞）、
   *  让桌面等一拍再发（控制房**故意没有 welcome**，没有可等的信号）。 */
  const chains = new Map<string, Promise<void>>();

  function serialize(cid: string, fn: () => Promise<void>): Promise<void> {
    const prev = chains.get(cid) ?? Promise.resolve();
    // `.then(fn, fn)`：前一条**抛了也要接着跑下一条**。只接成功路径的话，
    // 一次 Supabase 抖动会把这条连接的后续帧全部永久卡死
    const next = prev.then(fn, fn);
    // 链上存一份吞掉异常的，否则每个失败的环都变成 unhandledRejection
    const guarded = next.catch(() => {});
    chains.set(cid, guarded);
    void guarded.then(() => {
      // 只有还是自己那一环时才删——期间排进来的新帧已经把 map 指向了更后面
      // 的一环，删掉它等于把那条链摘断
      if (chains.get(cid) === guarded) chains.delete(cid);
    });
    // 回未吞异常的那一份：daemon 那边的 .catch(err => console.error) 仍然生效
    return next;
  }

  /** say/approve/config/backlog 能读写会话状态或敏感信息——被踢出团队
      的成员只要连接不断（wsTransport 心跳就是奔着长期不断线去的）就不该
      继续被当在籍成员对待（复审 Important：hello 之后从不复查在籍，被踢
      的成员能无限期发言/批审批；复审补漏：backlog 的 afterSeq 由客户端
      自己给、没有"只到踢出那一刻"的截断，读路径原样能拉到踢出之后新
      产生的全部事件）。命中时：① 把 cid 清出验籍表，效果等同 onGone——
      同一个 cid 之后再发任何帧都会落进「未过 hello」分支；② 调
      deps.dropCid，让 daemon 把同一个 cid 从广播名单/路由表里一并摘掉
      （否则 say/approve/config/backlog 都被拒之后，这个 cid 仍然会继续
      实时收到该会话后续的 onEvent 广播——那张表在 daemon.ts，frameHandler
      自己够不着）。isMember 自带 60s 缓存，边际成本很低。

      `beforeDeny`（#957 第三批）：say/approve/stop 这三种帧现在都有回执，而桌面
      为每一条挂着一个 pending（15 s 超时）。回执必须发在 `deny` **之前**：
      `dropCid` 一执行，daemon 的 `globalSend` 第一行就查不到这个 cid 的
      transport，之后再 send 什么都是静默丢帧。客户端那侧的 denied → 断线 →
      统一 settle 是第二道保险，不是第一道：靠它的话，"被踢了"这件事在界面上
      表现为"没有收到回执，不确定有没有生效"，而那是两件不同的事。 */
  async function requireStillMember(
    workspaceId: string,
    cid: string,
    uid: string,
    beforeDeny?: () => void
  ): Promise<boolean> {
    if (await deps.isMember(workspaceId, uid)) return true;
    beforeDeny?.();
    deny(cid, "not_authorized");
    cids.delete(cid);
    deps.dropCid?.(cid);
    return false;
  }

  /** 被踢时那三种回执共用的一句话：说"你已经不在这个团队了"，不说"失败了" */
  const NOT_MEMBER_MESSAGE = "你已经不在这个团队了。";

  /** 凭据清单，读不出来回 `null`。**`null` 与 `[]` 不是一回事**：前者是「这一刻
      读不到」，后者是「一台都没配」，界面上一句是红字一句是空态（同 ADR-0243 对
      `sandbox_approval` 三态的处置）。落盘那一层几乎不会抛，但「几乎」不是判据 */
  function readGitHosts(workspaceId: string): CsGitHost[] | null {
    try {
      return deps.gitHosts(workspaceId);
    } catch {
      return null;
    }
  }

  /** 存 / 删一台主机的凭据（协议 15，#1103）。**owner 判据在这里**——控制房里这是
      唯一的凭据写帧，会话房没有它。

      主机名服务端自己校验一次：渲染层那份的定位是"提交前的早期 UX 提示"，一个
      改造过的客户端可以直接发一条上来（同 validateRepoUrl 注释里那条理由）。 */
  async function applyGitCredential(
    cid: string,
    uid: string,
    msg: Extract<CsUp, { t: "git_credential" }>
  ): Promise<void> {
    const ownerUid = await deps.sessions.ownerOf(msg.workspaceId);
    if (uid !== ownerUid) {
      deny(cid, "not_authorized");
      return;
    }
    const fail = (message: string): void => {
      deps.send(cid, {
        t: "git_credential_result",
        workspaceId: msg.workspaceId,
        ok: false,
        message,
        gitHosts: readGitHosts(msg.workspaceId),
      });
    };

    const valid = validateGitHost(msg.host);
    if (!valid.ok) {
      fail(valid.message);
      return;
    }
    // token 上限：一把 PAT 再长也就百来字节，这里给的是「明显不是 token」的闸。
    // 不设的话这条帧就是一个能往 VPS 磁盘上写任意大小的口子
    if (msg.token.length > 4096) {
      fail("这一串太长了，不像一把访问令牌。");
      return;
    }

    try {
      deps.putGitCredential(msg.workspaceId, valid.host, msg.token, uid);
    } catch (err) {
      // 落盘失败以前只会冒到调用方的 .catch 里记一行日志，而 owner 那边的按钮
      // 照样显示「已保存」——回执这条路存在的意义就是别再这样（同 #834 的教训）
      fail(`保存失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    deps.send(cid, {
      t: "git_credential_result",
      workspaceId: msg.workspaceId,
      ok: true,
      gitHosts: readGitHosts(msg.workspaceId),
    });
  }


  const inner: FrameHandler = {
    async onCtlFrame(cid, raw) {
      const msg = decodeCsUp(raw);
      if (!msg) return; // 解不开的帧一律静默丢——线上字节永远可能是垃圾

      const entry = cids.get(cid);

      if (!entry) {
        if (msg.t !== "hello") {
          deny(cid, "not_authorized");
          return;
        }
        const result = await verifyHello(deps, msg.v, msg.jwt);
        if ("denied" in result) {
          deny(cid, result.denied);
          return;
        }
        const label = await deps.labelOf(result.uid);
        cids.set(cid, { uid: result.uid, label });
        // 控制房没有「welcome」概念——它不属于任何具体会话，成功静默即可，
        // 客户端下一步发 create，回执是 created 帧
        return;
      }

      if (msg.t === "hello") return; // 已验籍，重复 hello 当幂等刷新，不重复应答

      // 控制房认的帧（协议 8 起：create / workspace；协议 9 加 archive，
      // 协议 10 加 delete，协议 11 加 files，协议 12 加 files_search；协议 14
      // 拿走了 config——团队不再绑一个仓库，#1102；协议 17 加 wiki_write）——
      // 都是「关于某个团队」的动作，不挂在任何一条会话上。在籍是共同前提
      if (
        msg.t !== "create" && msg.t !== "workspace" && msg.t !== "git_credential" &&
        msg.t !== "archive" && msg.t !== "delete" && msg.t !== "files" &&
        msg.t !== "files_search" && msg.t !== "wiki_write"
      ) {
        deny(cid, "not_authorized");
        return;
      }

      if (!(await deps.isMember(msg.workspaceId, entry.uid))) {
        deny(cid, "not_member");
        return;
      }

      if (msg.t === "workspace") {
        // 读路径给所有在籍成员：这一格本来就在 welcome 上给所有人看
        const ownerUid = await deps.sessions.ownerOf(msg.workspaceId);
        deps.send(cid, {
          t: "workspace_state",
          workspaceId: msg.workspaceId,
          modelRoute: await deps.modelRoute(msg.workspaceId, ownerUid),
          gitHosts: readGitHosts(msg.workspaceId),
        });
        return;
      }

      if (msg.t === "files_search") {
        // 与 files 共用同一只桶：这两条帧是同一个动作的两半（翻 / 找），
        // 花的也是同一样东西（一次 docker exec）
        if (!deps.rateLimit.allow("files", entry.uid)) {
          deny(cid, "rate_limited");
          return;
        }
        const query = msg.query.trim();
        if (query === "") {
          // 空查询不下到容器：`rg --files` 会把整个仓库的文件名清单跑一遍，
          // 而调用方要的是「回到树」，那件事渲染层自己做得了
          deps.send(cid, { t: "files_search_result", workspaceId: msg.workspaceId, query: msg.query, ok: true, hits: [] });
          return;
        }
        try {
          const hits = await deps.searchWork(msg.workspaceId, query, msg.content);
          deps.send(cid, { t: "files_search_result", workspaceId: msg.workspaceId, query: msg.query, ok: true, hits });
        } catch (err) {
          // 「搜不成」不许说成「没有匹配」：后者会让人以为仓里真的没有这个东西
          deps.log(`files_search 失败（workspace=${msg.workspaceId}）：${String(err)}`);
          deps.send(cid, {
            t: "files_search_result", workspaceId: msg.workspaceId, query: msg.query, ok: false,
            message: err instanceof Error ? err.message : "这一刻搜不了工作文件夹。稍后再试。",
          });
        }
        return;
      }

      if (msg.t === "files") {
        // 读路径同 `workspace`：**所有在籍成员**。卷是整个团队共用的一份
        // （一容器一卷，ADR-0232），不是谁的私产；何况水獭做出来的东西正是
        // 群里其他人要看的那个东西
        if (!deps.rateLimit.allow("files", entry.uid)) {
          deny(cid, "rate_limited");
          return;
        }
        // 客户端那次归一化是省一次往返，这一次才是判据（渲染层与主进程都不是
        // 安全边界，同 validateRepoUrl 的注释）
        const path = normalizeWorkPath(msg.path);
        if (path === null) {
          deps.send(cid, { t: "files_result", workspaceId: msg.workspaceId, path: msg.path, ok: false, message: "这条路径不合法。" });
          return;
        }
        try {
          const node = await deps.readWork(msg.workspaceId, path);
          deps.send(cid, { t: "files_result", workspaceId: msg.workspaceId, path, ok: true, node });
        } catch (err) {
          // 「这一刻读不到」不许说成「里面是空的」（同 ADR-0243 那条三态纪律）：
          // 后者会让人以为水獭什么都没做出来
          deps.log(`files 读工作文件夹失败（workspace=${msg.workspaceId} path=${path}）：${String(err)}`);
          deps.send(cid, {
            t: "files_result", workspaceId: msg.workspaceId, path, ok: false,
            message: "这一刻读不到工作文件夹。稍后再试。",
          });
        }
        return;
      }

      if (msg.t === "wiki_write") {
        // 判据同 files：任何在籍成员。写路径由 wikiService 把关（保留页 / 预算 / 可疑指令），这里只管在籍与限速
        if (!deps.rateLimit.allow("wiki", entry.uid)) {
          deny(cid, "rate_limited");
          return;
        }
        const { t: _t, workspaceId, ...req } = msg;
        try {
          await deps.writeWiki(workspaceId, req, { uid: entry.uid, label: await deps.labelOf(entry.uid) });
          deps.send(cid, { t: "wiki_write_result", workspaceId, path: msg.path, ok: true });
        } catch (err) {
          deps.send(cid, { t: "wiki_write_result", workspaceId, path: msg.path, ok: false, message: err instanceof Error ? err.message : "这一刻改不了 wiki。稍后再试。" });
        }
        return;
      }

      if (msg.t === "git_credential") {
        await applyGitCredential(cid, entry.uid, msg);
        return;
      }

      if (msg.t === "archive") {
        // 谁能收尾（issue #822 的判据原样）：**owner 或建这条会话的人**。云端没有
        // "恢复归档"那一半（daemon 启动只捞 archived=false 的房间重开），所以这是
        // 个不可逆动作，不能让任意成员替所有人按下去。判据在服务端，客户端那颗
        // 菜单项的显隐只是 UX——渲染层不是安全边界
        const session = deps.sessions.get(msg.workspaceId, msg.sessionId);
        if (!session) {
          deps.send(cid, { t: "archive_result", workspaceId: msg.workspaceId, sessionId: msg.sessionId, ok: false, message: "这条会话不存在或已经归档了。" });
          return;
        }
        const ownerUid = await deps.sessions.ownerOf(msg.workspaceId);
        if (entry.uid !== ownerUid && entry.uid !== session.createdByUid()) {
          deny(cid, "not_authorized");
          return;
        }
        const done = await deps.sessions.archive(msg.workspaceId, msg.sessionId, entry.label);
        // 控制房没有会话房那条 `session_archived` 广播可当回执（房里的人照旧
        // 收得到那条事件，那是**他们**的回执）——按钮这一侧得单独有一条
        deps.send(cid, {
          t: "archive_result",
          workspaceId: msg.workspaceId,
          sessionId: msg.sessionId,
          ok: done,
          ...(done ? {} : { message: "归档没有生效：这条会话可能已经归档了。" }),
        });
        return;
      }

      if (msg.t === "delete") {
        // 谁能删 = 谁能归档（#822 的判据原样：owner 或建这条会话的人）。删除更狠
        // ——归档是「收尾，但还看得见」，删除把整段事件日志抹掉，而那段日志是
        // **一群人**（外加几只 agent）共同写的。判据仍然合并成一条：两颗钮并排
        // 住在同一个菜单里，「能按这颗不能按那颗」要另外有一套解释；何况云端的
        // 归档本来就没有回头路（daemon 只捞 archived=false 的会话重开房间），
        // 两件事都是单向门。判据在服务端，菜单项的显隐只是 UX。
        // 两次查询**一起等、一起收错**：分开写的话，同一个故障（Supabase 挂了）
        // 会因为先挂在哪一条上而产生两种行为——creatorOf 抛有回执，ownerOf 抛
        // 一路冒到 serialize 里被吞掉，客户端只能白等满 15 秒 ACK 超时。顺带省
        // 一次往返
        let creator: string | null;
        let ownerUid: string;
        try {
          [creator, ownerUid] = await Promise.all([
            deps.sessions.creatorOf(msg.workspaceId, msg.sessionId),
            deps.sessions.ownerOf(msg.workspaceId),
          ]);
        } catch (err) {
          // 「这一刻读不到」不许说成「不存在」（同 ADR-0243）：后者会让人以为
          // 已经删干净了，转头去别处找它
          deps.log(`delete 查会话失败（session=${msg.sessionId}）：${String(err)}`);
          deps.send(cid, {
            t: "delete_result", workspaceId: msg.workspaceId, sessionId: msg.sessionId,
            ok: false, message: "这一刻读不到这条会话的信息，什么都没删。稍后再试。",
          });
          return;
        }
        if (creator === null) {
          deps.send(cid, {
            t: "delete_result", workspaceId: msg.workspaceId, sessionId: msg.sessionId,
            ok: false, message: "这条会话不在这个团队里，可能已经被删掉了。",
          });
          return;
        }
        if (entry.uid !== ownerUid && entry.uid !== creator) {
          deny(cid, "not_authorized");
          return;
        }
        const done = await deps.sessions.remove(msg.workspaceId, msg.sessionId, entry.label);
        deps.send(cid, {
          t: "delete_result",
          workspaceId: msg.workspaceId,
          sessionId: msg.sessionId,
          ok: done,
          // 台账那行还在 = 这条会话还在（daemon 重启照样把它捞出来），所以这句
          // 说的是「没删成」而不是「删了一半」
          ...(done ? {} : { message: "删除没有生效：台账那一行没删掉，这条会话还在。" }),
        });
        return;
      }

      // 建会话是低频动作，但每条 = 一行 Supabase + 一个常驻 WebSocket 房间 +
      // 一份 EventStore（issue #819）。控制房里用 denied 而不是 error 帧：
      // create() 只认 created/denied 两种回执，回 error 等于让它白等满超时
      if (!deps.rateLimit.allow("create", entry.uid)) {
        deny(cid, "rate_limited");
        return;
      }

      const { sessionId } = await deps.sessions.create(msg.workspaceId, entry.uid);
      deps.send(cid, {
        t: "created",
        workspaceId: msg.workspaceId,
        sessionId,
        channel: csChannel(msg.workspaceId, sessionId),
      });
    },

    async onSessionFrame(workspaceId, sessionId, cid, raw) {
      const msg = decodeCsUp(raw);
      if (!msg) return;

      const entry = cids.get(cid);

      if (!entry) {
        if (msg.t !== "hello") {
          deny(cid, "not_authorized");
          return;
        }
        const result = await verifyHello(deps, msg.v, msg.jwt);
        if ("denied" in result) {
          deny(cid, result.denied);
          return;
        }
        if (!(await deps.isMember(workspaceId, result.uid))) {
          deny(cid, "not_member");
          return;
        }
        const session = deps.sessions.get(workspaceId, sessionId);
        if (!session) {
          deny(cid, "no_session");
          return;
        }
        const label = await deps.labelOf(result.uid);
        const ownerUid = await deps.sessions.ownerOf(workspaceId);
        cids.set(cid, { uid: result.uid, label });
        deps.send(cid, {
          t: "welcome",
          v: CS_PROTOCOL_VERSION,
          sessionId,
          lastSeq: session.lastSeq(),
          initiatorUid: session.initiatorUid(),
          ownerUid,
          modelRoute: await deps.modelRoute(workspaceId, ownerUid),
        });
        return;
      }

      if (msg.t === "hello") return; // 幂等刷新，同控制房

      const session = deps.sessions.get(workspaceId, sessionId);
      if (!session) {
        deny(cid, "no_session");
        return;
      }

      switch (msg.t) {
        case "say": {
          // 回执（#964）：桌面的 composer「草稿在发送成功之后才清」此前等的是
          // 一个**不存在**的信号——服务端对 say 从来不回话，成功与失败在客户端
          // 看来完全一样。三条出口（不在籍 / say() 的业务拒绝：限速、一句话
          // @ 太多、名单降级 / say() 的内部异常）各回一条
          // say_result{ok:false}，成功回 say_result{ok:true}
          //
          // **粗闸在 requireStillMember 之前**（#968）：isMember 再便宜也是
          // 一次 Supabase 往返（60s TTL 缓存扛不住每一帧都打一次），而
          // say 桶只是内存里的令牌桶——一个被限速的成员不该为了换回一句
          // "慢一点"去白付这次网络查询。拒绝走的措辞与载体和下面 budget
          // 里的 say 分支完全一致，只是提前到查名单之前
          if (!deps.rateLimit.allow("say", entry.uid)) {
            deps.send(cid, { t: "say_result", ok: false, message: throttleMessage("say") });
            return;
          }
          if (!(await requireStillMember(workspaceId, cid, entry.uid, () =>
            deps.send(cid, { t: "say_result", ok: false, message: NOT_MEMBER_MESSAGE })
          ))) return;
          // **两只桶管两件不同的事**（#968 修正 #819 的"一帧只记一个桶"，
          // 那条纪律的目的——被限的一个时段只记一笔——原样成立，见下方
          // onThrottled 按 (kind, uid) 去重）：say 桶是上面已经付过的
          // "有没有资格开口"粗闸，只看这一帧、不看点了几个名；turn 桶才是
          // 真正的价钱，由这句话实际会起几条模型调用决定——那要等 say()
          // 里 resolveTargets 解出真实 targets 才知道，一台省掉 mentions
          // 字段的客户端发一句 @ 了 40 个名字的话，若只按声称的数量扣，
          // 这边按 1 扣、那边却起 40 条真花钱的调用。所以问价仍然是一个
          // 回调递进 say()，turn 桶的数量由真实 targets 决定。
          // **超容量是拒绝不是夹价**：夹到桶容量等于第十一只往后每一只都
          // 免费，上一版正是这么写的；拒绝时把上限说出口，人才知道这不是
          // "等一会儿"能解决的事。拒绝一律走 say_result{ok:false}，不回
          // denied —— 客户端把 denied 当终态会直接断掉这条连接，而限速
          // 是"待会儿再来"
          const budget = (n: number): string | null => {
            if (n > TURN_BUCKET.capacity) return `一句话最多 @ ${TURN_BUCKET.capacity} 只（这条 @ 了 ${n} 只）`;
            if (n === 0) return null; // 没点名——这句话的钱已经在粗闸那次 say 令牌里付过了
            return deps.rateLimit.allow("turn", entry.uid, n) ? null : throttleMessage("turn");
          };
          // say() 在开场白落盘 + 入队后就 resolve，**不等 turn 跑完**（#937）：
          // serialize 把同一个 cid 的帧串成一条链，等在这里的话发起人自己的
          // approve 帧排在后面，而那条 turn 正等着这个审批——死锁到过期。
          // 抛错这条路以前只冒到 daemon 的 .catch 里记一行日志（#964）：发言人
          // 那侧是彻底的沉默——话没进日志、草稿被清掉、界面上什么都没有。
          // 现在把它翻成一条回执，与 config 那条路同一个形状
          try {
            await session.say(
              entry.uid, entry.label, msg.text, msg.mention, msg.mentions, budget, msg.memberMentions
            );
          } catch (err) {
            // 限速 / 一句话 @ 太多 / 名单降级都从 say() 抛 SayRejectedError
            // （#957 B2-C1、E2-4）：它是一句**说给发言人听**的业务拒绝，措辞
            // 本来就是给他看的，原样回过去；也不进下面 deps.log 的「say 失败」
            // —— 那条是内部异常的告警，把每一次正常限速都记成失败会把它淹掉
            if (err instanceof SayRejectedError) {
              deps.send(cid, { t: "say_result", ok: false, message: err.message });
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            deps.log(`say 失败 session=${sessionId} uid=${entry.uid}：${message}`);
            // **原文只进日志**（#957 终审 M4）：这条 catch 罩着的是内部异常
            // （Supabase 抖了、agents() 抛了、store.append 挂了），它的措辞是
            // 说给维护者听的——照搬给用户就是一句他既看不懂、也没有任何下一步
            // 动作的英文栈信息，还可能带上表名/uid 这类不该出门的东西。给他一句
            // 认得出的人话 + 一条能做的事（同 humanizeMcpError / humanizeBillingError
            // 的纪律：只翻认得出的，认不出的不硬翻，原文留在日志里）
            deps.send(cid, { t: "say_result", ok: false, message: "发送失败，请重试" });
            return;
          }
          // ok = **收下了**（开场白落盘 + 入队），不是"跑完了"：say() 在 #937
          // 之后就不等 turn 了，等就是死锁。桌面那颗草稿清空的判据本来就该是
          // 前者——"这句话进日志了没有"，不是"水獭答完了没有"
          deps.send(cid, { t: "say_result", ok: true });
          return;
        }

        case "backlog": {
          if (!(await requireStillMember(workspaceId, cid, entry.uid))) return;
          const events = session.backlog(msg.afterSeq);
          // 终审 C2：按累计字节分片下发，不再一帧打包全量——见文件头
          // chunkBacklogFrames 的注释，一条超限事件曾经能让整条云会话
          // 永久卡在 connecting
          for (const frame of chunkBacklogFrames(events)) deps.send(cid, frame);
          return;
        }

        case "approve": {
          if (!(await requireStillMember(workspaceId, cid, entry.uid, () =>
            deps.send(cid, { t: "approve_result", callId: msg.callId, ok: false, message: NOT_MEMBER_MESSAGE })
          ))) return;
          // 三态而不是布尔（#957 A-11/#927）：原来的 false 把"这条 pending 已经
          // 被消化/过期"和"你压根没资格批"糊成同一句模糊错误，也没有任何一行
          // 日志——拒绝是这一层唯一的失败出口，两种拒绝各自留痕才查得出"谁
          // 拒的、为什么"（同 #915 的教训）
          // 两句文案一字不改，换掉的是**载体**（#964）：`error` 帧不带 callId，
          // 客户端只能靠"此刻手上那张卡"猜它说的是哪一条——群聊里两只 agent
          // 各弹一张卡是常态，猜错就是把 A 的失败画在 B 的卡上。approve_result
          // 带 callId，回执与卡一一对应；成功也要回一条，否则那颗按钮的
          // submitting 只能等 15 s 超时自己醒来
          const outcome = session.approve(msg.callId, entry.uid, entry.label, msg.decision);
          if (outcome === "no_pending") {
            deps.log(`审批被拒 callId=${msg.callId} uid=${entry.uid}：no_pending`);
            deps.send(cid, { t: "approve_result", callId: msg.callId, ok: false, message: "这条审批已经处理过或已过期。" });
          } else if (outcome === "not_allowed") {
            deps.log(`审批被拒 callId=${msg.callId} uid=${entry.uid}：not_allowed`);
            deps.send(cid, { t: "approve_result", callId: msg.callId, ok: false, message: "只有发起人或 owner 能批这条审批。" });
          } else {
            deps.send(cid, { t: "approve_result", callId: msg.callId, ok: true });
          }
          return;
        }

        case "stop": {
          // 停一轮正在跑的 turn（#957 A-2）。谁能停 = **与审批逐字同一条判据**
          // （发起人或 owner），由 CloudSession.stop 里的 router.canDecide 判——
          // 这一层不复制那条判断，复制就迟早分家。
          // 三态都有回执：一颗点下去没有任何反应的停止按钮，比没有按钮更糟
          if (!(await requireStillMember(workspaceId, cid, entry.uid, () =>
            deps.send(cid, { t: "stop_result", ok: false, message: NOT_MEMBER_MESSAGE })
          ))) return;
          // 停止键也有桶（复审 Minor）：它不起模型调用、看着是免费的，但每一次
          // 成功的 stop 都往日志里落一条系统发言——日志是这条会话唯一的事实
          // 来源，按住不放能把它刷成一屏「某某停止了」。在籍复查之前不扣
          // （同 say：被踢的人该拿到"你不在这了"，不是"慢一点"）
          if (!deps.rateLimit.allow("stop", entry.uid)) {
            deps.send(cid, { t: "stop_result", ok: false, message: throttleMessage("stop") });
            return;
          }
          // `msg.seq` = 客户端按的那一行开场白的 seq（复审 C2-I3）。缺席 =
          // 旧客户端 / 旧语义（停当前那一轮），由 CloudSession.stop 放行
          const outcome = session.stop(entry.uid, entry.label, msg.seq);
          if (outcome === "ok") {
            deps.send(cid, { t: "stop_result", ok: true });
            return;
          }
          // 两种失败各记一笔（同 approve 的理由，#915 的教训）：拒绝是这一层
          // 唯一的失败出口，"谁按的、为什么没停下来"只有这行日志答得出
          deps.log(`停止被拒 session=${sessionId} uid=${entry.uid}：${outcome}`);
          deps.send(cid, {
            t: "stop_result",
            ok: false,
            message:
              outcome === "idle"
                ? "此刻没有正在跑的 turn"
                : outcome === "not_current"
                  // 三种失败要分开说：这一条不是"没权限"也不是"没得停"，而是
                  // "你点的那一行还没轮到"——说成前两句里的任何一句，人都会
                  // 以为按钮坏了，然后按住不放
                  ? "这一行的那句话还在排队，此刻在跑的是更早那一轮"
                  : "只有发起人或 owner 能停",
          });
          return;
        }

        case "create": // 控制房专用帧，出现在会话房里视为越权
        case "workspace": // 同上（协议 8，#991）
        case "git_credential": // 同上（协议 15，#1103）：凭据是团队的属性
        case "files": // 同上（协议 11，#1056）：工作文件夹是团队的，不是这条会话的
        case "files_search": // 同上（协议 12，#1066）
        case "wiki_write": // 同上（协议 17，#1140）：wiki 是团队的
        case "archive": // 同上（协议 9，#993）：归档不该以「你正开着这条会话」为前提
        case "delete": // 同上（协议 10，#1044）：删的多半是归档掉的那些，根本没有房间
        default:
          deny(cid, "not_authorized");
          return;
      }
    },

    onGone(cid) {
      cids.delete(cid);
    },
  };

  return {
    onCtlFrame: (cid, raw) => serialize(cid, () => inner.onCtlFrame(cid, raw)),
    onSessionFrame: (workspaceId, sessionId, cid, raw) =>
      serialize(cid, () => inner.onSessionFrame(workspaceId, sessionId, cid, raw)),
    onGone(cid) {
      inner.onGone(cid);
      // 链也要跟着走，否则这张表只增不减
      chains.delete(cid);
    },
  };
}
