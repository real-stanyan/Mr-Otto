// sessionPackage —— 「会话包」：把一次会话的完整快照打包成可传输的产物，
// 让好友收到后能在自己的机器上 fork 继续执行（issue #611）。
//
// 与 trajectoryExport（src/renderer/src/replay/trajectoryExport.ts）的区别：
// 那份是「拿出去分析」——所见即所得、jsonl 无损、不剥隐私（分析就是要看完整现场）；
// 这份是「交给另一个人继续跑」——必须过隐私闸，把发送方的个人记忆、本机快照 id、
// 本机绝对路径剥掉或改写，否则等于把自己的记忆和文件系统布局送给好友。
//
// 纯逻辑、零 IO：不读文件、不连 Supabase、不碰 SQLite。打包/解包只操作内存里的
// 结构化数据（SessionEvent[] + 附件字节表），IO 由 main 层的装配根做（AttachmentStore
// 读字节、Supabase Storage 上传下载、EventStore append 导入）。这是它能进 vitest
// 纯函数测试的前提——隐私闸这种命门必须有纯函数测试钉死。

import type { SessionEvent, UserAttachmentRef } from "../session/events.js";

// ─── 包的形状 ───────────────────────────────────────────────

/** manifest.json：包的身份与信封。读的人先看 kind/version 再解析其余 */
export interface SessionPackageManifest {
  kind: "otto.session-package";
  version: 1;
  /** 导出时刻（epoch ms） */
  exportedTs: number;
  /** 发送方留的「这个 fork 是去干什么的」一句话。空串 = 没留 */
  message: string;
  /** 源会话信息（溯源 + 给对方一个可读的标题，不给发送方的本机路径） */
  source: {
    sessionId: string;
    title: string | null;
    /** 导出时的模型 id（assistant_message.model 同口径），仅作展示 */
    model: string | null;
  };
  /** 隐私闸剥掉了哪些事件类型（让接收方/审计能看见「这份包被剥过」）。
      值是事件类型名。永远非空——这几个类型一旦出现必剥，见 PRIVACY_STRIP_TYPES */
  stripped: string[];
  /** 包内事件条数（剥隐私之后）。自洽校验用 */
  eventCount: number;
  /** 包内附件清单（id → 元数据）。附件字节本体在包文件里另存，这里只是台账 */
  attachments: UserAttachmentRef[];
}

/** 一份解包后的会话包：manifest + 事件流 + 附件字节表。
    事件流已经过隐私闸 + workspace 改写，可直接逐条 append 进接收方新会话 */
export interface SessionPackage {
  manifest: SessionPackageManifest;
  /** 完整 SessionEvent 流（已剥隐私、已改写）。顺序 = 发送方 seq 升序，
      但 seq/sessionId 是发送方的——导入时必须剥掉由接收方 EventStore 重分配 */
  events: SessionEvent[];
  /** 附件字节表：id（sha256:<hex>）→ 字节本体。events 里的 UserAttachmentRef
      只有元数据没有字节，字节在这里——不带它对方就缺图 */
  attachmentBytes: Record<string, Uint8Array>;
}

// ─── 隐私闸（本模块的命门）─────────────────────────────────

/** 导出时必须剥掉的事件类型。剥的理由各自不同，但共同点是：
    这些内容要么泄露发送方隐私，要么在接收方机器上没有意义。

    - request_envelope：烤着发送方渲染后的 system prompt 全文（含记忆快照、
      工具表）、思考档位。system prompt 里有「关于用户」的个人笔记——直接发等于
      把自己的长期记忆送给好友。fork 后由接收方自己的环境重新生成系统提示。
    - memory_loaded / memory_user_edit / memory_nudge：发送方的个人/项目记忆
      原文与编辑审计。同上，纯隐私泄露。deriveMessages 对缺了 memory_loaded 的
      日志是安全的——记忆块本来就设计成「没有就不渲」（见 deriveMessages 注释）。
    - checkpoint_created / workspace_restored：发送方本机 ~/.mr-otto/checkpoints
      里的快照 id。接收方机器上没有这份快照库，留着只是死引用。
    - branch_checked_out：发送方本机的 git 分支切换记录。接收方工作区不同，无意义。
    - project_instructions：发送方本机的指令文件——segments[].path 是本机绝对路径、
      content 是 AGENTS.md / CLAUDE.md 一类指令文件全文（issue #617）。与
      rewriteWorkspace 剥 session_created.workspace 完全同源：本机路径和项目私有
     指令原文都不该给对方。接收方导入后 projectInstructions.ts 会按他自己的目录
      重新爬升生成，deriveMessages 对缺了这条的日志是安全的（没有就不焊进 system）。
    - route_changed：发送方的**计费状态**（额度用完了 / 没订阅了 / 改用自带 key 了）。
      它是发送方账户的事，跟这段对话的内容无关；带进包里等于把「我这个月额度
      用光了」告诉每一个收到分享的人。同样地，它对接收方毫无用处——他重放这份
      日志时不会因为这条改道而走上另一条路（他有他自己的订阅与 key）。
    - session_shared：这条会话**以前还分享给过谁**、连带借出过哪几台服务
      （issue #705）。发给 B 的包里留着它，等于顺手告诉 B「我还把这个给了小红，
      而且把 Shopify 借给了她」——发送方的社交关系与授权史，两样都不是 B 该看的。
      它本来也只是发送方时间线上的一行记录，对接收方没有任何用处。
    - session_topic_assigned / session_topic_set（#846）：A 的记忆第四档主题桶
      分类结果——A 自己的生活/工作分类法，是 A 的私有 taxonomy，标准同
      checkpoint_created / session_shared：接收方机器上没有这份桶索引（甚至
      桶已经被 A 删了），留着的 slug 在 B 那边没有意义，也不该暴露 A 把这段
      对话归进了哪个私人分类。

    注意「剥」不等于「删改历史」——这是导出时刻的投影裁剪，源会话的 append-only
    日志一个字节不动。硬规则（append-only 是唯一事实来源）管的是源日志，不管
    发给别人的那份副本。 */
