// FriendChatView — 好友 DM 右侧叠加面板(同 Protocol/GitGraph 槽位):
// 消息列表(旧→新,顶部可翻更早) + 输入框。自己的消息靠右,对方靠左。
//
// 容器类名照抄 GitGraphView/ProtocolView 的既有写法:半屏/全屏/border-l 由
// App.tsx 里包这块 panel 的 side-panel 外层 div 统一处理(见 App.tsx `main` 变量),
// 这里的顶层容器只是 flex-1 min-w-0 flex flex-col——不是 aside,不重复套宽度/边框类,
// 否则会和外层 side-panel 的 w-1/2·border-l 叠两层。

import { useEffect, useRef, useState } from "react";
import { useChat } from "../store.js";
import { Button } from "@/components/ui/button.js";
import { X, Maximize2, Minimize2 } from "lucide-react";
import { SidebarNub } from "./SidebarNub.js";
import type { DirectMessage } from "../../../shared/friends.js";

// 好友未选中/dmByFriend 里没这个人时的兜底——模块级常量而非每次渲染 `?? []`,
// 保证 selector 每次返回同一引用,不触发 zustand 无谓重渲(仓库 selector 约定)
const EMPTY: DirectMessage[] = [];

export function FriendChatView() {
  const friend = useChat((s) => s.friendChat);
  const messages = useChat((s) => (friend ? s.dmByFriend[friend.id] : undefined)) ?? EMPTY;
  const onlineIds = useChat((s) => s.onlineIds);
  const friendError = useChat((s) => s.friendError);
  const sendDm = useChat((s) => s.sendDm);
  const loadOlderDms = useChat((s) => s.loadOlderDms);
  const closeFriendChat = useChat((s) => s.closeFriendChat);
  const panelWide = useChat((s) => s.panelWide);
  const togglePanelWide = useChat((s) => s.togglePanelWide);
  const account = useChat((s) => s.account);

  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  // 翻旧页不弹底,只在最新一条变化时贴底:messages.length 在 loadOlderDms 时也会变
  // (prepend),用 lastId 而非 length 才能把"顶部插入旧消息"和"末尾追加新消息"分开
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [lastId, friend?.id]);

  if (!friend) return null;
  const online = onlineIds.includes(friend.id);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void sendDm(text);
  };

  return (
    <main className="flex-1 min-w-0 flex flex-col">
      <header className="flex items-center gap-2 px-4 py-2 border-b border-border">
        {/* 全屏时本面板独占内容区,侧栏的重开钮没有别的落点——排进这排最左 */}
        {panelWide && <SidebarNub />}
        <span className={`w-2 h-2 rounded-full ${online ? "bg-brand" : "bg-border"}`} />
        <span className="font-[650] text-sm flex-1 min-w-0 truncate">{friend.name || friend.email}</span>
        <Button variant="ghost" size="sm" onClick={togglePanelWide}
          title={panelWide ? "收回半屏" : "展开全屏"}>
          {panelWide ? <Minimize2 /> : <Maximize2 />}
        </Button>
        <Button variant="ghost" size="sm" onClick={closeFriendChat} title="关闭">
          <X />
        </Button>
      </header>
      <div className="flex-1 min-h-0 flex flex-col">
        <section className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 flex flex-col gap-[6px] scrollbar-thin">
          {messages.length >= 50 && (
            <button
              className="self-center text-xs text-muted-foreground hover:text-foreground py-1"
              onClick={() => void loadOlderDms()}
            >
              加载更早的消息
            </button>
          )}
          {messages.map((m) => {
            const mine = m.sender !== friend.id; // 面板只有两人,非对方即自己
            return (
              <div key={m.id}
                className={`max-w-[80%] px-3 py-[6px] rounded-lg text-[13px] whitespace-pre-wrap break-words ${
                  mine ? "self-end bg-brand/15" : "self-start bg-foreground/[0.06]"}`}
                title={new Date(m.createdAt).toLocaleString()}
              >
                {m.body}
              </div>
            );
          })}
          {messages.length === 0 && (
            <p className="text-muted-foreground text-xs">还没有消息,和 {friend.name || friend.email} 说点什么。</p>
          )}
          <div ref={bottomRef} />
        </section>
        {friendError && <p className="px-4 pb-2 text-xs text-err">{friendError}</p>}
        <footer className="px-4 py-3 border-t border-border flex gap-2">
          <input
            className="flex-1 min-w-0 bg-transparent border border-border rounded px-3 py-[6px] text-[13px]"
            placeholder={`发给 ${friend.name || friend.email}(${account.name})`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) submit(); }}
          />
          <Button size="sm" onClick={submit}>发送</Button>
        </footer>
      </div>
    </main>
  );
}
