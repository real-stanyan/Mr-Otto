// FriendsSection — 好友区(收在侧栏 footer 的抽屉里):加好友(邮箱精确搜索)/
// 待处理请求 / 好友列表(在线点 + 未读 + 约打牌) / 牌局邀请。
// 全部状态走 store,不直接摸 window.otter(硬规则)。未登录显示占位。

import { useEffect, useState } from "react";
import { Search, Spade } from "lucide-react";
import { useChat } from "../store.js";
import type { FriendProfile } from "../../../shared/friends.js";
import {
  SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarMenuAction,
} from "@/components/ui/sidebar.js";
import { Button } from "@/components/ui/button.js";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { InviteTableMenu } from "./InviteTableMenu.js";
import { POKER_ENABLED } from "../../../shared/features.js";

const SECTION_LABEL = "text-[11px] text-muted-foreground tracking-[0.04em] pt-[10px] px-[10px] pb-[2px]";

/** 头像 + 在线点。在线点长在头像右下角(状态属于这个人,不属于旁边那行字) */
function FriendAvatar({ profile, online }: { profile: FriendProfile; online: boolean }) {
  const name = profile.name || profile.email || "?";
  return (
    <span className="relative shrink-0">
      <Avatar size="sm">
        <AvatarImage src={profile.avatarUrl} alt={name} />
        <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span
        className={`absolute -bottom-px -right-px size-[7px] rounded-full ring-2 ring-sidebar ${
          online ? "bg-brand" : "bg-border"
        }`}
        aria-label={online ? "在线" : "离线"}
      />
    </span>
  );
}

