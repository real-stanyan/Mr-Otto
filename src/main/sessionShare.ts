// sessionShare —— 会话分享的发送端编排（issue #611，PR#2）。
// 把「读当前会话事件 → 过隐私闸打包 → 上传 Storage → DM 发信封」串成一个动作。
// 依赖全部注入（load 事件、读附件字节、上传、发 DM），本层不碰具体实现——
// 这样它能脱离真 Supabase/SQLite 进 vitest 测编排逻辑，index.ts 只负责填依赖。

import { packSession, type SessionPackage } from "../shared/sessionPackage.js";
import { packageKeys, encodeEnvelope } from "../shared/sessionPackageCodec.js";
import type { SessionEvent } from "../session/events.js";

/** 发送端要的外部能力（index.ts 用真 EventStore/AttachmentStore/Storage/DM 填） */
export interface ShareSendDeps {
  /** 当前登录用户 uid（发送方，决定 Storage 路径第一段位 + DM sender） */
  myUid: () => Promise<string | null>;
  /** 读会话完整事件流（含 fork 链前缀已展平）—— historyCapability 同款 load */
  loadEvents: (sessionId: string) => SessionEvent[];
  /** 按附件 id 读字节（AttachmentStore.read） */
  readAttachment: (id: string) => Uint8Array;
  /** 上传一组「对象键 → 字节」（sessionShareApi.uploadPackageFiles） */
  upload: (files: ReadonlyMap<string, Uint8Array>) => Promise<void>;
  /** 发 DM 信封（friends.sendMessage，返回结构被忽略——失败由它抛错） */
  sendDm: (friendUid: string, body: string) => Promise<unknown>;
  /** 生成包 id（默认时间戳+随机，测试可注固定值） */
  newPkgId?: () => string;
  now?: () => number;
}

export type ShareSendResult =
  | { ok: true; pkgId: string; eventCount: number }
  | { ok: false; message: string };

/** 把 sessionId 这个会话分享给 friendUid，附一句留言。
    全过程：load → 收集附件字节 → 打包（隐私闸在这道）→ 上传 → 发信封。
    任何一步失败都归一成 { ok:false, message }，不抛——bridge 边界要结构化回流 */
export async function shareSessionToFriend(
  deps: ShareSendDeps,
  args: {
    sessionId: string; friendUid: string; message: string; title: string | null; model: string | null;
    /** 连带借出的服务名（展示用）+ 代理邀请码（issue #694，ADR-0177）。
        两个都缺席 = 老行为，只分享对话。本层不生成邀请、不写白名单——那是
        proxyManager 的活，这里只负责把它塞进信封 */
    grantServers?: readonly string[];
    invite?: string | null;
  }
): Promise<ShareSendResult> {
  try {
    const uid = await deps.myUid();
    if (!uid) return { ok: false, message: "未登录" };

    const events = deps.loadEvents(args.sessionId);
    if (events.length === 0) return { ok: false, message: "会话为空或不存在" };

    // 收集附件字节：先打包拿到 refs 台账，再按 id 读字节。
    // 读不到的附件跳过（同 ADR-0009：缺图退成提示，不炸整份包）
    const provisional = packSession({
      events, message: args.message, title: args.title, model: args.model,
      exportedTs: (deps.now ?? Date.now)(), attachmentBytes: {},
    });
    const attachmentBytes: Record<string, Uint8Array> = {};
    for (const ref of provisional.manifest.attachments) {
      try {
        attachmentBytes[ref.id] = deps.readAttachment(ref.id);
      } catch {
        // 单张图读不到不阻塞整包（字节表记实收，台账记全量，差异就是丢的）
      }
    }
    const pkg: SessionPackage = packSession({
      events, message: args.message, title: args.title, model: args.model,
      exportedTs: (deps.now ?? Date.now)(), attachmentBytes,
    });

    // 上传：对象键前缀 = {我的uid}/{pkgId}
    const pkgId = (deps.newPkgId ?? defaultPkgId)();
    const prefix = `${uid}/${pkgId}`;
    await deps.upload(packageKeys(prefix, pkg));

    // 发 DM 信封（本体在 Storage，DM 只带路径 + 展示文本）
    const body = encodeEnvelope({
      bucket: "session-packages",
      prefix,
      message: args.message,
      title: args.title,
      eventCount: pkg.manifest.eventCount,
      ...(args.grantServers && args.grantServers.length > 0 ? { grantServers: args.grantServers } : {}),
      ...(args.invite ? { invite: args.invite } : {}),
    });
    await deps.sendDm(args.friendUid, body);

    return { ok: true, pkgId, eventCount: pkg.manifest.eventCount };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function defaultPkgId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
