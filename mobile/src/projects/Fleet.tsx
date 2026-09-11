// 舰队：到自己那台电脑的加密连接 + 会话列表 + 审批。从 App.tsx 拆出来（#1237 M0），
// 挂在项目栏的根上（ADR-0293）。

import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { IslandAgent, IslandFleet } from "../../../src/shared/shellBridge.js";
import type { MobileMessage, UpFrame } from "../../../src/shared/remote/frames.js";
import { chunkUpload } from "../../../src/shared/remote/uploads.js";
import { groupByWorkspace, groupTone, type WorkspaceGroup } from "../../../src/shared/remote/groups.js";
import type { PinnedPeerStore } from "../../../src/shared/remote/devices.js";
import type { MobileBridge } from "../../../src/shared/remote/mobileBridge.js";
import { connect } from "../session.js";
import { prepareForUpload, type Picked } from "../attach.js";
import { usePalette, type as t, MONO, space } from "../theme.js";
import {
  Button, Card, Dot, FolderIcon, Headline, Hint, Meta, Page, Spinner, StatusLine, Tile,
} from "../ui.js";
import { Approval, SessionView } from "./SessionView.js";
import { elapsed, useTicker } from "./clock.js";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { linkStatus } from "../../../src/shared/linkStatus.js";
import { useLink } from "../link.js";
import { hapticDecided } from "../haptics.js";

/* ── 舰队 ───────────────────────────────────────────────
   看 + 审批。桌面不在线时不假装有内容:一句"你的 Mac 不在线"
   (中继零落盘,没有队列可回放 —— 这是设计,不是缺陷)。 */
