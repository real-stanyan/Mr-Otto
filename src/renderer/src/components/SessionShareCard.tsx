// SessionShareCard —— 好友 DM 里的「会话分享」信封卡片（issue #611，PR#3）。
// 发送方 @好友 分享会话后，接收方的 DM 里那条 body 不是人话，是一段 JSON 信封
// ({"otto":"session-share",...}，见 shared/sessionPackageCodec.ts)。本组件认出
// 信封就渲染成可点卡片：显示留言/事件数/时间，点「导入到当前工作区」fork 出
// 新会话继续执行；认不出(普通文本)返回 null，调用方照旧渲染气泡。

import { useState } from "react";
import { GitFork, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { decodeEnvelope } from "../../../shared/sessionPackageCodec.js";
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
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  if (!env) return null;

  const onImport = async () => {
    setBusy(true);
    setFailed(null);
    const ok = await importShared(env.prefix, workspace);
    setBusy(false);
    if (!ok) setFailed("导入失败（详见好友错误提示）");
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
      {!mine && (
        <div className="mt-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void onImport()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? "导入中…" : "导入到当前工作区"}
          </Button>
          {failed && <div className="mt-1 text-xs text-destructive">{failed}</div>}
        </div>
      )}
    </div>
  );
}
