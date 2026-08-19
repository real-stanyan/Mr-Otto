// GameInviteToast — 收到的牌局邀请浮层(右上角)。
// 为什么是浮层而不是抽屉里的一行:邀请有时效(10 分钟),而好友抽屉默认是收着的——
// 收在抽屉里等于没通知到。窗口没聚焦时另有系统通知(主进程 friendNotifier),
// 这里负责"人就在屏幕前"的那一半。
//
// 接受 = 切到 game 档 + 进那张桌,**不代付买入**:买入花的是真 token(ADR-0021/0027)。
// 卡片上明说这件事,免得用户以为点了就扣钱。

import { useEffect, useState } from "react";
import { useChat } from "../store.js";
import { Button } from "@/components/ui/button.js";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import type { GameInvite } from "../../../shared/friends.js";

/** 每 15 秒重新取一次"现在":邀请到点了要自己消失,不能等下一次别的状态变化 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** 还剩多久:分钟级就够了(秒级读数会把注意力钉在倒计时上,而不是"要不要去") */
function remainLabel(invite: GameInvite, now: number): string {
  const left = Date.parse(invite.expiresAt) - now;
  if (!Number.isFinite(left)) return "";
  const minutes = Math.ceil(left / 60_000);
  return minutes > 0 ? `还剩 ${minutes} 分钟` : "";
}

export function GameInviteToast() {
  const invites = useChat((s) => s.gameInvites);
  const respond = useChat((s) => s.respondGameInvite);
  const now = useNow(15_000);

  const live = invites.filter(
    (i) => i.direction === "incoming" && i.status === "pending" && Date.parse(i.expiresAt) > now
  );
  if (live.length === 0) return null;

  return (
    // pointer-events-none 在容器上、auto 在卡片上:浮层不该在整块空白上截住点击
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(320px,80vw)] flex-col gap-2">
      {live.map((invite) => {
        const name = invite.peer.name || invite.peer.email;
        const remain = remainLabel(invite, now);
        return (
          <div
            key={invite.id}
            className="invite-toast pointer-events-auto rounded-2xl border border-border/60 bg-card/80 p-3 shadow-lg backdrop-blur-xl"
          >
            <div className="flex items-start gap-2.5">
              <Avatar size="sm">
                <AvatarImage src={invite.peer.avatarUrl} alt={name} />
                <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-[650]">{name} 约你打牌</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {invite.tableName || "无名桌"}
                  {remain && ` · ${remain}`}
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-end gap-1">
              <span className="mr-auto text-[10px] text-muted-foreground">买入在桌上再确认</span>
              <Button variant="ghost" size="xs" onClick={() => void respond(invite.id, false)}>
                忽略
              </Button>
              <Button size="xs" onClick={() => void respond(invite.id, true)}>
                去牌桌
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
