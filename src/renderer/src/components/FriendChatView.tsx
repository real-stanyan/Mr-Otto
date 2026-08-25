// FriendChatView — 好友 DM 右侧叠加面板(同 Protocol/GitGraph 槽位)。
// 气泡结构用 shadcn 的 Message/Bubble(components/ui/message.tsx、bubble.tsx),
// 排版规则(分组/日期分隔/时间文案)全在 lib/friendsState.ts 的纯函数里,这里只渲染。
//
// 容器类名照抄 GitGraphView/ProtocolView 的既有写法:半屏/全屏/border-l 由
// App.tsx 里包这块 panel 的 side-panel 外层 div 统一处理(见 App.tsx `main` 变量),
// 这里的顶层容器只是 flex-1 min-w-0 flex flex-col——不是 aside,不重复套宽度/边框类,
// 否则会和外层 side-panel 的 w-1/2·border-l 叠两层。

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../store.js";
import { Button } from "@/components/ui/button.js";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { Bubble, BubbleContent } from "@/components/ui/bubble.js";
import {
  Message, MessageAvatar, MessageContent, MessageFooter, MessageGroup,
} from "@/components/ui/message.js";
import { X, Maximize2, Minimize2, Spade, AlertCircle } from "lucide-react";
import { SidebarNub } from "./SidebarNub.js";
import { InviteTableMenu } from "./InviteTableMenu.js";
import { POKER_ENABLED } from "../../../shared/features.js";
import { buildChatRows, timeLabel, type ChatMessage } from "../lib/friendsState.js";

// 好友未选中/dmByFriend 里没这个人时的兜底——模块级常量而非每次渲染 `?? []`,
// 保证 selector 每次返回同一引用,不触发 zustand 无谓重渲(仓库 selector 约定)
const EMPTY: ChatMessage[] = [];

