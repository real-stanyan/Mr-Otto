// SessionShareCard —— 好友 DM 里的「会话分享」信封卡片（issue #611，PR#3）。
// 发送方 @好友 分享会话后，接收方的 DM 里那条 body 不是人话，是一段 JSON 信封
// ({"otto":"session-share",...}，见 shared/sessionPackageCodec.ts)。本组件认出
// 信封就渲染成可点卡片：显示留言/事件数/时间，点「导入到当前工作区」fork 出
// 新会话继续执行；认不出(普通文本)返回 null，调用方照旧渲染气泡。
//
// 信封里带了代理邀请码时（issue #694，ADR-0177），卡片上多一个「导入并接上 TA 的服务」：
// 这就是「B 不用再手动拿授权」的落地处——邀请码不再需要人肉复制粘贴到好友代理弹窗，
// 它随包躺在这张卡里，一次点击完成握手。两个按钮各自承诺的事严格分开：
// 接不上服务时**不顺手把对话导进去**再报错，那样人分不清哪一半成功了。

import { useState } from "react";
import { GitFork, KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { decodeEnvelope } from "../../../shared/sessionPackageCodec.js";
import { decodeProxyInvite, PROXY_SHARE_INVITE_TTL_MS } from "../../../shared/remote/proxyInvite.js";
import { useChat } from "../store.js";

/** body 是分享信封就渲染卡片，否则返回 null（调用方回落到普通气泡）。
    mine=true 是「我自己发出去的那条」——只读展示，不给导入按钮。
    fromName = 发送方显示名（信封里没有，由 FriendChatView 从好友上下文传入） */
export function SessionShareCard({
  body,
  mine,
  fromName,
}: {
  body: string;
  mine: boolean;
  fromName: string;
}) {
  const env = decodeEnvelope(body);
  const workspace = useChat((s) => s.workspace);
  const importShared = useChat((s) => s.importShared);
  const acceptProxyInvite = useChat((s) => s.acceptProxyInvite);
  const [busy, setBusy] = useState<null | "plain" | "grant">(null);
  const [failed, setFailed] = useState<string | null>(null);

  if (!env) return null;

  const onImport = async (withGrant: boolean) => {
    setBusy(withGrant ? "grant" : "plain");
    setFailed(null);
    // 整段兜住 + finally 复位：这两个 await 走的是 IPC 桥，handler 抛异常时
    // invoke 会 reject——不兜的话 setBusy(null) 永远轮不到，按钮停在
    // 「接入中…」转一辈子圈（#783 的表现形态）。错误照样落一句人话
    try {
      // 先握手再导入：反过来的话，服务接不上时对话已经躺进工作区了，
      // 而这张卡上那句报错说的是另一件事——人得靠猜才知道哪一半成了
      if (withGrant && env.invite) {
        const paired = await acceptProxyInvite(env.invite, PROXY_SHARE_INVITE_TTL_MS);
        if (!paired) {
          // 最常见的两种：对方退出过 app（一次性密钥只在内存里，ADR-0170）、
          // 或者超过 24 小时。两种的解法是同一句话，所以不细分
          setFailed("接不上对方的服务（详见好友错误提示）——可以先「只导入对话」，或让 TA 重新分享一次");
          return;
        }
      }
      // 接上了服务才带 grant（issue #788）：主进程据此在 fork 里焊一条
      // 「历史工具名 ↔ 本机借来的前缀名」的注记，模型才不会在本地重配一台。
      // hostUid 从邀请码里取——信封没有单独的 uid 字段，而注记的前缀由 uid 派生
      const hostUid = withGrant && env.invite ? decodeProxyInvite(env.invite)?.hostUid : undefined;
      const grant =
        hostUid && env.grantServers && env.grantServers.length > 0
          ? { friendUid: hostUid, friendName: fromName, servers: env.grantServers }
          : undefined;
      const ok = await importShared(env.prefix, workspace, grant);
      if (!ok) setFailed("导入失败（详见好友错误提示）");
    } catch (e) {
      setFailed(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <GitFork className="size-4 shrink-0 text-muted-foreground" />
        <span>{mine ? "你分享了一个会话" : `${fromName} 分享了一个会话`}</span>
      </div>
      {env.title && <div className="mt-1 text-muted-foreground">《{env.title}》</div>}
      {env.message && (
        <div className="mt-1 whitespace-pre-wrap text-foreground/90">“{env.message}”</div>
      )}
      <div className="mt-1 text-xs text-muted-foreground">{env.eventCount} 条事件 · 可 fork 继续执行</div>
      {env.grantServers && env.grantServers.length > 0 && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <KeyRound className="size-3.5 shrink-0 mt-[2px]" />
          <span>
            {mine ? "连带借出了：" : `${fromName} 连带把这些服务借给你用：`}
            <b className="text-foreground/80">{env.grantServers.join("、")}</b>
            {!mine && "（TA 不在线也能用——凭证托管在 Mr Otto 云端）"}
          </span>
        </div>
      )}
      {!mine && (
        <div className="mt-2 flex flex-wrap gap-2">
          {env.invite && (
            <Button size="sm" disabled={busy !== null} onClick={() => void onImport(true)}>
              {busy === "grant" && <Loader2 className="size-3.5 animate-spin" />}
              {busy === "grant" ? "接入中…" : "导入并接上 TA 的服务"}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void onImport(false)}>
            {busy === "plain" && <Loader2 className="size-3.5 animate-spin" />}
            {busy === "plain" ? "导入中…" : env.invite ? "只导入对话" : "导入到当前工作区"}
          </Button>
        </div>
      )}
      {!mine && failed && <div className="mt-1 text-xs text-destructive">{failed}</div>}
    </div>
  );
}
