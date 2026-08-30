// workspaceSessionShare —— 发布制会话的编排（Task 9，ADR-0198 切片 3）。
//
// 是 sessionShare.ts（shareSessionToFriend）的姊妹：同一套 pack + upload 流水线
// （见 ADR-0198 ④「会话发布复用 session-packages 包机制，不新造存储/隐私闸」），
// 唯一的分岔在信封那一步——1:1 分享是 DM 里塞一段信封 JSON，发布制会话没有
// 「收信人」这个概念，换成往 workspace_sessions 插一行（Task 7 的
// insertSessionRow）。撤回同理：DM 场景没有"撤回"这个动作，发布制会话有
// （unpublishSession = 删行 + deletePackage）。导入端完全复用
// sessionShareReceive.importSharedSession——它已经不关心包路径的来源，
// 这里只是把 prefix 从「DM 信封里的字段」换成「行里的 publisher_uid/pkg_id」。
//
// 连带借用（spec §4.2，"发布时顺手把用到的连接器也借出去"）不在这层——
// UI 在发布确认框里对勾选的服务逐个调 Task 8 的 workspaceManager.contributeConnector，
// 不给这层加第二条授权路（同 ADR-0177 对 1:1 分享的取舍）。
//
// 隐私闸在 packSession 里（src/shared/sessionPackage.ts），已经在那份文件的
// 单测 + sessionShare.test.ts 里钉过闸的行为——这里不重测，deps.packSession
// 可整体假掉，测试只断言「流程真的调用了它」。

import type { SupabaseClient } from "@supabase/supabase-js";
import { packSession as realPackSession, type SessionPackage } from "../shared/sessionPackage.js";
import { packageKeys } from "../shared/sessionPackageCodec.js";
import type { FriendsResult } from "../shared/friends.js";
import type { ShareSendDeps } from "./sessionShare.js";
import {
  importSharedSession,
  type ShareReceiveDeps,
  type ShareReceiveResult,
} from "./sessionShareReceive.js";
import * as WorkspacesApi from "./supabaseWorkspacesApi.js";
import { deletePackage } from "./sessionShareApi.js";

/** 发布端要的外部能力：整份复用 sessionShare.ts 的 ShareSendDeps（load 事件/读附件/
    上传都是同一套动作），只加发布制场景才有的两样。ShareSendDeps.sendDm 在这层
    用不上——发布不发 DM——但按брief的取舍，字段形状仍然复用不另造类型，
    index.ts 装配时随手传一个不会被调用的占位（真调用了会直接抛，见下方实现，
    充当"这条分支不该走到这里"的断言） */
export interface WorkspaceShareSendDeps extends ShareSendDeps {
  /** 拿当前登录用户的 SupabaseClient（insertSessionRow 要用；myUid()==null 时
      不会走到这里，但两者独立注入——同 workspaceManager.ts 的 client()/selfUid() 分离） */
  client: () => SupabaseClient | null;
  /** Task 7 的行插入：workspace_sessions 一行 = 一次发布 */
  insertSessionRow: typeof WorkspacesApi.insertSessionRow;
  /** 隐私闸所在（真实现见 shared/sessionPackage.ts）。可选——不传时落回真实现；
      测试整个假掉，只断言"调用到了"，不重测闸本身（闸的单测在别处） */
  packSession?: typeof realPackSession;
}

/** 把 sessionId 这个会话发布进 workspaceId 工作区，标题 title（展示用，不脱敏—— 由
    发布者自己填，不含会话内容）。
    全过程：load → 收集附件字节 → 打包（隐私闸在这道，同 shareSessionToFriend）→
    上传（路径前缀 {自己 uid}/{pkgId}，同 0014 RLS 的"第一段目录 = 上传者 uid"）→
    插 workspace_sessions 行。任何一步失败都归一成 FriendsResult，不抛。 */
