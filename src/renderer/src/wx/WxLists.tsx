// WxLists —— 桌面微信式布局（#1386）中间那一列的三种内容：聊天 / 通讯录 / 我。
//
// 判据都不在这里：会话怎么拼怎么排、角标怎么数在 wechatInbox（useWxInbox），能不能有自己的智能体在
// rosterGate，额度那一行写什么在 mobileAccount.weekQuota —— 手机那一份（mobile/src/tabs/）与这里读同一批函数。

import { useMemo, type ReactNode } from "react";
import {
  BookOpen, Blocks, ChartColumn, ChevronRight, Folder, Gauge, LogOut, Plus, Settings, UserRoundPlus, UsersRound,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { cn } from "@/lib/utils.js";
import { useChat } from "../store.js";
import { PlanBadge } from "../components/PlanBadge.js";
import { WxAvatar, WxFace, WxPerson } from "./WxAvatar.js";
import { WxBadge, WxChatRow, WxEntryRow, WxFold, WxListLabel } from "./ui.js";
import type { WxInbox } from "./useWxInbox.js";
import { agentFaceSlot } from "../../../shared/agentAvatar.js";
import { rosterRows, type RosterGate } from "../../../shared/agentRoster.js";
import type { FriendProfile } from "../../../shared/friends.js";
import { accountBadge, weekQuota } from "../../../shared/mobileAccount.js";
import { filterInbox, friendName, listTimeLabel, sortFriends, type InboxRow } from "../../../shared/wechatInbox.js";
import type { CloudSessionListRow } from "../../../shared/workspaceView.js";
import type { MeSection } from "./WxMe.js";

const EMPTY_ROWS: CloudSessionListRow[] = [];

/** 没订阅 / 档位不够时那一张卡：说清为什么、给一条去订阅的路（措辞同桌面花名册那一节，不许出现「填自己的 key」） */
function GateCard({ gate, onSubscribe }: { gate: RosterGate; onSubscribe: () => void }) {
  if (gate !== "no_subscription" && gate !== "plan_too_low") return null;
  const lite = gate === "plan_too_low";
  return (
    <div className="mx-3 mt-1 mb-2.5 flex flex-col gap-2 rounded-[12px] bg-card p-3.5">
      <div className="text-[13.5px] font-semibold">{lite ? "智能体要 Pro 或 Max" : "订阅 Pro，就能有自己的智能体"}</div>
      <p className="m-0 text-[12.5px] leading-[1.55] text-muted-foreground">
        {lite
          ? "你现在这一档不带。智能体跑在云端、有自己的电脑。"
          : "它们有名字、有职责，能私聊、拉群、打电话。朋友拉你进的群照样能聊，群里的智能体走群主的额度。"}
      </p>
      <Button size="sm" className="self-start" onClick={onSubscribe}>
        {lite ? "去换档" : "看看订阅"}
      </Button>
    </div>
  );
}

/** 主场建失败 / 正在建：一句原因 + 重试；正在建画骨架（「马上就会有答案」不劝订阅，同 rosterGate 的纪律） */
function HomeStatus({ gate, error, onRetry }: { gate: RosterGate; error: string | null; onRetry: () => void }) {
  if (gate === "unknown" || gate === "ensuring") {
    return (
      <div className="space-y-2 px-3.5 py-2" aria-hidden>
        <Skeleton className="h-12 rounded-[8px]" />
        <Skeleton className="h-12 rounded-[8px]" />
      </div>
    );
  }
  if (gate === "failed") {
    return (
      <div className="px-3.5 py-2">
        <p className="m-0 text-[12px] break-words text-err">暂时读不到你的智能体：{error ?? "原因不明"}</p>
        <Button size="sm" variant="secondary" className="mt-1.5 h-7" onClick={onRetry}>
          重试
        </Button>
      </div>
    );
  }
  return null;
}

// ── 聊天 ─────────────────────────────────────────────────────────────

function previewOf(row: InboxRow): ReactNode {
  if (row.mention) {
    return (
      <>
        <span className="font-medium text-brand">[有人@我]</span> {row.preview}
      </>
    );
  }
  return row.preview;
}

export function ChatList({
  inbox,
  query,
  gate,
  homeError,
  now,
  onOpen,
  onSubscribe,
  onRetryHome,
}: {
  inbox: WxInbox;
  query: string;
  gate: RosterGate;
  homeError: string | null;
  now: number;
  onOpen: (row: InboxRow) => void;
  onSubscribe: () => void;
  onRetryHome: () => void;
}) {
  const rows = useMemo(() => filterInbox(inbox.rows, query), [inbox.rows, query]);
  return (
    <>
      <GateCard gate={gate} onSubscribe={onSubscribe} />
      {rows.length === 0 && <HomeStatus gate={gate} error={homeError} onRetry={onRetryHome} />}
      {rows.map((r) => (
        <WxChatRow
          key={r.key}
          current={r.key === inbox.openKey}
          onClick={() => onOpen(r)}
          avatar={<WxAvatar spec={r.avatar} size={42} />}
          badge={
            r.unread === null ? null : r.unread.kind === "count" ? (
              <WxBadge count={r.unread.n} ringClass={r.key === inbox.openKey ? "ring-accent" : "ring-sidebar"} />
            ) : (
              <WxBadge dot ringClass={r.key === inbox.openKey ? "ring-accent" : "ring-sidebar"} />
            )
          }
          name={r.title}
          time={r.ts > 0 ? listTimeLabel(r.ts, now) : ""}
          preview={previewOf(r)}
          title={r.title}
        />
      ))}
      {rows.length === 0 && gate !== "unknown" && gate !== "ensuring" && gate !== "failed" && (
        <p className="px-5 py-8 text-center text-[12.5px] leading-relaxed text-muted-foreground">
          {query.trim() !== "" ? "没有找到。" : "还没有聊天。到通讯录里挑一只智能体、或者一位朋友，发一句话就开始了。"}
        </p>
      )}
    </>
  );
}

// ── 通讯录 ───────────────────────────────────────────────────────────

export type ContactSelection =
  | { type: "requests" }
  | { type: "groups" }
  | { type: "agent"; workspaceId: string; agentId: string }
  | { type: "friend"; uid: string };

export function ContactList({
  inbox,
  query,
  gate,
  homeError,
  selected,
  onSelect,
  onNewAgent,
  onSubscribe,
  onRetryHome,
}: {
  inbox: WxInbox;
  query: string;
  gate: RosterGate;
  homeError: string | null;
  selected: ContactSelection | null;
  onSelect: (c: ContactSelection) => void;
  onNewAgent: () => void;
  onSubscribe: () => void;
  onRetryHome: () => void;
}) {
  const home = inbox.home;
  const homeChats = useChat((s) => (home === null ? EMPTY_ROWS : (s.cloudSessionList[home.id] ?? EMPTY_ROWS)));
  const q = query.trim().toLowerCase();
  const hit = (...parts: string[]): boolean => q === "" || parts.join("\n").toLowerCase().includes(q);
  const agents = useMemo(() => (home === null ? [] : rosterRows(home, homeChats)), [home, homeChats]);
  const shownAgents = agents.filter((a) => hit(a.name, a.description));
  const friends = useMemo(
    () => sortFriends(inbox.friends.map((profile) => ({ profile }))).map((x) => x.profile),
    [inbox.friends],
  );
  const shownFriends = friends.filter((f) => hit(friendName(f), f.email));
  const isSel = (c: ContactSelection): boolean => {
    if (selected === null || selected.type !== c.type) return false;
    if (c.type === "agent" && selected.type === "agent") return c.agentId === selected.agentId && c.workspaceId === selected.workspaceId;
    if (c.type === "friend" && selected.type === "friend") return c.uid === selected.uid;
    return true;
  };
  return (
    <>
      <WxEntryRow
        icon={<UserRoundPlus />}
        label="新的朋友"
        current={isSel({ type: "requests" })}
        onClick={() => onSelect({ type: "requests" })}
        right={
          inbox.incoming > 0 ? (
            <span className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand px-[5px] text-[11px] font-semibold text-white tabular-nums">
              {inbox.incoming > 99 ? "99+" : inbox.incoming}
            </span>
          ) : null
        }
      />
      <WxEntryRow
        icon={<UsersRound />}
        label="群聊"
        current={isSel({ type: "groups" })}
        onClick={() => onSelect({ type: "groups" })}
        right={inbox.groups.length > 0 ? inbox.groups.length : null}
      />
      <WxFold
        label="智能体"
        count={gate === "ready" ? agents.length : 0}
        forceOpen={q !== ""}
        action={
          gate === "ready" ? (
            <button
              type="button"
              title="新建智能体"
              aria-label="新建智能体"
              onClick={onNewAgent}
              className="grid size-[26px] place-items-center rounded-md text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-foreground/[0.05] hover:text-foreground active:scale-[0.94]"
            >
              <Plus className="size-[15px]" strokeWidth={2} aria-hidden />
            </button>
          ) : undefined
        }
      >
        {gate === "ready" && home !== null ? (
          shownAgents.map((a) => {
            const c: ContactSelection = { type: "agent", workspaceId: home.id, agentId: a.agentId };
            return (
              <PersonRow
                key={a.agentId}
                current={isSel(c)}
                onClick={() => onSelect(c)}
                avatar={<WxFace slot={agentFaceSlot(home, a.agentId)} size={38} />}
                name={a.name}
                sub={a.description}
              />
            );
          })
        ) : (
          <>
            <GateCard gate={gate} onSubscribe={onSubscribe} />
            <HomeStatus gate={gate} error={homeError} onRetry={onRetryHome} />
          </>
        )}
      </WxFold>
      <WxFold label="朋友" count={friends.length} forceOpen={q !== ""}>
        {shownFriends.length === 0 && friends.length === 0 ? (
          <p className="px-5 py-3 text-[12px] leading-relaxed text-muted-foreground">
            还没有朋友。点上面「新的朋友」添加——加了朋友才能拉 TA 进群。
          </p>
        ) : (
          shownFriends.map((f: FriendProfile) => {
            const c: ContactSelection = { type: "friend", uid: f.id };
            return (
              <PersonRow
                key={f.id}
                current={isSel(c)}
                onClick={() => onSelect(c)}
                avatar={<WxPerson name={friendName(f)} url={f.avatarUrl} size={38} />}
                name={friendName(f)}
                sub={f.email}
              />
            );
          })
        )}
      </WxFold>
    </>
  );
}

function PersonRow({
  avatar,
  name,
  sub,
  current,
  onClick,
}: {
  avatar: ReactNode;
  name: string;
  sub: string;
  current: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? "true" : undefined}
      className={cn(
        "flex h-[58px] w-full items-center gap-[11px] px-3.5 text-left transition-colors duration-100",
        current ? "bg-accent text-accent-foreground" : "hover:bg-foreground/[0.045]",
      )}
    >
      {avatar}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] font-medium">{name}</span>
        {sub !== "" && <span className="truncate text-[12px] text-muted-foreground">{sub}</span>}
      </span>
    </button>
  );
}

