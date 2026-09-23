// AgentsSidebarSection —— 侧栏第三栏「智能体」（#1280，ADR-0297）。
//
// 这一栏取代了「团队」那一栏的位置，但**没有取代团队**：团队原样挂在这一节下面，
// 由 `WorkspacesSidebarSection` 一个字不改地画（`teamsOf` 把主场那一行摘出去而已）。
// 变的是第一层的主语——第三栏问的不再是「我在哪个团队里干活」，而是「我有哪几只
// 智能体」，团队降级成「别人拉我进去的那几个地方」。
//
// **行上不画状态、不画未读**（归 #1282）。桌面同一时刻只连得上一条云会话
// （cloudSessionClient 的 join 先断旧的），所以「它此刻在不在跑」这件事，对着没开
// 的那几条根本无从知道——画一个恒灰的点就是 #722 那颗撒谎的勾的一般形式。
//
// **顺序固定、不按最近活动排**（判据在 `lib/agentRoster.ts` 的 `rosterRows`）：
// 这是通讯录不是会话列表。群那一段反过来按最近活动降序——群是会话。
//
// 三条接线上的纪律：
// ① `homeOf` / `rosterRows` / `groupRows` 在组件里 `useMemo` 算，**不写进 zustand 的
//    selector**：那几个函数每次都造新数组，写进 selector 就是每次渲染都「变了」，
//    而 zustand 走 useSyncExternalStore —— 那是一个真的死循环（Maximum update
//    depth exceeded，`WorkspacesSidebarSection` 的 `unreadMentionCounts` 踩过）。
// ② `ensureHome` 的触发挂在这个组件的 effect 上，依赖 `gate`。`failed` 之后 `gate`
//    是 `failed` 不是 `ensuring`，所以不会自己重试——重试由那张卡上的钮发起。
// ③ 团队快照的拉取**不搬进来**（ADR-0217：挂在这一节上的话，它 return null 时
//    永远等不到第一次拉取）；主场的云会话清单倒是在这一层拉，因为只有这一层
//    知道主场是哪一个。

