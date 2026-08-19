// InviteTableMenu — "约这个好友上哪张桌"的下拉。
// 为什么要选桌而不是一键邀请:桌是有档位和盲注的(ADR-0022),约人打牌等于约一个赌注大小,
// 这件事必须由发起人明说。列表就是网关认可的可见桌(自己建的 / 坐着的 / 好友建的)。
//
// 一张桌都没有时不留死路:直接给一条"去建一张桌",切到 game 档。

import { useChat } from "../store.js";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import type { ReactNode } from "react";

/** 数字带千分位:盲注/买入都是 token 面额,四位以上不分节读不出量级 */
const fmt = (n: number): string => n.toLocaleString("en-US");

export function InviteTableMenu({
  friendId, label, children,
}: {
  friendId: string;
  label: string;
  children: ReactNode;
}) {
  const tables = useChat((s) => s.pokerTables);
  const invites = useChat((s) => s.gameInvites);
  const refresh = useChat((s) => s.refreshPokerTables);
  const invite = useChat((s) => s.inviteToTable);
  const setSessionMode = useChat((s) => s.setSessionMode);
  const setFriendsPanelOpen = useChat((s) => s.setFriendsPanelOpen);

  // 已经发出去、还没回应的邀请:同一张桌不重复邀(DB 那边也有唯一索引挡着)
  const pending = new Set(
    invites
      .filter((i) => i.direction === "outgoing" && i.status === "pending" && i.peer.id === friendId)
      .map((i) => i.tableId)
  );

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) void refresh(); }}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[240px]">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {tables.length === 0 ? (
          <DropdownMenuItem
            onSelect={() => {
              setSessionMode("game");
              setFriendsPanelOpen(false);
            }}
          >
            还没有桌 · 去建一张
          </DropdownMenuItem>
        ) : (
          tables.map((t) => (
            <DropdownMenuItem
              key={t.id}
              disabled={pending.has(t.id)}
              onSelect={() => void invite(friendId, t.id, t.name || "无名桌")}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">{t.name || "无名桌"}</div>
                <div className="text-[11px] tabular-nums text-muted-foreground">
                  {t.tier} · 盲注 {fmt(t.smallBlind)}/{fmt(t.bigBlind)}
                </div>
              </div>
              {pending.has(t.id) && <span className="text-[11px] text-muted-foreground">已邀请</span>}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