export const PRIVACY_STRIP_TYPES: ReadonlySet<SessionEvent["type"]> = new Set([
  "request_envelope",
  "memory_loaded",
  "memory_user_edit",
  "memory_nudge",
  "checkpoint_created",
  "workspace_restored",
  "branch_checked_out",
  "project_instructions",
  "session_shared",
  "session_topic_assigned",
  "session_topic_set",
  "route_changed",
]);

/** 过隐私闸：返回 { kept, stripped }。
    kept = 可进包的事件（顺序保留），stripped = 被剥掉的事件类型名（去重、排序，
    写进 manifest.stripped 让这份包「被剥过」这件事可审计）。
    纯函数，不改传入数组。 */
export function applyPrivacyGate(events: readonly SessionEvent[]): {
  kept: SessionEvent[];
  stripped: string[];
} {
  const kept: SessionEvent[] = [];
  const stripped = new Set<string>();
  for (const e of events) {
    if (PRIVACY_STRIP_TYPES.has(e.type)) {
      stripped.add(e.type);
      continue;
    }
    kept.push(e);
  }
  return { kept, stripped: [...stripped].sort() };
}

// ─── workspace 改写 ─────────────────────────────────────────

/** session_created.workspace 是发送方的本机绝对路径（/Users/stan/...），
    在接收方机器上要么不存在、要么更糟——指向一个意外真实存在的目录。
    导入时围栏（ExecutionWorld 圈定的工作目录）必须以接收方选定的目录为准，
    所以导出时把它剥掉，由接收方在导入时填自己的。
    返回改写过的事件副本；不是 session_created 或没有 workspace 就原样返回。 */
export function rewriteWorkspace(event: SessionEvent): SessionEvent {
  if (event.type !== "session_created") return event;
  // 剥掉 workspace / workspaceKind——围栏来源是接收方，不是发送方的路径。
  // forkedFrom 也剥掉：那指向发送方机器上的源会话 id，跨机器无意义，
  // 接收方导入后会建立自己的 forkedFrom（指向导入产生的新源）。
  const { workspace: _w, workspaceKind: _k, forkedFrom: _f, ...rest } = event;
  return rest as SessionEvent;
}

// ─── 打包 / 解包 ───────────────────────────────────────────

/** 收集事件流里引用到的全部附件 ref（user_message.attachments + tool_result.images）。
    去重按 id——同一张图被多次引用只收一次（内容寻址天然去重，同 AttachmentStore） */
export function collectAttachmentRefs(events: readonly SessionEvent[]): UserAttachmentRef[] {
  const byId = new Map<string, UserAttachmentRef>();
  for (const e of events) {
    const refs: UserAttachmentRef[] | undefined =
      e.type === "user_message" ? e.attachments : e.type === "tool_result" ? e.images : undefined;
    if (!refs) continue;
    for (const r of refs) if (!byId.has(r.id)) byId.set(r.id, r);
  }
  return [...byId.values()];
}

export interface PackInput {
  /** 源会话的完整事件流（load() 出来的，含 fork 链前缀已展平） */
  events: SessionEvent[];
  /** 发送方留言 */
  message: string;
  /** 源会话标题（展示用） */
  title: string | null;
  /** 导出时刻的模型 id（展示用） */
  model: string | null;
  /** 导出时刻 */
  exportedTs: number;
  /** 附件字节表：调用方（main 层）用 AttachmentStore.read 把 collectAttachmentRefs
      找到的每个 id 读成字节填进来。缺的 id 不在表里 = 那个附件字节丢了，
      打包不因此失败（同 ADR-0009 取舍：缺图退成提示，不炸整份包） */
  attachmentBytes: Record<string, Uint8Array>;
}