export async function publishSessionToWorkspace(
  deps: WorkspaceShareSendDeps,
  workspaceId: string,
  sessionId: string,
  title: string,
): Promise<FriendsResult<{ rowId: string; pkgId: string }>> {
  try {
    const uid = await deps.myUid();
    if (!uid) return { ok: false, message: "未登录" };
    const client = deps.client();
    if (!client) return { ok: false, message: "未登录" };

    const events = deps.loadEvents(sessionId);
    if (events.length === 0) return { ok: false, message: "会话为空或不存在" };

    const pack = deps.packSession ?? realPackSession;

    // 收集附件字节：先打包拿到 refs 台账，再按 id 读字节（同 shareSessionToFriend
    // 的两趟打包取舍——读不到的附件跳过，不阻塞整份包）
    const provisional = pack({
      events,
      message: "", // 发布制会话没有"留言"这个概念（那是 DM 场景才有的字段）
      title,
      model: null,
      exportedTs: (deps.now ?? Date.now)(),
      attachmentBytes: {},
    });
    const attachmentBytes: Record<string, Uint8Array> = {};
    for (const ref of provisional.manifest.attachments) {
      try {
        attachmentBytes[ref.id] = deps.readAttachment(ref.id);
      } catch {
        // 单张图读不到不阻塞整包，同 shareSessionToFriend
      }
    }
    const pkg: SessionPackage = pack({
      events,
      message: "",
      title,
      model: null,
      exportedTs: (deps.now ?? Date.now)(),
      attachmentBytes,
    });

    // 上传：对象键前缀 = {我的uid}/{pkgId}——与 shareSessionToFriend 同一条 0014 RLS
    const pkgId = (deps.newPkgId ?? defaultPkgId)();
    const prefix = `${uid}/${pkgId}`;
    await deps.upload(packageKeys(prefix, pkg));

    // 插行（本体在 Storage，行只带 pkg_id + 展示字段——ADR-0198 ④）
    let row: { id: string };
    try {
      row = await deps.insertSessionRow(client, { workspaceId, publisherUid: uid, pkgId, title });
    } catch (e) {
      // 补偿：包已经传上去了，行没插成——留着就是一个 unpublishSession 够不到的
      // 孤儿包（它要一个从未存在过的 rowId 才能删）。尽力删掉，删失败就算了
      // （原错误优先，同 supabaseWorkspacesApi.createWorkspace 的补偿取舍）
      await deletePackage(client, prefix).then(
        () => undefined,
        () => undefined,
      );
      throw e;
    }

    return { ok: true, value: { rowId: row.id, pkgId } };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** 撤回一次发布：删 workspace_sessions 那一行 + 删 Storage 里的包文件。
    先删行后删包（同 workspaceManager 的"权威判定优先"取舍：行是权威——行没了，
    列表页就再也看不到这次发布；包本体是这一行的后续清理）。
    两步**不共用一个 try**：行删失败要真的报 { ok:false }（撤回没生效，列表页
    还看得到这次发布，用户需要知道）；行删成功之后，包清理是纯粹的收尾——
    包删失败最多留几个孤儿文件，不该让一次已经对用户可见生效的撤回显示失败
    （那会让人误以为会话还挂在工作区里，其实已经看不到了）。
    pkgPrefix = {publisher_uid}/{pkg_id}，与 publishSessionToWorkspace 里的
    prefix 同一个值——调用方（index.ts）从行数据里取，不是这里现拼 */
export async function unpublishSession(
  client: SupabaseClient,
  rowId: string,
  pkgPrefix: string,
): Promise<FriendsResult<null>> {
  try {
    await WorkspacesApi.deleteSessionRow(client, rowId);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  try {
    await deletePackage(client, pkgPrefix);
  } catch {
    // 吞掉：行已经删了，撤回对用户来说已经生效——包清理失败只是留几个孤儿
    // 文件，不该把一次成功的撤回报成失败（对称于上面补偿删除的取舍）
  }
  return { ok: true, value: null };
}

/** 把发布在 workspaceId 里的一份会话导入成本机的新 fork 会话。
    完全复用 sessionShareReceive.importSharedSession 的既有路径——下载、解包、
    附件落盘、逐条 append 全部原样；唯一的分岔是包路径的来源：DM 场景从信封
    字段读，这里从行数据拼（{publisherUid}/{pkgId}，与发布时的上传前缀同一个值）。
    连带借用（contributeConnector）不在这层，故不传 grantNote——同文件头注释。
    @param workspace 接收方选定的本机工作目录（fork 会话的围栏）。brief 给的产出
    签名没列这个参数，但 importSharedSession 硬性要求非空 workspace（见该文件
    头部注释：空串会铸成一个点不开的死会话）——ShareReceiveDeps 里也没有这个字段，
    所以按现有调用惯例（sessionId/workspaceId/title 都是 publishSessionToWorkspace
    的显式参数，不塞进 deps）把它做成显式参数，而不是另造一个只多一个字段的
    deps 类型 */
export async function importWorkspaceSession(
  deps: ShareReceiveDeps,
  publisherUid: string,
  pkgId: string,
  workspace: string,
): Promise<ShareReceiveResult> {
  return importSharedSession(deps, { prefix: `${publisherUid}/${pkgId}`, workspace });
}

function defaultPkgId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