export function FriendsSection({ embedded = false }: { embedded?: boolean }) {
  const account = useChat((s) => s.account);
  const snapshot = useChat((s) => s.friendsSnapshot);
  const onlineIds = useChat((s) => s.onlineIds);
  const unread = useChat((s) => s.unreadByFriend);
  const friendError = useChat((s) => s.friendError);
  const health = useChat((s) => s.realtimeHealth);
  const invites = useChat((s) => s.gameInvites);
  const searchFriend = useChat((s) => s.searchFriend);
  const addFriend = useChat((s) => s.addFriend);
  const respondFriend = useChat((s) => s.respondFriend);
  const removeFriend = useChat((s) => s.removeFriend);
  const openFriendChat = useChat((s) => s.openFriendChat);
  const friendChat = useChat((s) => s.friendChat);
  const respondGameInvite = useChat((s) => s.respondGameInvite);
  const cancelGameInvite = useChat((s) => s.cancelGameInvite);

  const refreshInvites = useChat((s) => s.refreshInvites);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FriendProfile[] | null>(null); // null = 没搜过,[] = 搜过没命中

  // 推送不回放:主进程在登录那一刻推过一次邀请列表,而这块 UI 可能是后来才挂上的。
  // 挂上时补拉一次,别让人对着空列表以为没人约过
  const signedIn = account.signedIn;
  useEffect(() => {
    if (signedIn) void refreshInvites();
  }, [signedIn, refreshInvites]);

  // 边输边搜(防抖 300ms)。单字符太散(ilike %x% 半个库都命中),从 2 个字符起搜;
  // stale 位挡住乱序返回——慢的旧响应不许覆盖新查询的结果
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      void searchFriend(q).then((found) => {
        if (!stale) setHits(found);
      });
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, searchFriend]);

  if (!account.signedIn) {
    // embedded(抽屉里)= 标题由弹窗自己出,这里只留状态文案
    return <div className={SECTION_LABEL}>{embedded ? "登录后可用" : "好友 · 登录后可用"}</div>;
  }

  const online = new Set(onlineIds);
  const incomingInvites = invites.filter((i) => i.direction === "incoming" && i.status === "pending");
  const outgoingInvites = invites.filter((i) => i.direction === "outgoing" && i.status === "pending");
  // Enter/放大镜 = 立即搜,不等防抖,也不受 2 字符下限(贴整串邮箱直接回车的老习惯)
  const doSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setHits(await searchFriend(q));
  };

  return (
    <>
      {!embedded && <div className={SECTION_LABEL}>好友</div>}
      {/* 推送链路的实话:degraded 时消息/请求靠轮询,慢几秒。
          不说的话,用户只会觉得"这软件有时候不灵"(issue #77 就是这种体感) */}
      {health === "degraded" && (
        <div className="mx-[10px] mb-1 rounded-md bg-foreground/[0.05] px-2 py-1 text-[11px] text-muted-foreground">
          实时推送不通,已切轮询兜底 · 消息会慢几秒
        </div>
      )}
      {/* 添加好友:用户名/邮箱模糊搜索(边输边搜)→ 命中列表逐个一键发请求。
          搜索键 = 输入框内的放大镜 icon(不占一行、不吃文字),Enter 同效 */}
      <div className="px-[10px] pb-1">
        <div className="relative flex items-center">
          <input
            className="w-full min-w-0 bg-transparent border border-border rounded-md pl-[9px] pr-[30px] py-[6px] text-xs placeholder:text-muted-foreground/70 focus:outline-none focus:border-ring transition-colors duration-150"
            placeholder="搜用户名或邮箱加好友"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
      {hits?.length === 0 && <p className="px-[10px] text-xs text-muted-foreground">没有匹配的用户。</p>}
      {hits?.map((hit) => (
        <div key={hit.id} className="mx-[10px] mb-1 px-2 py-1 border border-border rounded text-xs flex items-center gap-1">
          <span className="flex-1 min-w-0 truncate">{hit.name || hit.email}</span>
          <Button variant="ghost" size="sm" className="px-2 text-xs"
            onClick={() => { void addFriend(hit.id); setHits(null); setQuery(""); }}>
            发请求
          </Button>
        </div>
      ))}
      {friendError && <p className="px-[10px] text-xs text-err">{friendError}</p>}

      {/* 收到的牌局邀请:浮层可能已经被别的窗口挡住/用户切走过,抽屉里留一份账。
          德州隐藏(ADR-0085)时整段不画——邀请无处赴约 */}
      {POKER_ENABLED && incomingInvites.length > 0 && (
        <>
          <div className={SECTION_LABEL}>牌局邀请 · {incomingInvites.length}</div>
          {incomingInvites.map((i) => (
            <div key={i.id} className="mx-[10px] mb-1 flex items-center gap-1 rounded-md border border-border px-2 py-1">
              <span className="min-w-0 flex-1 truncate text-xs">
                {i.peer.name || i.peer.email} · {i.tableName || "无名桌"}
              </span>
              <Button variant="ghost" size="xs" className="text-muted-foreground"
                onClick={() => void respondGameInvite(i.id, false)}>
                忽略
              </Button>
              <Button variant="ghost" size="xs" className="text-brand"
                onClick={() => void respondGameInvite(i.id, true)}>
                去牌桌
              </Button>
            </div>
          ))}
        </>
      )}

      {/* 收到的请求:就地 接受/拒绝 */}
      {snapshot.incoming.length > 0 && (
        <>
          <div className={SECTION_LABEL}>好友请求 · {snapshot.incoming.length}</div>
          <SidebarMenu>
            {snapshot.incoming.map((e) => (
              <SidebarMenuItem key={e.friendshipId}>
                <SidebarMenuButton className="h-auto py-[5px] cursor-default hover:bg-transparent">
                  <FriendAvatar profile={e.profile} online={online.has(e.profile.id)} />
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

      {/* 好友列表:在线点 + 未读角标,点开 DM 面板;悬停出"约打牌"和"删好友"两颗。
          发出未回应的好友请求灰显在最后 */}
      <SidebarMenu>
        {snapshot.friends.map((e) => (
          <SidebarMenuItem key={e.friendshipId}>
            <SidebarMenuButton
              className="h-auto py-[5px] pr-12"
              isActive={friendChat?.id === e.profile.id}
              onClick={() => void openFriendChat(e.profile)}
            >
              <FriendAvatar profile={e.profile} online={online.has(e.profile.id)} />
              <span className="flex-1 min-w-0 truncate text-xs">{e.profile.name || e.profile.email}</span>
              {(unread[e.profile.id] ?? 0) > 0 && (
                <span className="text-[10px] font-semibold text-brand">{unread[e.profile.id]}</span>
              )}
            </SidebarMenuButton>
            {/* 约打牌排在删除左边:右边缘那颗是破坏性操作,固定位置不该被挤动 */}
            {POKER_ENABLED && (
              <InviteTableMenu friendId={e.profile.id} label={`约 ${e.profile.name || e.profile.email} 打牌`}>
                <SidebarMenuAction
                  showOnHover
                  className="right-7"
                  title="约打牌"
                  onClick={(ev) => ev.stopPropagation()}
                >
                  <Spade />
                </SidebarMenuAction>
              </InviteTableMenu>
            )}
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

      {/* 自己发出去、还没被回应的邀请:看得见才撤得回 */}
      {outgoingInvites.length > 0 && (
        <>
          <div className={SECTION_LABEL}>已发出的邀请</div>
          {outgoingInvites.map((i) => (
            <div key={i.id} className="mx-[10px] mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">
                约 {i.peer.name || i.peer.email} 去 {i.tableName || "无名桌"}
              </span>
              <Button variant="ghost" size="xs" className="text-muted-foreground"
                onClick={() => void cancelGameInvite(i.id)}>
                撤回
              </Button>
            </div>
          ))}
        </>
      )}
    </>
  );
}