/** 打包：过隐私闸 → 改写 workspace → 收集附件台账 → 出包。
    返回的包可以直接喂给「序列化成文件」那一层（PR#2 上传用）。 */
export function packSession(input: PackInput): SessionPackage {
  const { kept, stripped } = applyPrivacyGate(input.events);
  const rewritten = kept.map(rewriteWorkspace);
  const sourceId = input.events[0]?.sessionId ?? "unknown";
  const refs = collectAttachmentRefs(rewritten);
  const manifest: SessionPackageManifest = {
    kind: "otto.session-package",
    version: 1,
    exportedTs: input.exportedTs,
    message: input.message,
    source: { sessionId: sourceId, title: input.title, model: input.model },
    stripped,
    eventCount: rewritten.length,
    attachments: refs,
  };
  // 只带「找得到字节」的附件进包；台账（manifest.attachments）记全量，
  // 字节表记实收——两边对不上的就是丢的，接收方按台账能发现缺哪几张
  const bytes: Record<string, Uint8Array> = {};
  for (const r of refs) {
    const b = input.attachmentBytes[r.id];
    if (b) bytes[r.id] = b;
  }
  return { manifest, events: rewritten, attachmentBytes: bytes };
}

/** 解包校验：确认这份数据是合法的会话包。返回错误信息数组（空 = 合法）。
    不抛异常——接收方 UI 要把「这份包有问题」渲染成提示，而不是炸掉。
    只校验结构合法性，不校验「内容是否可信」（那是 RLS/好友关系的职责）。 */
export function validatePackage(pkg: unknown): string[] {
  const errs: string[] = [];
  if (typeof pkg !== "object" || pkg === null) return ["不是有效的会话包（非对象）"];
  const p = pkg as Partial<SessionPackage>;
  const m = p.manifest;
  if (typeof m !== "object" || m === null) {
    errs.push("缺 manifest");
    return errs; // 没有 manifest 后面都没法查
  }
  if (m.kind !== "otto.session-package") errs.push(`kind 不对：${String(m.kind)}`);
  if (m.version !== 1) errs.push(`不支持的版本：${String(m.version)}（本版本只认 1）`);
  if (typeof m.exportedTs !== "number") errs.push("manifest 缺 exportedTs");
  if (typeof m.message !== "string") errs.push("manifest 缺 message");
  if (!Array.isArray(p.events)) errs.push("缺 events 数组");
  if (typeof p.attachmentBytes !== "object" || p.attachmentBytes === null) {
    errs.push("缺 attachmentBytes");
  }
  // 事件条数自洽：manifest.eventCount 必须等于实际 events 长度
  if (Array.isArray(p.events) && typeof m.eventCount === "number" && m.eventCount !== p.events.length) {
    errs.push(`事件条数不自洽：manifest 记 ${m.eventCount}，实际 ${p.events.length}`);
  }
  // 首条必须是 session_created——fork 的起点，没有它这份包建不出会话
  if (Array.isArray(p.events) && p.events.length > 0) {
    const first = p.events[0] as SessionEvent | undefined;
    if (first?.type !== "session_created") {
      errs.push(`首条事件必须是 session_created，实际是 ${String(first?.type)}`);
    }
  }
  return errs;
}

// ─── 导入端契约（PR#2 用，写在这里钉死免得下个 shift 漏）────────────────

/** 导入时给 session_created 重填 workspace。
    导出时剥掉了发送方的 workspace（rewriteWorkspace），但 deriveMessages 只在
    session_created 带 workspace 时才造围栏 system 消息（见 deriveMessages.ts
    「if (event.workspace && systemMessage === null)」）——剥白的包直接导入会得到
    一个**没有围栏**的会话：文件工具无处圈定，模型也没有工作目录认知。
    所以接收方导入时必须用**接收方自己选定的目录**重填，这一步不可省。
    只改写第一条 session_created（fork 起点），其余事件不动。 */
export function fillWorkspaceOnImport(events: readonly SessionEvent[], workspace: string): SessionEvent[] {
  return events.map((e, i) => {
    if (i === 0 && e.type === "session_created") {
      return { ...e, workspace } as SessionEvent;
    }
    return e;
  });
}

/** 导入时给事件流换上接收方的新 sessionId（附录用）。
    packSession 保留发送方的 sessionId 是为了溯源（manifest.source），
    但 append 进接收方库前必须换成新会话的 id。seq 由 EventStore 重分配，
    这里只换 sessionId 并剥掉旧 seq。 */
export function retargetForImport(
  events: readonly SessionEvent[],
  newSessionId: string
): Omit<SessionEvent, "seq">[] {
  return events.map((e) => {
    const { seq: _seq, sessionId: _sid, ...rest } = e;
    return { ...rest, sessionId: newSessionId } as Omit<SessionEvent, "seq">;
  });
}
