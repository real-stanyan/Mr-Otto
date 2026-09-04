// cs（cloud session）帧协议——工作区云会话的线上约定（ADR-0199）。
// 与 wire.ts 同纪律：多端共用一份，只有类型 + 纯函数。
// 帧走 relay 的 payload 通道（cid 定向），内容是 base64url(JSON)。
// 事件只发给已过 hello 验籍的 cid——房名可猜，所以不存在房间级广播。

import type { SessionEvent } from "../../session/events.js";
import { b64decode, b64encode } from "./b64.js";
import { MAX_FRAME_BYTES } from "./wire.js";

/** 4（issue #844）：welcome/config_result 多了 `model` 一格，config 帧多了
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
export const CS_PROTOCOL_VERSION = 4;
export const CS_MAX_TEXT_BYTES = 64 * 1024;

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

/** 一个工作区此刻的模型配置（issue #844）。**key 本身永不下行**——同
    `CsRepoState.hasPat` 的纪律。runtime 自己不再持有任何模型 key：
    `config.ts` 的必需项里没有 MODEL_*，也不做 env 兜底，因为兜底等于
    「忘了配的工作区默默烧维护者的钱」，而那正是这一版要消灭的东西。 */
export interface CsModelState {
  baseUrl: string;
  modelId: string;
  hasKey: boolean;
}

/** 模型配置的结构化校验（issue #844）——两端共用一份，纪律同
    `validateRepoUrl`：渲染层那份只是提交前的早期提示，服务端必须自己再验
    一次（一个改造过的客户端能直接发 `http://127.0.0.1` 这类内网地址上来，
    而 runtime 是拿着平台身份在跑的）。
    只问 URL 解析器自己答得上来的问题：解析得开吗、是不是 https、
    有没有 host。modelId 只查非空与长度——型号 id 的字母表由各家厂商定，
    白名单会把还没出生的型号挡在外面。 */
export function validateModelConfig(
  rawBaseUrl: string,
  rawModelId: string
): { ok: true; baseUrl: string; modelId: string } | { ok: false; message: string } {
  const baseUrl = rawBaseUrl.trim();
  const modelId = rawModelId.trim();
  if (baseUrl === "") return { ok: false, message: "模型 API 地址不能为空。" };
  if (baseUrl.length > 2048) return { ok: false, message: "模型 API 地址太长了。" };
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, message: "这不是一条完整的模型 API 地址（要像 https://api.example.com/v1）。" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, message: `模型 API 地址必须是 https://（收到的是 ${parsed.protocol}）。` };
  }
  if (parsed.host === "") return { ok: false, message: "模型 API 地址里没有主机名。" };
  if (modelId === "") return { ok: false, message: "型号 id 不能为空。" };
  if (modelId.length > 256) return { ok: false, message: "型号 id 太长了。" };
  return { ok: true, baseUrl, modelId };
}

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
  /** 工作区配置。**两组字段各自可选**（issue #844）：给了 repoUrl 就改仓库，
      给了 model 就改模型，两个都不给是无操作。`pat` / `model.apiKey` 同款
      三态——省略 = 保持不变，`""` = 显式清除，非空 = 换成新的。密码框永远
      预填不了，"留空 = 清掉"会让"顺手改个型号"静默毁掉一把 key */
  | {
      t: "config";
      repoUrl?: string;
      pat?: string;
      model?: { baseUrl: string; modelId: string; apiKey?: string };
    }
  | { t: "archive" };

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
      /** 这个工作区此刻的模型配置（issue #844）。null = 还没配——这条云会话
          能建、能聊，但 @Agent 起不了 turn，owner 得先配一把自己的 key */
      model: CsModelState | null;
    }
  | { t: "created"; workspaceId: string; sessionId: string; channel: string }
  | { t: "denied"; code: CsDeniedCode }
  | { t: "event"; event: SessionEvent }
  | { t: "backlog"; events: SessionEvent[]; done: boolean }
  /** config 的回执（issue #834）。**不复用 `error`**：那条帧还承载
      backlog 跳过、审批失效之类跟配置无关的消息，客户端 await 它会被
      一条不相干的 error 提前唤醒。ok=false 时 message 说明为什么被拒
      （服务端校验不通过 / 保存失败），repo 是**服务端此刻的真实状态**，
      成功失败都带——失败时它正好告诉 owner「那你现在配的还是这个」 */
  | {
      t: "config_result";
      ok: boolean;
      message?: string;
      repo: CsRepoState | null;
      model: CsModelState | null;
    }
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

function normalizeModelState(v: unknown): CsModelState | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.baseUrl !== "string" || typeof o.modelId !== "string" || typeof o.hasKey !== "boolean") {
    return null;
  }
  return { baseUrl: o.baseUrl, modelId: o.modelId, hasKey: o.hasKey };
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
      // 两组字段各自可选（issue #844）：给了 repoUrl 就是在改仓库，给了
      // model 就是在改模型。类型不对（不是 string / 形状不对）一律判整帧
      // 无效——半个配置比没有配置更危险
      const { repoUrl, pat, model } = obj;
      if (repoUrl !== undefined && typeof repoUrl !== "string") return null;
      if (pat !== undefined && typeof pat !== "string") return null;

      const result: CsUp = { t: "config" };
      if (typeof repoUrl === "string") result.repoUrl = repoUrl;
      if (typeof pat === "string") result.pat = pat;

      if (model !== undefined) {
        if (typeof model !== "object" || model === null) return null;
        const m = model as Record<string, unknown>;
        if (typeof m.baseUrl !== "string" || typeof m.modelId !== "string") return null;
        if (m.apiKey !== undefined && typeof m.apiKey !== "string") return null;
        result.model =
          typeof m.apiKey === "string"
            ? { baseUrl: m.baseUrl, modelId: m.modelId, apiKey: m.apiKey }
            : { baseUrl: m.baseUrl, modelId: m.modelId };
      }
      return result;
    }

    if (t === "archive") {
      return { t: "archive" };
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
          model: normalizeModelState(obj.model),
        };
      }
      return null;
    }

    if (t === "config_result") {
      if (typeof obj.ok === "boolean" && (obj.message === undefined || typeof obj.message === "string")) {
        const result: CsDown = {
          t: "config_result",
          ok: obj.ok,
          repo: normalizeRepoState(obj.repo),
          model: normalizeModelState(obj.model),
        };
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
        return { t: "denied", code: obj.code };
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