// ── 我 ───────────────────────────────────────────────────────────────

export function MeList({
  selected,
  hasHome,
  now,
  onSelect,
  onSignOut,
}: {
  selected: MeSection | null;
  hasHome: boolean;
  now: number;
  onSelect: (s: MeSection) => void;
  onSignOut: () => void;
}) {
  const account = useChat((s) => s.account);
  const profile = useChat((s) => s.myProfile);
  const billing = useChat((s) => s.billing);
  const home = useChat((s) => s.workspaceGroups.find((g) => g.kind === "home") ?? null);
  const name = (profile?.name || account.name || account.email).trim();
  const email = profile?.email || account.email;
  const url = profile?.avatarUrl || account.avatarUrl || "";
  const badge = accountBadge(billing);
  const quota = weekQuota(billing, now);
  const quotaValue = quota.kind === "week" ? `还剩 ${quota.week.remaining}` : "";
  return (
    <>
      <button
        type="button"
        onClick={() => onSelect("profile")}
        aria-current={selected === "profile" ? "true" : undefined}
        title="个人信息"
        className={cn(
          "flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors duration-100",
          selected === "profile" ? "bg-accent text-accent-foreground" : "hover:bg-foreground/[0.045]",
        )}
      >
        <WxPerson name={name} url={url} size={52} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[16px] font-semibold">{name}</span>
            {badge !== null && <PlanBadge id={badge.id} />}
          </span>
          <span className="truncate text-[12px] text-muted-foreground">{email}</span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
      </button>
      <div className="h-2" />
      <WxEntryRow icon={<Gauge />} label="订阅与额度" current={selected === "quota"} onClick={() => onSelect("quota")} right={quotaValue} />
      {hasHome && (
        <>
          <WxListLabel>它们共用的一台电脑</WxListLabel>
          <WxEntryRow icon={<Folder />} label="文件" current={selected === "files"} onClick={() => onSelect("files")} />
          <WxEntryRow
            icon={<Blocks />}
            label="应用"
            current={selected === "apps"}
            onClick={() => onSelect("apps")}
            right={home !== null && home.connectors.length > 0 ? home.connectors.length : null}
          />
          <WxEntryRow icon={<BookOpen />} label="记忆" current={selected === "memory"} onClick={() => onSelect("memory")} />
          <WxEntryRow icon={<ChartColumn />} label="这周谁用得多" current={selected === "usage"} onClick={() => onSelect("usage")} />
        </>
      )}
      <WxListLabel>其他</WxListLabel>
      <WxEntryRow icon={<Settings />} label="设置" current={selected === "settings"} onClick={() => onSelect("settings")} />
      <WxEntryRow icon={<LogOut />} label="退出登录" current={false} onClick={onSignOut} />
    </>
  );
}
