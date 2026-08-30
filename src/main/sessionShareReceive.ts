// sessionShareReceive —— 会话分享的接收端导入编排（issue #611，PR#2）。
// 「收信封 → 下载 → 解包 → 重填 workspace → 逐条 append 进新会话」串成 fork。
// 依赖全部注入（下载、写附件、建会话），本层不碰具体实现，可脱离真库测试。

import {
  fillWorkspaceOnImport,
  retargetForImport,
} from "../shared/sessionPackage.js";
import { decodePackage } from "../shared/sessionPackageCodec.js";
import type { FriendsResult } from "../shared/friends.js";

/** 接收端要的外部能力（index.ts 用真 Storage/AttachmentStore/EventStore 填） */
export interface ShareReceiveDeps {
  /** 按前缀整组下载包文件（sessionShareApi.downloadPackageFiles，null=包没了） */
  download: (prefix: string) => Promise<Map<string, Uint8Array> | null>;
  /** 把附件字节写进本机附件库（AttachmentStore.save，拿回新 ref 的 id——
      内容寻址下同内容同 id，所以其实就是原 id，但走 save 保证落盘） */
  saveAttachment: (bytes: Uint8Array, name?: string) => { id: string };
  /** 逐条 append 进新会话（EventStore.append，剥 seq 由它重分配） */
  append: (sessionId: string, event: Record<string, unknown>) => void;
  /** 生成新会话 id（导入出的 fork 会话） */
  newSessionId: () => string;
}

/** 与 shellBridge.importSharedSession 声明的 FriendsResult 同形（成功臂包在 value 里）。
    这里曾是平铺的 { ok, sessionId, … }：ipcMain.handle 这道缝没有类型，渲染层照桥上
    声明读 r.value.sessionId，读到 undefined 抛 TypeError，两个导入按钮永远转圈（#783）。
    形状由 tests/main/sessionShare.test.ts 的「形状钉」用例钉死 */
export type ShareReceiveResult = FriendsResult<{
  sessionId: string; eventCount: number; missingAttachments: number;
}>;

/** 把一个会话包导入成接收方机器上的新 fork 会话。
    workspace 用接收方选定的目录重填（剥白的包没有围栏，这一步不可省，
    见 sessionPackage.fillWorkspaceOnImport 的契约注释）。
    @param workspace 接收方选定的本机工作目录（fork 会话的围栏） */
export async function importSharedSession(
  deps: ShareReceiveDeps,
  args: { prefix: string; workspace: string }
): Promise<ShareReceiveResult> {
  // 围栏不能是空的：fillWorkspaceOnImport 会把它原样填进 session_created，
  // 而 resumeSession 见到没有 workspace 的第 0 条直接拒绝恢复——空串走到底
  // 就是一个点不开的死会话（#783 下半）。先拒，别铸
  if (!args.workspace) {
    return { ok: false, message: "没有可用的工作目录——先选一个默认工作文件夹再导入" };
  }
  // 下载
  let files: Map<string, Uint8Array> | null;
  try {
    files = await deps.download(args.prefix);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  if (!files) return { ok: false, message: "分享不存在或已被对方撤回" };

  // 解包（过结构门）
  const decoded = decodePackage(files);
  if (!decoded.ok) return { ok: false, message: `会话包无效：${decoded.errors.join("；")}` };
  const { pkg } = decoded;

  // 附件落盘：把包里的字节写进接收方附件库。数一下缺几张（台账有、字节没有）
  let saved = 0;
  for (const ref of pkg.manifest.attachments) {
    const bytes = pkg.attachmentBytes[ref.id];
    if (!bytes) continue; // 缺图：跳过，最后报数
    deps.saveAttachment(bytes, ref.name);
    saved++;
  }
  const missing = pkg.manifest.attachments.length - saved;

  // 导入：重填接收方 workspace → 换新 sessionId（剥旧 seq）→ 逐条 append
  const newSessionId = deps.newSessionId();
  const filled = fillWorkspaceOnImport(pkg.events, args.workspace);
  const retargeted = retargetForImport(filled, newSessionId);
  try {
    for (const e of retargeted) deps.append(newSessionId, e as Record<string, unknown>);
  } catch (e) {
    return { ok: false, message: `导入失败：${e instanceof Error ? e.message : String(e)}` };
  }

  return {
    ok: true,
    value: { sessionId: newSessionId, eventCount: pkg.events.length, missingAttachments: missing },
  };
}
