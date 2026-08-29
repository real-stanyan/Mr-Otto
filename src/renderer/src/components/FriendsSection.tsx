// FriendsSection — 好友区(收在侧栏 footer 的抽屉里):加好友(邮箱精确搜索)/
// 待处理请求 / 好友列表(在线点 + 未读)。
// 全部状态走 store,不直接摸 window.otter(硬规则)。未登录显示占位。

import { useEffect, useState } from "react";
import { KeyRound, Search } from "lucide-react";
import { useChat } from "../store.js";
import { ProxyDialog } from "./ProxyDialog.js";
import type { FriendProfile } from "../../../shared/friends.js";
import {
  SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarMenuAction,
} from "@/components/ui/sidebar.js";
import { Button } from "@/components/ui/button.js";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";

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
  const searchFriend = useChat((s) => s.searchFriend);
  const addFriend = useChat((s) => s.addFriend);
  const respondFriend = useChat((s) => s.respondFriend);
  const removeFriend = useChat((s) => s.removeFriend);
  const openFriendChat = useChat((s) => s.openFriendChat);
  const friendChat = useChat((s) => s.friendChat);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FriendProfile[] | null>(null); // null = 没搜过,[] = 搜过没命中
  // 好友代理弹窗(issue #657)。friend 有值 = 从某位好友那把钥匙进来的(直接开"分享"页),
  // null = 从底下那行进来的(管理已授权 / 粘别人的邀请码)
  const [proxyFor, setProxyFor] = useState<{ id: string; label: string } | null>(null);
  const [proxyOpen, setProxyOpen] = useState(false);

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
      {/* 命中行：头像 + 名字 + 邮箱。头像不带在线点——搜到的人还不是好友，
          presence 只对好友广播（ADR-0055），画个灰点等于把"我不知道"说成"他离线"。
          邮箱那一行不是装饰：同名的人搜出来就是两行一模一样的字（真实截图里
          两个「Stan Yan」），只有邮箱能分辨该给谁发请求；手机端一直是这么画的 */}
      {hits?.map((hit) => (
        <div key={hit.id} className="mx-[10px] mb-1 px-2 py-1 border border-border rounded text-xs flex items-center gap-[6px]">
          <Avatar size="sm" className="shrink-0">
            <AvatarImage src={hit.avatarUrl} alt={hit.name || hit.email} />
            <AvatarFallback>{(hit.name || hit.email || "?").slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="flex flex-1 min-w-0 flex-col leading-tight">
            <span className="truncate">{hit.name || hit.email}</span>
            {hit.name && hit.email && (
              <span className="truncate text-[10.5px] text-muted-foreground">{hit.email}</span>
            )}
          </span>
          <Button variant="ghost" size="sm" className="shrink-0 px-2 text-xs"
            onClick={() => { void addFriend(hit.id); setHits(null); setQuery(""); }}>
            发请求
          </Button>
        </div>
      ))}
      {friendError && <p className="px-[10px] text-xs text-err">{friendError}</p>}

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

      {/* 好友列表:在线点 + 未读角标,点开 DM 面板;悬停出"删好友"。
          发出未回应的好友请求灰显在最后 */}
      <SidebarMenu>
        {snapshot.friends.map((e) => (
          <SidebarMenuItem key={e.friendshipId}>
            <SidebarMenuButton
              className="h-auto py-[5px] pr-[54px]"
              isActive={friendChat?.id === e.profile.id}
              onClick={() => void openFriendChat(e.profile)}
            >
              <FriendAvatar profile={e.profile} online={online.has(e.profile.id)} />
              <span className="flex-1 min-w-0 truncate text-xs">{e.profile.name || e.profile.email}</span>
              {(unread[e.profile.id] ?? 0) > 0 && (
                <span className="text-[10px] font-semibold text-brand">{unread[e.profile.id]}</span>
              )}
            </SidebarMenuButton>
            <SidebarMenuAction
              showOnHover
              className="right-7"
              title="把我接通的服务分享给他用"
              onClick={(ev) => {
                ev.stopPropagation();
                setProxyFor({ id: e.profile.id, label: e.profile.name || e.profile.email });
                setProxyOpen(true);
              }}
            >
              <KeyRound className="size-[13px]" />
            </SidebarMenuAction>
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

      {/* 好友代理的另外两件事：看/撤销自己授出去的，和粘别人发来的邀请码。
          不挂在某位好友身上，所以单独一行 */}
      <div className="px-[10px] pt-1">
        <button
          type="button"
          className="flex items-center gap-[6px] w-full px-[6px] py-[5px] rounded-md bg-transparent text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] transition-colors duration-150"
          onClick={() => { setProxyFor(null); setProxyOpen(true); }}
        >
          <KeyRound className="w-[13px] h-[13px]" />
          好友代理…
        </button>
      </div>

      <ProxyDialog
        open={proxyOpen}
        onOpenChange={(o) => { setProxyOpen(o); if (!o) setProxyFor(null); }}
        friend={proxyFor}
      />
    </>
  );
}
