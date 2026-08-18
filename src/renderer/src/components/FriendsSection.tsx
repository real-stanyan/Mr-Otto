// FriendsSection — 侧边栏常驻好友区:添加好友(邮箱精确搜索)/待处理请求/好友列表+在线点。
// 全部状态走 store,不直接摸 window.otter(硬规则)。未登录显示占位。

import { useState } from "react";
import { Search } from "lucide-react";
import { useChat } from "../store.js";
import type { FriendProfile } from "../../../shared/friends.js";
import {
  SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarMenuAction,
} from "@/components/ui/sidebar.js";
import { Button } from "@/components/ui/button.js";

const SECTION_LABEL = "text-[11px] text-muted-foreground tracking-[0.04em] pt-[10px] px-[10px] pb-[2px]";

export function FriendsSection({ embedded = false }: { embedded?: boolean }) {
  const account = useChat((s) => s.account);
  const snapshot = useChat((s) => s.friendsSnapshot);
  const onlineIds = useChat((s) => s.onlineIds);
  const unread = useChat((s) => s.unreadByFriend);
  const friendError = useChat((s) => s.friendError);
  const searchFriend = useChat((s) => s.searchFriend);
  const addFriend = useChat((s) => s.addFriend);
  const respondFriend = useChat((s) => s.respondFriend);
  const removeFriend = useChat((s) => s.removeFriend);
  const openFriendChat = useChat((s) => s.openFriendChat);
  const friendChat = useChat((s) => s.friendChat);

  const [query, setQuery] = useState("");
  const [hit, setHit] = useState<FriendProfile | null | "none">(null); // "none" = 搜过没命中

  if (!account.signedIn) {
    // embedded(抽屉里)= 标题由弹窗自己出,这里只留状态文案
    return <div className={SECTION_LABEL}>{embedded ? "登录后可用" : "好友 · 登录后可用"}</div>;
  }

  const online = new Set(onlineIds);
  const doSearch = async () => {
    const email = query.trim();
    if (!email) return;
    const found = await searchFriend(email);
    setHit(found ?? "none");
  };

  return (
    <>
      {!embedded && <div className={SECTION_LABEL}>好友</div>}
      {/* 添加好友:邮箱精确搜索 → 命中卡片一键发请求。
          搜索键 = 输入框内的放大镜 icon(不占一行、不吃文字),Enter 同效 */}
      <div className="px-[10px] pb-1">
        <div className="relative flex items-center">
          <input
            className="w-full min-w-0 bg-transparent border border-border rounded-md pl-[9px] pr-[30px] py-[6px] text-xs placeholder:text-muted-foreground/70 focus:outline-none focus:border-ring transition-colors duration-150"
            placeholder="按邮箱加好友"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHit(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") void doSearch(); }}
          />
          <button
            type="button"
            className="absolute right-[6px] flex items-center justify-center p-[4px] rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] bg-transparent transition-colors duration-150"
            aria-label="搜索好友"
            title="搜索"
            onClick={() => void doSearch()}
          >
            <Search className="w-[14px] h-[14px]" />
          </button>
        </div>
      </div>
      {hit === "none" && <p className="px-[10px] text-xs text-muted-foreground">没有这个邮箱的用户。</p>}
      {hit !== null && hit !== "none" && (
        <div className="mx-[10px] mb-1 px-2 py-1 border border-border rounded text-xs flex items-center gap-1">
          <span className="flex-1 min-w-0 truncate">{hit.name || hit.email}</span>
          {hit.email === account.email ? null : (
            <Button variant="ghost" size="sm" className="px-2 text-xs"
              onClick={() => { void addFriend(hit.id); setHit(null); setQuery(""); }}>
              发请求
            </Button>
          )}
        </div>
      )}
      {friendError && <p className="px-[10px] text-xs text-err">{friendError}</p>}

      {/* 收到的请求:就地 接受/拒绝 */}
      {snapshot.incoming.length > 0 && (
        <>
          <div className={SECTION_LABEL}>好友请求 · {snapshot.incoming.length}</div>
          <SidebarMenu>
            {snapshot.incoming.map((e) => (
              <SidebarMenuItem key={e.friendshipId}>
                <SidebarMenuButton className="h-auto py-[5px] cursor-default hover:bg-transparent">
                  <span className="flex-1 min-w-0 truncate text-xs">{e.profile.name || e.profile.email}</span>
                  <span className="flex gap-1">
                    <Button variant="ghost" size="sm" className="px-[6px] text-xs text-brand"
                      onClick={(ev) => { ev.stopPropagation(); void respondFriend(e.friendshipId, true); }}>
                      接受
                    </Button>
                    <Button variant="ghost" size="sm" className="px-[6px] text-xs text-muted-foreground"
                      onClick={(ev) => { ev.stopPropagation(); void respondFriend(e.friendshipId, false); }}>
                      拒绝
                    </Button>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </>
      )}

      {/* 好友列表:在线点 + 未读角标,点开 DM 面板;发出未回应的请求灰显尾缀 */}
      <SidebarMenu>
        {snapshot.friends.map((e) => (
          <SidebarMenuItem key={e.friendshipId}>
            <SidebarMenuButton
              className="h-auto py-[5px]"
              isActive={friendChat?.id === e.profile.id}
              onClick={() => void openFriendChat(e.profile)}
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${online.has(e.profile.id) ? "bg-brand" : "bg-border"}`} />
              <span className="flex-1 min-w-0 truncate text-xs">{e.profile.name || e.profile.email}</span>
              {(unread[e.profile.id] ?? 0) > 0 && (
                <span className="text-[10px] font-semibold text-brand">{unread[e.profile.id]}</span>
              )}
            </SidebarMenuButton>
            <SidebarMenuAction
              showOnHover
              title="删除好友"
              onClick={(ev) => {
                ev.stopPropagation();
                if (confirm(`删除好友 ${e.profile.name || e.profile.email}?`)) {
                  void removeFriend(e.friendshipId);
                }
              }}
            >
              ✕
            </SidebarMenuAction>
          </SidebarMenuItem>
        ))}
        {snapshot.outgoing.map((e) => (
          <SidebarMenuItem key={e.friendshipId}>
            <SidebarMenuButton disabled className="h-auto py-[5px] opacity-55 cursor-default hover:bg-transparent">
              <span className="flex-1 min-w-0 truncate text-xs">{e.profile.name || e.profile.email}</span>
              <span className="text-[10px] text-muted-foreground">等对方接受</span>
            </SidebarMenuButton>
            <SidebarMenuAction showOnHover title="撤回请求"
              onClick={(ev) => { ev.stopPropagation(); void removeFriend(e.friendshipId); }}>
              ✕
            </SidebarMenuAction>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </>
  );
}