export function Fleet({ store, onRepair, onDetailChange }: {
  store: PinnedPeerStore;
  onRepair: () => void;
  /** 翻进详情屏时,项目栏的大标题与页签栏都要让位 */
  onDetailChange: (inDetail: boolean) => void;
}) {
  // 连接状态、统计、「问一次」这个动作交给 LinkProvider:项目栏大标题底下那行与账号页都读它。
  // **只交数据和动作,不交桥** —— 桥的生命周期仍然归这一屏
  const { setStatus, setStats, askStats } = useLink();
  /** 会话详情要自己躲开刘海和 home 条:那时原生导航栏收着 */
  const insets = useSafeAreaInsets();
  const [fleet, setFleet] = useState<IslandFleet | null>(null);
  const [ready, setReady] = useState(false);
  /** 打开的会话。null = 停在列表上 */
  const [open, setOpen] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<MobileMessage[] | null>(null);
  const bridge = useRef<MobileBridge | null>(null);
  /** 订阅状态归手机(桌面那侧的 watch 是连接级的,断了就忘)。
      重连后要靠这个 ref 把 watch 补发一次 —— 否则详情屏会永远停在旧内容 */
  const watching = useRef<string | null>(null);
  /** 收起的工作区(全路径为键)。**内存态,不持久化** —— 和灵动岛那侧同一个决定:
      收起是"这会儿别占地方",不是一条要记住的偏好 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** 桌面回过来的一句话(附件被拒之类)。**只有它能说"这个文件没收下"** ——
      静默丢弃在手机上和"传成功了"长得一模一样 */
  const [notice, setNotice] = useState<string | null>(null);
  /** 手机上没有终端。这两样是详情屏在"等不到内容"时唯一能给人看的东西 */
  const [diag, setDiag] = useState<{ frames: number; timelines: number; log: string[] }>(
    { frames: 0, timelines: 0, log: [] },
  );

  useEffect(() => {
    const b = connect(store, {
      onLog: (m) => setDiag((d) => ({ ...d, log: [...d.log, m].slice(-6) })),
      onFrame: (f) => {
        setDiag((d) => ({
          ...d,
          frames: d.frames + 1,
          timelines: d.timelines + (f.type === "timeline" ? 1 : 0),
        }));
        if (f.type === "notice") setNotice(f.text);
        else if (f.type === "fleet") setFleet(f.fleet);
        else if (f.type === "stats") setStats(f.stats);
        // 只认自己订的那一个:换会话时旧订阅的迟到帧不该覆盖新屏
        else if (f.type === "timeline" && f.sessionId === watching.current) setTimeline(f.messages);
      },
      onReady: (r) => {
        setReady(r);
        // **断线不清屏**。第一版这里把 fleet 和 timeline 都清成 null,于是
        // 每一次抖动(切后台回来、Wi-Fi 切蜂窝、网关掐 idle)都会把人正在读的
        // 那一屏换成整页"你的 Mac 不在线",两秒后又换回来。断线是常态,
        // 而"清屏"是个不可逆的动作——它把内容和连接状态混成了一件事。
        // 现在只有连接状态会变,内容留着,由横幅说清楚它是断线前的。
        if (r && watching.current) b.send({ type: "watch", sessionId: watching.current });
      },
    });
    bridge.current = b;
    askStats.current = () => { b.send({ type: "stats" }); };
    return () => {
      askStats.current = null;
      b.dispose();
    };
    // 这条连接一辈子只建一次 —— 让 setStats / askStats 进依赖,等于冒着每次渲染都重连的险
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const openSession = (sessionId: string): void => {
    onDetailChange(true);
    watching.current = sessionId;
    setTimeline(null); // 上一个会话的内容一帧都不要留在屏上
    setOpen(sessionId);
    bridge.current?.send({ type: "watch", sessionId });
  };

  // 打开的那个会话可能从舰队里消失(电脑上关掉了):退回列表,别停在一屏死内容。
  // 放 effect 里而不是渲染里 —— 渲染期 setState 是 React 的未定义行为
  useEffect(() => {
    if (open !== null && fleet && !fleet.agents.some((a) => a.sessionId === open)) closeSession();
    // closeSession 每次 render 新建,不进依赖:它只读 ref + setState
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fleet]);

  const closeSession = (): void => {
    onDetailChange(false);
    const sid = watching.current;
    watching.current = null;
    setOpen(null);
    setTimeline(null);
    if (sid) bridge.current?.send({ type: "unwatch", sessionId: sid });
  };

  // 有会话在跑才让钟走 —— 空闲时不必每秒唤醒 JS 线程
  const now = useTicker((fleet?.agents ?? []).some((a) => a.phase === "active"));

  /**
   * 发一条消息,可以带附件。**不乐观回显**:把一条没发出去的消息画在时间线上,
   * 比直接说"没连上"糟糕得多 —— 用户会以为电脑那边已经在跑了。
   *
   * 附件先分片传完,最后那条 send 才带上它们的 id。**顺序是要紧的**:
   * 反过来的话桌面会拿着一串还没到的 id,只能整条拒收。
   *
   * 回 null = 发出去了;回字符串 = 没发出去的理由。
   */
  const submitMessage = async (
    sessionId: string,
    text: string,
    files: readonly Picked[],
    onProgress: (done: number, total: number) => void,
  ): Promise<string | null> => {
    const post = (f: UpFrame): boolean => bridge.current?.send(f) ?? false;
    const offline = "没发出去 —— 你的 Mac 不在线";

    const ids: string[] = [];
    // 先全部备好再开始发:进度条要有个分母,而且**图片要先转码缩放**
    // (prepareForUpload:HEIC → JPEG,超上限的按阶梯降)。它抛的错由调用方接住
    let sent = 0;
    const chunks: { name: string; parts: string[] }[] = [];
    for (const f of files) {
      const ready = await prepareForUpload(f);
      chunks.push({ name: ready.name, parts: chunkUpload(ready.data) });
    }
    const total = chunks.reduce((n, c) => n + c.parts.length, 0);

    for (const [i, c] of chunks.entries()) {
      // uploadId 只在这一条连接里有意义(桌面那侧断线就清空),所以不用全局唯一,
      // 只要这一轮里不撞
      const uploadId = `u${i}-${sent}-${text.length}-${c.parts.length}`;
      for (const [seq, data] of c.parts.entries()) {
        if (!post({ type: "upload", uploadId, seq, total: c.parts.length, name: c.name, data })) {
          return offline;
        }
        sent += 1;
        onProgress(sent, total);
      }
      ids.push(uploadId);
    }

    const ok = ids.length
      ? post({ type: "send", sessionId, text, uploads: ids })
      : post({ type: "send", sessionId, text });
    return ok ? null : offline;
  };

  // 断了先当抖动看:这么久还没回来才认定是真离线(而且只在**一无所有**时才翻脸,
  // 手里有快照就一直留着,见 onReady)。冷启动同样走这条——刚打开 app 的
  // 头一两秒握手还没完,直接甩一句"你的 Mac 不在线"是在说谎
  const GRACE_MS = 6_000;
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (ready) return setSettled(false);
    const id = setTimeout(() => setSettled(true), GRACE_MS);
    return () => clearTimeout(id);
  }, [ready]);

  // 判据在 shared/linkStatus.ts:项目栏大标题底下那行与账号页读的是同一句话
  const link = linkStatus(ready, settled, fleet !== null);
  useEffect(() => {
    setStatus(link);
    // link 每次渲染都是新对象,按它的两格字段比
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link.tone, link.text, setStatus]);

  const decide = (a: IslandAgent, ok: boolean): void => {
    const callId = a.pendingApproval?.callId;
    if (!callId) return;
    // send 回 false = 会话没建立。不乐观更新:审批这种动作显示成"批了"
    // 而其实没发出去,比显示"没连上"糟糕得多;触感也只在真发出去时给
    const sent = bridge.current?.send({
      type: ok ? "approve" : "deny", sessionId: a.sessionId, callId,
    }) ?? false;
    if (sent) hapticDecided();
  };

  // 一无所有的两种:还在等第一份(转圈),和等够了还没有(说实话)
  if (!fleet) {
    if (!settled) {
      return (
        <Page grow>
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Spinner />
          </View>
        </Page>
      );
    }
    return (
      <Page>
        <StatusLine tone={link.tone}>{link.text}</StatusLine>
        <Card>
          <Headline>你的 Mac 不在线</Headline>
          <Hint>它上线之后这里会自动出现。中继不落盘,期间发生的事不会补播。</Hint>
        </Card>
        <Button label="重新配对" variant="plain" onPress={onRepair} />
      </Page>
    );
  }

  const opened = open === null ? null : fleet.agents.find((a) => a.sessionId === open) ?? null;
  if (opened) {
    return (
      // 这时项目栏的原生导航栏收着:自己躲开刘海和 home 条
      <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <SessionView
          agent={opened} now={now} messages={timeline} diag={diag} online={ready}
          notice={notice} onDismissNotice={() => setNotice(null)}
          onBack={closeSession} onDecide={decide}
          onSubmit={(text, files, p) => submitMessage(opened.sessionId, text, files, p)}
          onRetry={() => bridge.current?.send({ type: "watch", sessionId: opened.sessionId })}
        />
      </View>
    );
  }

  return (
    <Page>
      {/* 大标题「项目」是原生导航栏画的;它底下这一行说到电脑那条连接此刻怎么样
          (原来挂在品牌栏上)。断线时它会说「下面是断线前的」 */}
      <StatusLine tone={link.tone}>{link.text}</StatusLine>
      {fleet.agents.length === 0 ? (
        <Card>
          <Headline>没有打开的会话</Headline>
          <Hint>在电脑上开一个,这里会自己出现。</Hint>
        </Card>
      ) : (
        // 分组和灵动岛同一套(shared/remote/groups.ts):同一份 IslandFleet
        // 在桌面、岛、手机上不该长得不一样
        groupByWorkspace(fleet.agents).map((g, i) => {
          const shut = collapsed.has(g.key);
          return (
            <View key={`${g.key}#${i}`} style={{ gap: space.sm }}>
              <WorkspaceHeader
                group={g} collapsed={shut}
                onToggle={() => setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(g.key)) next.add(g.key);
                  return next;
                })}
              />
              {shut ? null : g.agents.map((a) => (
                <AgentCard
                  key={a.sessionId} agent={a} now={now} onDecide={decide} online={ready}
                  onOpen={() => openSession(a.sessionId)}
                />
              ))}
            </View>
          );
        })
      )}
    </Page>
  );
}