import { useEffect, useMemo, useRef } from "react";
import { Plus, Settings2 } from "lucide-react";
import { useChat } from "../store.js";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import {
  SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarGroupLabel,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from "@/components/ui/sidebar.js";
import { AgentFace } from "./AgentFace.js";
import { agentFaceSlot } from "../../../shared/agentAvatar.js";
import { groupRows, homeOf, rosterGate, rosterRows, teamsOf } from "../../../shared/agentRoster.js";
import type { AgentRosterRow, GroupChatRow } from "../../../shared/agentRoster.js";
import { workspaceAccess } from "../../../shared/workspaceAccess.js";
import type { CloudSessionListRow } from "../../../shared/workspaceView.js";
import { WorkspacesSidebarSection } from "./WorkspacesSidebarSection.js";

// 没拉过时的兜底：模块级常量而非每次渲染 `?? []`，保证 selector 每次返回同一引用
const EMPTY_CLOUD_SESSIONS: CloudSessionListRow[] = [];

/** 行上那格时间。今天写时刻、昨天写「昨天」、再往前写日期——同微信那一列的读法。
    `updatedTs === 0`（没聊过）由调用方判，不进这里 */
function rowTime(ts: number, now: number): string {
  const d = new Date(ts);
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const nd = new Date(now);
  if (sameDay(d, nd)) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const y = new Date(now - 24 * 60 * 60 * 1000);
  if (sameDay(d, y)) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function AgentsSidebarSection({
  collapsed,
  onToggle,
  onManage,
  onNewGroup,
}: {
  /** 收起来的团队 id 集合。原样透给下面那一节 */
  collapsed: ReadonlySet<string>;
  onToggle: (workspaceId: string) => void;
  /** 打开某个 workspace 的设置抽屉（主场与团队共用这一条路，页面按 kind 自己收格子） */
  onManage: (workspaceId: string) => void;
  /** 「新群聊」。**A4 才接线**——缺席时群聊那个节头上的 ＋ 不画（点了没反应的钮
      就是撒谎的勾，#722） */
  onNewGroup?: () => void;
}) {
  const groups = useChat((s) => s.workspaceGroups);
  const signedIn = useChat((s) => s.account.signedIn);
  const billing = useChat((s) => s.billing);
  const homeEnsure = useChat((s) => s.homeEnsure);
  const homeError = useChat((s) => s.homeError);
  const ensureHome = useChat((s) => s.ensureHome);
  const openSettings = useChat((s) => s.openSettings);
  const refreshCloud = useChat((s) => s.refreshCloudSessions);

  const home = useMemo(() => homeOf(groups), [groups]);
  const teams = useMemo(() => teamsOf(groups), [groups]);
  const access = workspaceAccess({ signedIn, billing });
  const gate = rosterGate({ access, home, ensure: homeEnsure });

  // 档位带、主场还没有 → 自己去建一次。`failed` 之后 gate 是 failed，这个 effect
  // 不会再跑（不自动重试，见文件头 ②）
  useEffect(() => {
    if (gate === "ensuring" && homeEnsure === "idle") void ensureHome();
  }, [gate, homeEnsure, ensureHome]);

  // 主场的云会话清单（没有推送通道，同团队那一节的待遇）。focus 时再拉一次——
  // 会看到这一列的那一刻必然是人回到这扇窗前（同 #1213 的取舍）
  const homeId = home?.id ?? null;
  useEffect(() => {
    if (homeId === null) return undefined;
    const pull = (): void => { void refreshCloud(homeId); };
    pull();
    window.addEventListener("focus", pull);
    return () => window.removeEventListener("focus", pull);
  }, [homeId, refreshCloud]);

  const teamBlock = (
    <WorkspacesSidebarSection
      collapsed={collapsed}
      onToggle={onToggle}
      onManage={onManage}
      // 空态由外层那句统一说：这一栏底下已经有一段话了，团队那节再压一句，
      // 第一次进来的人要读两段才走到列表（同 #1087 给项目栏定的那条理由的反面）
      hideEmpty
    />
  );

  // 团队照列（四个非 ready 态都一样）：别人拉我进的团队与我自己有没有订阅无关
  if (gate !== "ready") {
    return (
      <>
        <SidebarGroupLabel>智能体</SidebarGroupLabel>
        <RosterGateBlock
          gate={gate}
          homeError={homeError}
          onRetry={() => void ensureHome()}
          onAccount={() => void openSettings("account")}
        />
        {teamBlock}
        {(gate === "no_subscription" || gate === "plan_too_low") && (
          <p className="px-[10px] pt-1 text-[11px] text-muted-foreground leading-relaxed">
            别人拉你进的团队照常能用：团队花的是所有者的额度。
          </p>
        )}
      </>
    );
  }

  return (
    <RosterBody
      home={home!}
      teams={teams.length}
      teamBlock={teamBlock}
      onManage={onManage}
      {...(onNewGroup === undefined ? {} : { onNewGroup })}
    />
  );
}

/** 进门那七态里除 `ready` 之外的六个。
    判据全在 `rosterGate`，这里只管措辞——两条纪律：**还没查到订阅时不劝订阅**
    （骨架，同 `workspaceAccess` 的 `unknown` 不许并进 `no_subscription`），
    **没订阅与档位不够各说各的出路**（前者走 checkout，后者走 Portal 换档，
    ADR-0203 决定 18：对已有订阅的人再开一张 checkout 会变成第二条订阅）。
    措辞里**不许出现「填自己的 key」**——云会话没有那条路（ADR-0233）。 */
function RosterGateBlock({
  gate,
  homeError,
  onRetry,
  onAccount,
}: {
  gate: "unknown" | "signed_out" | "no_subscription" | "plan_too_low" | "ensuring" | "failed";
  homeError: string | null;
  onRetry: () => void;
  onAccount: () => void;
}) {
  if (gate === "unknown" || gate === "ensuring") {
    // 「还没查到」与「正在建」画同一件事：这两种都是**马上就会有答案**，
    // 而劝订阅 / 报错都是需要人动手的话，说早了就是噪音
    return (
      <div className="px-[10px] py-1 space-y-[6px]" aria-hidden>
        <Skeleton className="h-[34px] rounded-[7px]" />
        <Skeleton className="h-[34px] rounded-[7px]" />
        <Skeleton className="h-[34px] rounded-[7px]" />
      </div>
    );
  }
  if (gate === "signed_out") {
    return <p className="px-[10px] py-2 text-xs text-muted-foreground">登录之后才有智能体。</p>;
  }
  if (gate === "failed") {
    return (
      <div className="px-[10px] py-1">
        <p className="text-[11px] text-err break-words">暂时读不到智能体：{homeError ?? "原因不明"}</p>
        <Button size="sm" variant="outline" className="mt-[6px] h-7 text-xs" onClick={onRetry}>
          重试
        </Button>
      </div>
    );
  }
  const lite = gate === "plan_too_low";
  return (
    <div className="mx-[10px] my-1 rounded-lg border border-dashed border-border p-[10px]">
      <p className="text-xs font-medium">{lite ? "智能体要 Pro 或 Max" : "订阅之后才有智能体"}</p>
      <p className="mt-[3px] text-[11px] text-muted-foreground leading-relaxed">
        {lite
          ? "你现在这一档不带。智能体跑在云端、有自己的电脑。"
          : "智能体跑在云端，走订阅额度，不能用自己的 API key。"}
      </p>
      <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={onAccount}>
        {lite ? "去换档" : "看看订阅"}
      </Button>
    </div>
  );
}

/** `ready` 那一支。拆出来是为了让上面那个组件的返回路径读得清，也为了 `home!`
    这个非空断言只出现一次 */
function RosterBody({
  home,
  teams,
  teamBlock,
  onManage,
  onNewGroup,
}: {
  home: NonNullable<ReturnType<typeof homeOf>>;
  teams: number;
  teamBlock: React.ReactNode;
  onManage: (workspaceId: string) => void;
  onNewGroup?: () => void;
}) {
  const list = useChat((s) => s.cloudSessionList[home.id]) ?? EMPTY_CLOUD_SESSIONS;
  const openAgentChat = useChat((s) => s.openAgentChat);
  const openGroupChat = useChat((s) => s.openGroupChat);
  const openSessionId = useChat((s) => s.cloudSession?.sessionId ?? null);
  const draftChat = useChat((s) => s.cloudDraftChat);

  const agents = useMemo(() => rosterRows(home, list), [home, list]);
  const groups = useMemo(() => groupRows(home, list), [home, list]);
  // 名册上这一次才多出来的那几只（#1280 A5）。记号只挂一次，动效在 app.css 里。
  // **首次渲染一只都不算新来的**（`seen` 还是 null）——否则每次切到这一栏整列都闪一遍。
  // 上一次的名单落在 effect 里推进、不在渲染里改 ref：StrictMode 下一次渲染跑两遍，
  // 边渲染边改的话第二遍就看不到差集了，于是这个动效在 dev 里一次都不放
  const seen = useRef<ReadonlySet<string> | null>(null);
  const ids = useMemo(() => agents.map((a) => a.agentId), [agents]);
  const fresh = useMemo<ReadonlySet<string>>(
    () => (seen.current === null ? new Set() : new Set(ids.filter((id) => !seen.current!.has(id)))),
    [ids],
  );
  useEffect(() => { seen.current = new Set(ids); }, [ids]);
  // 组件挂载那一刻取一次：行上那格时间不必跟着秒走，下次进来就对了（同 dayLabel）
  const now = useMemo(() => Date.now(), []);

  return (
    <>
      <SidebarGroup className="py-1">
        <SidebarGroupLabel>智能体</SidebarGroupLabel>
        <SidebarGroupAction
          className="text-muted-foreground"
          title="设置：文件 / 连接器 / 用量 / 记忆"
          onClick={() => onManage(home.id)}
        >
          <Settings2 />
        </SidebarGroupAction>
        <SidebarGroupContent>
          <SidebarMenu>
            {agents.map((row) => (
              <AgentRow
                key={row.agentId}
                row={row}
                slot={agentFaceSlot(home, row.agentId)}
                now={now}
                fresh={fresh.has(row.agentId)}
                active={
                  (row.sessionId !== null && row.sessionId === openSessionId) ||
                  (draftChat?.kind === "dm" && draftChat.agentId === row.agentId)
                }
                onOpen={() => void openAgentChat(row.agentId)}
              />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="py-1">
        <SidebarGroupLabel>群聊</SidebarGroupLabel>
        {onNewGroup !== undefined && (
          <SidebarGroupAction className="text-muted-foreground" title="新群聊" onClick={onNewGroup}>
            <Plus />
          </SidebarGroupAction>
        )}
        <SidebarGroupContent>
          {groups.length === 0 ? (
            // 一条都没有时才说这句：群是「可选」的那一半，人得先知道它存在、
            // 以及它什么时候才有意义。有团队时不说——那一段底下已经有内容了
            teams === 0 && (
              <p className="px-2 pt-[2px] text-[11px] text-muted-foreground leading-relaxed">
                还没有群聊。有两只以上智能体时，可以拉它们进一个群里接力干活。
              </p>
            )
          ) : (
            <SidebarMenu>
              {groups.map((row) => (
                <GroupRow
                  key={row.sessionId}
                  row={row}
                  home={home}
                  now={now}
                  active={row.sessionId === openSessionId}
                  onOpen={() => void openGroupChat(row.sessionId)}
                />
              ))}
            </SidebarMenu>
          )}
        </SidebarGroupContent>
      </SidebarGroup>

      {teamBlock}
    </>
  );
}

/** 一只智能体一行：30px 头像 + 名字/时间 + 职责。
    脸一律画 `plain` 那一档 —— **名册这一栏查不到谁在跑**（那张表里没有这一格，#1282），
    画一个恒灰的「空闲」角标等于宣称一件我们查不到的事（#722 那颗撒谎的勾）；
    `plain` 顺带也是静止的，而一墙脸同时呼吸本身就是噪音。
    **只给高亮不给缩放**：切行是每天几十次的动作，缩一下会让这一列的基线跟着跳
    （同 ADR-0249 撤掉「一行两层」的那条理由）。
    `fresh` = 这一次渲染才多出来的那一只（#1280 A5）：入场动效在 app.css 里按
    `[data-fresh="true"]` 挂，只放一次。 */
function AgentRow({
  row,
  slot,
  now,
  active,
  fresh,
  onOpen,
}: {
  row: AgentRosterRow;
  /** 内置像素脸的坑位（0..12，agentAvatar.ts） */
  slot: number;
  now: number;
  active: boolean;
  fresh: boolean;
  onOpen: () => void;
}) {
  return (
    <SidebarMenuItem {...(fresh ? { "data-fresh": "true" } : {})}>
      <SidebarMenuButton
        className="h-auto py-[6px] gap-2"
        isActive={active}
        onClick={onOpen}
        title={row.description === "" ? row.name : `${row.name} · ${row.description}`}
      >
        <AgentFace slot={slot} size={30} className="rounded-[7px]" />
        <span className="min-w-0 flex-1 flex flex-col gap-[1px]">
          <span className="flex items-baseline gap-1">
            <span className="min-w-0 flex-1 truncate text-[13px]">{row.name}</span>
            {/* 没聊过就不画（updatedTs === 0）：一个「1970/1」比空着更难读 */}
            {row.updatedTs > 0 && (
              <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">
                {rowTime(row.updatedTs, now)}
              </span>
            )}
          </span>
          {row.description !== "" && (
            <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{row.description}</span>
          )}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** 一个群一行：重叠头像 + 群名/时间 + 成员名。 */
function GroupRow({
  row,
  home,
  now,
  active,
  onOpen,
}: {
  row: GroupChatRow;
  home: NonNullable<ReturnType<typeof homeOf>>;
  now: number;
  active: boolean;
  onOpen: () => void;
}) {
  const names = row.agentIds.map((id) => home.agents.find((a) => a.agentId === id)?.name ?? id);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="h-auto py-[6px] gap-2"
        isActive={active}
        onClick={onOpen}
        title={`${row.name} · ${names.join("、")}`}
      >
        <span className="shrink-0 flex items-center">
          {/* 最多三张：侧栏 16rem，名字才是这一行的主语（同 ParticipantStack 的取舍） */}
          {row.agentIds.slice(0, 3).map((id) => (
            <AgentFace
              key={id}
              slot={agentFaceSlot(home, id)}
              size={24}
              className="-ml-[7px] first:ml-0 rounded-[6px] ring-[1.5px] ring-sidebar"
            />
          ))}
        </span>
        <span className="min-w-0 flex-1 flex flex-col gap-[1px]">
          <span className="flex items-baseline gap-1">
            <span className="min-w-0 flex-1 truncate text-[13px]">{row.name}</span>
            {row.updatedTs > 0 && (
              <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">
                {rowTime(row.updatedTs, now)}
              </span>
            )}
          </span>
          <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{names.join(" · ")}</span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