export function FriendChatView() {
  const friend = useChat((s) => s.friendChat);
  const messages = useChat((s) => (friend ? s.dmByFriend[friend.id] : undefined)) ?? EMPTY;
  const onlineIds = useChat((s) => s.onlineIds);
  const friendError = useChat((s) => s.friendError);
  const health = useChat((s) => s.realtimeHealth);
  const sendDm = useChat((s) => s.sendDm);
  const loadOlderDms = useChat((s) => s.loadOlderDms);
  const closeFriendChat = useChat((s) => s.closeFriendChat);
  const panelWide = useChat((s) => s.panelWide);
  const togglePanelWide = useChat((s) => s.togglePanelWide);

  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // 翻旧页不弹底,只在最新一条变化时贴底:messages.length 在 loadOlderDms 时也会变
  // (prepend),用 lastId 而非 length 才能把"顶部插入旧消息"和"末尾追加新消息"分开
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lastId, friend?.id]);

  // 输入框跟着内容长高(到 5 行封顶):写长消息时看得见自己写了什么
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 120)}px`;
  }, [draft]);

  // 行的构造是纯函数,只在消息真变了的时候重算(now 只用于"今天/昨天"文案,
  // 跨零点没刷新最多是标签晚一天,不值得为它起个定时器)
  const rows = useMemo(
    () => (friend ? buildChatRows(messages, friend.id, Date.now()) : []),
    [messages, friend]
  );

  if (!friend) return null;
  const name = friend.name || friend.email;
  const online = onlineIds.includes(friend.id);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void sendDm(text);
  };

  return (
    <main className="flex-1 min-w-0 flex flex-col">
      {/* 头部是浮在内容之上的一层材质(半透明 + 背景模糊),不是一条实心色带:
          滚动的消息从它底下过去,层次靠材质而不是描边(Apple 的 materials 那条) */}
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-card/70 px-4 py-2 backdrop-blur-xl drag-region">
        {/* 全屏时本面板独占内容区,侧栏的重开钮没有别的落点——排进这排最左 */}
        {panelWide && <SidebarNub />}
        <div className="relative shrink-0">
          <Avatar size="sm">
            <AvatarImage src={friend.avatarUrl} alt={name} />
            <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          {/* 在线点长在头像上而不是名字前:状态属于这个人,不属于这行文字 */}
          <span
            className={`absolute -bottom-px -right-px size-2 rounded-full ring-2 ring-card ${
              online ? "bg-brand" : "bg-border"
            }`}
            aria-label={online ? "在线" : "离线"}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-[650] tracking-[-0.01em]">{name}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {health === "degraded" ? "实时推送不通,轮询兜底(慢几秒)" : online ? "在线" : "离线"}
          </div>
        </div>
        {POKER_ENABLED && (
          <InviteTableMenu friendId={friend.id} label={`约 ${name} 打牌`}>
            <Button variant="ghost" size="icon-sm" title={`约 ${name} 打牌`} aria-label="约打牌">
              <Spade />
            </Button>
          </InviteTableMenu>
        )}
        <Button variant="ghost" size="icon-sm" onClick={togglePanelWide}
          title={panelWide ? "收回半屏" : "展开全屏"}>
          {panelWide ? <Minimize2 /> : <Maximize2 />}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={closeFriendChat} title="关闭">
          <X />
        </Button>
      </header>

      <div className="flex-1 min-h-0 flex flex-col">
        <section className="scrollbar-thin flex flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden px-4 py-3">
          {messages.length >= 50 && (
            <button
              className="self-center rounded-full px-3 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground"
              onClick={() => void loadOlderDms()}
            >
              加载更早的消息
            </button>
          )}

          {rows.map((row) =>
            row.kind === "day" ? (
              <div key={row.key} className="my-1 flex items-center justify-center">
                <span className="rounded-full bg-foreground/[0.05] px-2.5 py-[3px] text-[11px] text-muted-foreground">
                  {row.label}
                </span>
              </div>
            ) : (
              <MessageGroup key={row.key} className="gap-[3px]">
                {row.messages.map((m, i) => {
                  const last = i === row.messages.length - 1;
                  const failed = m.status === "failed";
                  return (
                    <Message key={m.id} align={row.mine ? "end" : "start"}>
                      {/* 头像只挂在一组的最后一条上,中间几条留出等宽空位 ——
                          一串连着说的话本来就是一个人的一次发言 */}
                      {row.mine ? null : last ? (
                        <MessageAvatar className="bg-transparent">
                          <Avatar size="sm">
                            <AvatarImage src={friend.avatarUrl} alt={name} />
                            <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
                          </Avatar>
                        </MessageAvatar>
                      ) : (
                        <div className="w-8 shrink-0" aria-hidden />
                      )}
                      <MessageContent className="gap-[3px]">
                        <Bubble
                          variant={failed ? "destructive" : row.mine ? "tinted" : "muted"}
                          className={`dm-bubble ${m.status === "sending" ? "opacity-60" : ""}`}
                        >
                          <BubbleContent className="whitespace-pre-wrap">{m.body}</BubbleContent>
                        </Bubble>
                        {/* 时间/状态只在组尾出现:每条都盖一行时间会把对话读成日志 */}
                        {(last || failed) && (
                          <MessageFooter className="gap-1 text-[10px]">
                            {failed ? (
                              <span className="flex items-center gap-1 text-destructive">
                                <AlertCircle className="size-3" />
                                没发出去
                              </span>
                            ) : m.status === "sending" ? (
                              "发送中…"
                            ) : (
                              timeLabel(m.createdAt)
                            )}
                          </MessageFooter>
                        )}
                      </MessageContent>
                    </Message>
                  );
                })}
              </MessageGroup>
            )
          )}

          {messages.length === 0 && (
            <p className="text-xs text-muted-foreground">还没有消息,和 {name} 说点什么。</p>
          )}
          <div ref={bottomRef} />
        </section>

        {friendError && <p className="px-4 pb-2 text-xs text-err">{friendError}</p>}

        <footer className="flex items-end gap-2 border-t border-border/60 bg-card/70 px-4 py-3 backdrop-blur-xl">
          <textarea
            ref={boxRef}
            rows={1}
            className="min-h-[34px] flex-1 min-w-0 resize-none rounded-2xl border border-border bg-transparent px-3 py-[7px] text-[13px] leading-relaxed transition-colors duration-150 placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none"
            placeholder={`发给 ${name}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter 发送、Shift+Enter 换行;输入法组词途中的 Enter 是"选词",不是"发送"
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <Button size="sm" className="rounded-full" disabled={!draft.trim()} onClick={submit}>
            发送
          </Button>
        </footer>
      </div>
    </main>
  );
}