/** 工作区组头。整行可点收放,和灵动岛的 workspaceHeader 一个形状。
    **收起时组内状态不能凭空消失**:组里有等审批的给 warn 点(要人动手的那种,
    绝不能被收起藏没),否则有 active 给 busy 点 —— 这是收起功能能不能用的前提。 */
function WorkspaceHeader({ group: g, collapsed, onToggle }: {
  group: WorkspaceGroup;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { c } = usePalette();
  const tone = collapsed ? groupTone(g) : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: !collapsed }}
      onPress={onToggle}
      hitSlop={8}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: space.xs, paddingTop: space.sm },
        pressed && { opacity: 0.5 },
      ]}
    >
      {/* 开合状态用文件夹的开/合表示,不是三角:三角只说"这里能展开",
          文件夹连"下面这些是一个工作区"一起说了。
          不做开合动画 —— 这一行一天要点很多次,动效在这种频次上只会让人等 */}
      <FolderIcon open={!collapsed} color={c.mutedForeground} />
      <Text
        style={{ ...t.callout, fontWeight: "600", color: c.mutedForeground }}
        numberOfLines={1}
      >
        {g.label}
      </Text>
      {tone ? <Dot tone={tone} /> : null}
    </Pressable>
  );
}

function AgentCard({ agent: a, now, onDecide, onOpen, online }: {
  agent: IslandAgent;
  now: number;
  onDecide: (a: IslandAgent, ok: boolean) => void;
  onOpen: () => void;
  online: boolean;
}) {
  const { c } = usePalette();
  const tone = a.phase === "approval" ? "warn" : a.phase === "active" ? "busy" : "idle";
  const what = a.phase === "approval" ? "等你批" : a.phase === "active" ? "跑着" : "空闲";
  const d = a.turnDiff;

  return (
    <Card style={{ gap: space.sm }}>
      {/* 行首方块 + 标题,和桌面 permission-grant 的头一行同构 */}
      {/* 整行可点:点进去看时间线。审批那两个键是各自的 Pressable,不会被这一层截走 */}
      <Pressable
        accessibilityRole="button"
        onPress={onOpen}
        style={({ pressed }) => [
          { flexDirection: "row", alignItems: "center", gap: space.sm },
          pressed && { opacity: 0.6 },
        ]}
      >
        <Tile><Dot tone={tone} /></Tile>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          {/* 标题是用户起的,长度没有上限:限一行,超了省略号收尾 */}
          <Headline lines={1}>{a.title ?? a.sessionId}</Headline>
          {/* 元信息一律等宽 + 暗:桌面那侧 `1 步 · 120 tokens` 就是这个样式 */}
          <Meta>
            {what}
            {a.phase === "active" && a.turnStartedAt ? ` · ${elapsed(a.turnStartedAt, now)}` : ""}
            {a.currentTool ? ` · ${a.currentTool.verb} ${a.currentTool.target}` : ""}
          </Meta>
        </View>
        {/* 可点的记号。没有它,一张卡片看不出能不能按 */}
        <Text style={{ ...t.title, color: c.mutedForeground, marginTop: -2 }}>›</Text>
      </Pressable>

      {/* 本轮改了多少 —— 桌面和对话视图消费同一份统计,两处只能显示同一个数 */}
      {d ? (
        <View style={{ flexDirection: "row", gap: space.sm, paddingLeft: 28 + space.sm }}>
          <Meta>{d.files} 文件</Meta>
          <Text style={{ ...t.footnote, color: c.ok, fontFamily: MONO }}>+{d.additions}</Text>
          <Text style={{ ...t.footnote, color: c.destructive, fontFamily: MONO }}>−{d.deletions}</Text>
        </View>
      ) : null}

      {a.pendingApproval ? <Approval agent={a} onDecide={onDecide} online={online} /> : null}
    </Card>
  );
}

