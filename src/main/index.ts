// 主进程 — Electron 接线层：开窗、IPC 应答、把 agent 的推送接到 webContents。
// agent 懒加载：用户选完工程文件夹（startSession）才组装，选之前 boot 返回 null。

import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import {
  CHANNELS,
  type BootInfo,
  type StartSessionOptions,
  type OutgoingAttachment,
  type PokerAction,
  type PokerTableInput,
  type BrowserBounds,
  type ApprovalDecisionOutcome,
} from "../shared/shellBridge.js";
import { createAgent, loadDotEnv, type AgentPush } from "./agent.js";
import { createTerminalHub } from "./terminalHub.js";
import { createBrowserHub } from "./browserHub.js";
import { createWebContentsViewHandle } from "./webContentsViewFactory.js";
import { EventStore } from "../session/store.js";
import { AttachmentStore, detectImageType } from "../session/attachments.js";
import type { UserAttachmentRef, UserTextFile } from "../session/events.js";
import { composeUserText } from "../session/deriveMessages.js";
import { intakeFile } from "./attachmentIntake.js";
import { createVisionBridge, VISION_BRIDGE_MODEL } from "./visionBridge.js";
import { classifySection } from "./sectionClassifier.js";
import { suggestFollowUps } from "./followUpSuggester.js";
import { loadKeys, saveKey, applyToEnv } from "./keyVault.js";
import { loadAlwaysAllow, addAlwaysAllow } from "./permissionStore.js";
import { scanSkills } from "./skills.js";
import { scanSubagents, writeSubagent } from "./subagents.js";
import { createSubagentRunner } from "./subagentRunner.js";
import { childAgentConfig, createChildAgent, type ChildAgentConfig } from "./resumeChild.js";
import type { BrowserReadOptions } from "../world/executionWorld.js";
import {
  DEFAULT_SUBAGENT_TOOLS,
  subagentNameError,
  type SubagentDef,
} from "../shared/subagent.js";
import { createProtocolService } from "./protocolService.js";
import { profileDirName } from "./profile.js";
import { createGitGraphService } from "./gitGraphService.js";
import { describeModel, OLLAMA_MODEL_PREFIX } from "../shared/modelCatalog.js";
import type { ThinkingMode } from "../shared/thinking.js";
import { probeOllamaModels, rememberOllamaModels } from "./ollamaModels.js";
import { clearBalanceCache, fetchProviderBalances } from "./providerBalance.js";
import { usageSnapshot } from "../shared/usageStats.js";
import { maskKey } from "../shared/keyMask.js";
import type { ModelLane } from "../shared/modelLane.js";
import { findProvider, providerKeyEnvs, type ProviderId } from "../shared/providerCatalog.js";
import type { ApprovalOutcome } from "../loop/approvalGate.js";
import type { AskUserOutcome } from "../shared/askUser.js";
import { AccountManager, createSupabaseAuthClient } from "./account.js";
import {
  createTable, joinTable, leaveTable, listTables, sendAction, startHand, watchTable,
} from "./pokerApi.js";
import { fetchWalletBalance } from "./walletApi.js";
import { createSend } from "./rendererPush.js";
import { FriendsManager } from "./friends.js";
import { createSupabaseFriendsApi } from "./supabaseFriendsApi.js";
import { UserProfileManager } from "./userProfile.js";
import { createSupabaseUserProfileApi } from "./supabaseUserProfileApi.js";
import {
  createNotifier, dmNotification, friendRequestNotification, inviteNotification,
  newIncomingInvites, newIncomingRequests,
} from "./friendNotifier.js";
import type { FriendsSnapshot, GameInvite } from "../shared/friends.js";
import type { ProfilePatch } from "../shared/profile.js";

// mrotto:// 深链：注册 + open-url 监听必须在 app ready 前完成——macOS 冷启动时
// 深链事件可能在 ready 之前就到达。AccountManager 要等 ready 后（依赖 app.getPath）
// 才能实例化，中间这段空档收到的 URL 先缓存，ready 后 flush。
app.setAsDefaultProtocolClient("mrotto");

// 品牌名 Mr Otto,但 userData 目录钉死在 mr-otto:Electron 的 userData 路径默认跟
// app.name 走,改名会把 keys.json/sessions.db/attachments 留在旧目录里"凭空消失"。
// 先 setName 再显式 setPath,老数据原地不动。
app.setName("Mr Otto");
// OTTO_PROFILE=b 换一个数据目录，用来在同一台机器上同时登两个账号（见 profile.ts）
app.setPath("userData", join(app.getPath("appData"), profileDirName(process.env)));

let accountManager: AccountManager | null = null;
let pendingAuthUrl: string | null = null;
let mainWindow: BrowserWindow | null = null;

// 深链回调成功后把主窗口拉回前台——用户在系统浏览器授权完，观感上是"跳回 App"。
// 窗口可能被 minimized，先 restore 再 show/focus；macOS 上 show/focus 不够抢焦点，
// 还得 app.focus({ steal: true })。失败路径不聚焦，维持 console.error 现状。
function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (accountManager) {
    accountManager
      .handleCallback(url)
      .then(() => focusMainWindow())
      .catch((err) => console.error("account.handleCallback 失败", err));
  } else {
    pendingAuthUrl = url;
  }
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Mr Otto",
    backgroundColor: "#121212",
    // macOS 隐藏原生标题栏那一行,红绿灯(hiddenInset)叠进内容左上角——
    // 与侧栏收起钮同一行(Claude 桌面端同款)。非 mac 平台保持默认标题栏
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
  return win;
}

void app.whenReady().then(() => {
  // dev 下菜单栏首项仍显示 "Electron"(来自 Electron 二进制的 Info.plist,运行时改不了,
  // 打包后自然是 Mr Otto);dock 图标和关于面板运行时可改,先把这两处品牌立起来
  if (process.platform === "darwin") {
    app.dock?.setIcon(join(app.getAppPath(), "resources/icon.png"));
  }
  app.setAboutPanelOptions({ applicationName: "Mr Otto", applicationVersion: app.getVersion() });

  loadDotEnv((p) => readFileSync(p, "utf8"), join(process.cwd(), ".env"));
  // 设置页存的 key 后加载 = 覆盖 .env（用户最新意志优先）
  const keyVaultPath = join(app.getPath("userData"), "keys.json");
  // 永久授权名单（ADR-0041）。和 keys.json 一样是 app 级、跨会话的东西,
  // 所以和它放在一起装配；每次现读文件 —— 名单被改了不用重启
  const permissionsPath = join(app.getPath("userData"), "permissions.json");
  applyToEnv(loadKeys(keyVaultPath), process.env);

  const win = createWindow();
  mainWindow = win;
  // 主进程里所有推给渲染层的消息都走这一个出口——窗口销毁后静默丢弃(issue #53)。
  // 别在别处直接 win.webContents.send：那正是这个 bug 上次只修了一半的原因
  const send = createSend(win);

  // 全屏状态推给渲染层:macOS 全屏隐红绿灯,左上角 logo 该让位/回来。
  // 变化走推送给已订阅的 renderer,首帧快照走 getWindowFullscreen(见下方 handle)
  win.on("enter-full-screen", () => send(CHANNELS.windowFullscreen, true));
  win.on("leave-full-screen", () => send(CHANNELS.windowFullscreen, false));

  // 固定接线形态（Task 6 裁定，见 account.ts 顶部注释）：openExternal 走系统浏览器，
  // onChange 推 accountChanged 事件，client 是真 supabase client（authStorage 落盘于 userData）
  const supabase = createSupabaseAuthClient(join(app.getPath("userData"), "auth.json"));
  // 系统通知:窗口没聚焦才发,点了就聚焦 + 告诉渲染层落到哪个面板(friendNotifier.ts)
  const notify = createNotifier({
    isFocused: () => !win.isDestroyed() && win.isFocused(),
    show: (spec, onClick) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: spec.title, body: spec.body });
      n.on("click", onClick);
      n.show();
    },
    activate: (target) => {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      send(CHANNELS.notificationActivated, target);
    },
  });
  // 好友请求/邀请是全量快照式推送,不做差集会把同一条反复弹成通知
  let lastSnapshot: FriendsSnapshot | null = null;
  let lastInvites: GameInvite[] | null = null;
  const friends = new FriendsManager({
    api: createSupabaseFriendsApi(supabase.raw),
    push: {
      // win 可能已被 Cmd+W 销毁而 app/presence 通道仍活着(mac 惯例),
      // 不查 isDestroyed 直接 send 会在 supabase-js websocket 回调里炸穿主进程
      friendsChanged: (s) => {
        for (const id of newIncomingRequests(lastSnapshot, s)) {
          const entry = s.incoming.find((e) => e.friendshipId === id);
          if (entry) notify(friendRequestNotification(entry.profile.name || entry.profile.email));
        }
        lastSnapshot = s;
        send(CHANNELS.friendsChanged, s);
      },
      presenceChanged: (ids) => send(CHANNELS.presenceChanged, ids),
      directMessage: (m) => {
        const sender = lastSnapshot?.friends.find((e) => e.profile.id === m.sender)?.profile;
        notify(dmNotification(sender?.name || sender?.email || "", m.body, m.sender));
        send(CHANNELS.directMessage, m);
      },
      invitesChanged: (invites) => {
        for (const invite of newIncomingInvites(lastInvites, invites)) {
          notify(inviteNotification(invite.peer.name || invite.peer.email, invite.tableName));
        }
        lastInvites = invites;
        send(CHANNELS.gameInvitesChanged, invites);
      },
      healthChanged: (health) => send(CHANNELS.realtimeHealth, health),
    },
  });
  // 本人资料(profiles 自己那一行)。和 friends 共用同一个 supabase client:
  // 同一登录态,别建第二个
  const userProfile = new UserProfileManager({ api: createSupabaseUserProfileApi(supabase.raw) });
  accountManager = new AccountManager({
    openExternal: (url) => shell.openExternal(url),
    onChange: (info) => {
      send(CHANNELS.accountChanged, info);
      // 好友子系统跟着登录态起落:登录起订阅,登出清场。start 内部自查 uid,
      // 不 await——推送式子系统,失败静默(下次 friendsList 调用还有机会报错)
      if (info.signedIn) void friends.start();
      else friends.stop();
      // 通知的去重基线跟着登录态清零(必须在 stop() 之后:它会同步推一份空快照,
      // 先清就又被填回去了)。留着上一个账号的基线,换号后第一份全量快照会被
      // 当成"全是新的",一屏历史请求当场弹成通知
      lastSnapshot = null;
      lastInvites = null;
    },
    client: supabase.auth,
  });
  const manager = accountManager;
  // otto-gateway 的进门凭据取用器。传给 createAgent 决定走网关还是直连,
  // 也给查余额用。token 只在主进程流转,永不过桥
  const getAccessToken = (): Promise<string | null> => manager.getAccessToken();
  // 深链回调 flush 和冷启动 restore 都不 await、都靠"最后写入者赢"改 manager 内部的
  // account——两条都跑的话，restore() 的 getUser() 若晚于 handleCallback() 的
  // exchangeCodeForSession 完成，刚建立的新登录会被 restore 带来的旧 session 投影覆盖，
  // 而且这是竞态、复现全靠时序，测不出来。裁定用互斥而不是加锁/时间戳：有待处理的深链
  // 就说明这次冷启动一定会经过 handleCallback 建立最新投影，restore 只会是多余的、
  // 反而可能后到覆盖它，所以直接不跑；没有待处理深链才需要 restore 兜底恢复旧 session。
  // 两条路径不再共存，竞态随互斥消失。
  //
  // 但互斥有个边界：handleCallback 可能失败（用户拒绝 consent 导致无 code、code 过期、
  // 网络错）或 no-op（parseAuthCallback 解不出 code），这两种情况都不会建立新登录态。
  // 这时如果彻底跳过 restore，一个已有有效落盘 session 的用户会在这次冷启动里显示未登录，
  // 直到下次重启才恢复——所以在 handleCallback 落定（then/catch 都跑完）之后兜底一次：
  // 只有 account 仍是未登录态（说明 handleCallback 没能建立登录）才补跑 restore。
  // 这个兜底 restore 在 handleCallback 的 promise 结束之后才发起，不再和它并发，
  // 因此不会重新引入上面那条"最后写入者赢"的竞态。
  if (pendingAuthUrl) {
    const url = pendingAuthUrl;
    pendingAuthUrl = null;
    manager
      .handleCallback(url)
      .then(() => focusMainWindow())
      .catch((err) => console.error("auth 深链回调失败:", err))
      .finally(() => {
        // 回调没建立登录态（失败或 no-op）时兜底恢复落盘 session
        if (!manager.getAccount().signedIn) {
          void manager.restore().catch((err) => console.error("恢复登录态失败:", err));
        }
      });
  } else {
    // 冷启动登录态恢复：authStorage 可能已经从 auth.json 恢复了 session，
    // 但 account 初始值恒为 EMPTY——不 restore 一次的话 UI 会一直显示未登录。
    // restore() 内部已经把 error/无 session 都静默处理，这里只兜底真正意外的 throw。
    void manager.restore().catch((err) => console.error("account.restore 失败", err));
  }

  const dbPath = join(app.getPath("userData"), "sessions.db");
  // store 是 app 级资源：欢迎页列会话时 agent 还不存在，库必须先开着
  const store = new EventStore(dbPath);
  // 图片附件库:EventStore 的邻居——日志存引用,bytes 在这(docs/adr/0009)
  const attachmentStore = new AttachmentStore(join(app.getPath("userData"), "attachments"));

  // agent 注册表：会话隔离的核心。切走不杀旧 agent——它的 turn 继续跑，
  // 事件带着自己的 sessionId 推给 UI，由渲染层按会话分流。
  const agents = new Map<string, ReturnType<typeof createAgent>>();
  const runningSessions = new Set<string>();
  let currentSessionId: string | null = null;

  // 分区分类的按会话串行队列。分类跑在 turn 锁之外（见 sendMessage 末尾），
  // 所以同一会话的两次分类会撞车：各自的 store.load 都看不到对方还没落的
  // section_classified，于是两个标题描述同一段、startSeq 却各开一处。
  // 链起来 = 同一会话永远只有一个分类在跑；跨度锚点本来就是自愈的
  // （最后一条分类事件之后的全部事件），后来的那次只是看到更宽的一段。
  // 代价：分类在飞的时候下一个 turn 可以开跑，分类#N+1 看到的跨度被分类#N 的事件
  // 切割得只剩 turn N+1 本身那几条、汇总后是空。分类不落事件，turn N+1 根本没被
  // 分类；若它开了新话题，章节标题要等 turn N+2 才出现，而且锚点是 N+2 不是 N+1——
  // 导航跳过去会落在话题开始之后。下一个 turn 的分类自动补上漏掉的那段（自愈）。
  // 这点代价换来的是输入框不被锁住，值。
  const sectionQueues = new Map<string, Promise<void>>();

  const classifyAndAppend = async (sessionId: string): Promise<void> => {
    const section = await classifySection(store.load(sessionId));
    if (!section) return;
    // 出了 turn 锁，delete-session 不再被挡住：这一跑期间会话可能已被 purge。
    // 往 purge 过的 sessionId 上 append 会凭空造出一条没有 session_created 的
    // 幽灵会话，而删除按 ADR-0002 是不可逆的物理抹除。agents 只在 purge 时删条目，
    // 所以它在不在就是会话还活不活着
    if (!agents.has(sessionId)) return;
    const sectionEvent = store.append({
      sessionId, ts: Date.now(), type: "section_classified",
      title: section.title, model: section.model,
      ...(section.usage ? { usage: section.usage } : {}),
    });
    send(CHANNELS.event, sectionEvent);
  };

  // 跟进建议:和分区分类完全同构的第二条外挂 —— 同一个位置(turn 锁之外)、
  // 同一种自我保护(永不抛/会话被 purge 就不落)。**没有**串行队列:
  // 分类必须串行是因为它的锚点是"最后一条分类事件之后的跨度",两个在飞的分类
  // 会各开一个分区;建议没有锚点,每次只看最后一轮问答,后落盘的那条天然覆盖
  // 前一条(渲染只取最后一条)——撞车的代价就是多烧一次便宜调用
  const suggestAndAppend = async (sessionId: string): Promise<void> => {
    const result = await suggestFollowUps(store.load(sessionId));
    if (!result) return;
    // 同 classifyAndAppend:出了 turn 锁,这一跑期间会话可能已被 purge。
    // 往 purge 过的 sessionId 上 append 会凭空造出一条幽灵会话
    if (!agents.has(sessionId)) return;
    const event = store.append({
      sessionId, ts: Date.now(), type: "suggestions_generated",
      suggestions: result.suggestions, model: result.model,
      ...(result.usage ? { usage: result.usage } : {}),
    });
    send(CHANNELS.event, event);
  };

  const enqueueSectionClassify = (sessionId: string): void => {
    const prev = sectionQueues.get(sessionId) ?? Promise.resolve();
    // catch 挂在链上：classifySection 自己不抛，但它外面的 store.append / send 会。
    // 一环炸了不能毒死后面的环，也不能变成 unhandledRejection 把主进程带走
    const next = prev
      .then(() => classifyAndAppend(sessionId))
      .catch((err) => console.error("分区分类失败", err));
    sectionQueues.set(sessionId, next);
    // 排空即删，别让 Map 随会话数无限长。只有自己仍是队尾才删——
    // 期间又排进来一个的话队尾已经换人，删了会让它从空链起跑（等于解掉串行）
    void next.then(() => {
      if (sectionQueues.get(sessionId) === next) sectionQueues.delete(sessionId);
    });
  };

  // 终端注册表:app 级资源。openTerminal 走该会话 agent 的 ExecutionWorld,
  // 不是这里另起一个 LocalWorld——否则 v2 SandboxWorld 接进来之后,agent 明明
  // 看得见容器里的文件系统,用户终端却还开在宿主机上,ADR-0031 §1 挡的就是这个
  // (曾经的接线绕开了 seam:见该 ADR 的 review 记录)。workspace 参数留着不是
  // 白留——world 早已经绑好 root,这里只需要 sessionId 去 agents 里找到那个 world
  const terminals = createTerminalHub({
    openTerminal: async (sessionId, _workspace, opts) => {
      const agent = agents.get(sessionId);
      if (!agent?.world.openTerminal) {
        throw new Error("这个会话的 world 不支持终端能力");
      }
      return agent.world.openTerminal(opts);
    },
    push: {
      data: (id, data) => send(CHANNELS.terminalData, { id, data }),
      exit: (id, exitCode) => send(CHANNELS.terminalExit, { id, exitCode }),
    },
  });

  // 浏览器注册表:app 级资源,一个会话一个。
  // 与终端的接线方向相反——终端是 hub 去调 agent.world.openTerminal(pty 是
  // LocalWorld 自己能干的活),浏览器是 hub 造好能力反过来注入进 world:
  // WebContentsView 只有主进程 + 窗口造得出来,LocalWorld 是纯 Node 模块,造不出来。
  // seam 仍然成立:工具只认 world.browser,不知道 hub 的存在(ADR-0035)。
  const browsers = createBrowserHub({
    createView: () => {
      if (!mainWindow) throw new Error("窗口还没建好，开不了浏览器");
      return createWebContentsViewHandle(mainWindow, "persist:otto-browser");
    },
    push: { state: (info) => send(CHANNELS.browserState, info) },
  });

  const bootInfo = (): BootInfo | null => {
    const agent = currentSessionId ? agents.get(currentSessionId) : undefined;
    return agent
      ? {
          sessionId: agent.sessionId,
          model: agent.model,
          workspace: agent.workspace,
          events: store.load(agent.sessionId),
          dbPath,
          approvalMode: agent.approvalMode,
          thinking: agent.thinking,
          toolDefs: agent.toolDefs,
        }
      : null;
  };

  // 所有 agent 共用同一份推送接线；靠消息里的 sessionId 区分来源
  const push: AgentPush = {
    event: (e) => send(CHANNELS.event, e),
    approvalRequest: (sessionId, call, tool, preview, fromAgent) =>
      send(CHANNELS.approvalRequest, {
        sessionId,
        call,
        toolDescription: tool.def.description,
        ...(preview ? { preview } : {}),
        ...(fromAgent ? { fromAgent } : {}),
      }),
    askUserRequest: (sessionId, toolCallId, questions) =>
      send(CHANNELS.askUserRequest, { sessionId, toolCallId, questions }),
    assistantDelta: (sessionId, text, kind) =>
      send(CHANNELS.assistantDelta, { sessionId, text, kind }),
    toolOutput: (sessionId, toolCallId, chunk, stream) =>
      send(CHANNELS.toolOutput, { sessionId, toolCallId, chunk, stream }),
  };

  // subagent 根目录：otter 原生排前（同名覆盖优先），其后兼容 Claude Code 的安装位。
  // readOnly 标着的那份不写回——不去改用户 Claude Code 的配置
  const subagentRoots = [
    { root: join(homedir(), ".otter", "agents"), readOnly: false },
    { root: join(homedir(), ".claude", "agents"), readOnly: true },
  ];
  // 一次性探针：只为拿到"本装配有哪些工具"这份名单。用后即弃（它的 session
  // 落在库里是一条只有 session_created 的空会话——所以刻意用内存库）。
  // makeBrowser 给个桩：不给的话 world.browser 是 undefined，browser_read 不会
  // 挂上，探针报的工具表就漏了这一把——手写常量正是为了躲开这种"和真实工具表
  // 对不上"，桩子撒谎是同一个坑换个地方摔
  //
  // 这一步跑在第一个 ipcMain.handle 注册之前（见下面 CHANNELS.boot）：这里抛错会
  // 让整条 whenReady 链断掉，一个 IPC 通道都注册不上，白屏且没有报错入口——
  // 比"某次调用失败"重得多，所以必须兜底。退化成 [] 的代价：已知工具名表是空的，
  // 于是 subagent 定义里写的每一个工具名都会被判成"不认识"（scanSubagents 的
  // unknownTools 分支），所有 subagent 静默退回默认工具集，直到重启恢复
  let TOOL_NAMES: string[];
  try {
    TOOL_NAMES = createAgent({
      store: new EventStore(":memory:"),
      workspace: app.getPath("userData"),
      push: {
        event: () => {},
        approvalRequest: () => {},
        askUserRequest: () => {},
        assistantDelta: () => {},
        toolOutput: () => {},
      },
      attachments: attachmentStore,
      makeBrowser: () => ({ read: () => Promise.reject(new Error("probe")) }),
    }).toolDefs.map((d) => d.name);
  } catch {
    TOOL_NAMES = [];
  }
  const listSubagents = () => scanSubagents(subagentRoots, TOOL_NAMES);

  /**
   * 会话装配的唯一入口：新建（startSession）和恢复（resumeSession）走同一份代码。
   *
   * 曾经这十几行在两处各抄一份，于是它们 drift 了：Task 5 给子 agent 定的那套
   * 收权（工具白名单 / approval:"deny" 换掉整条审批链 / **不给 subagentRunner**）
   * 只写在 subagentRunner.ts 那一份装配里，resumeSession 那一份压根不知道
   * "会话还可能是子会话"这回事——于是恢复一个只读搜索员，回来的是带 bash、
   * write_file 和 task 工具的全权 agent（review I1）。而恢复正是查看子会话的
   * 唯一途径（时间线上那张卡、"回到父会话"都走 resume）。
   *
   * 合成一处之后，"这个会话是不是子会话"只有一个地方判断，drift 无处可藏。
   */
  const createSessionAgent = (args: {
    workspace: string;
    /** 给了 = 恢复既有会话 */
    resumeSessionId?: string;
    /** 恢复的是一个子会话（日志第 0 条带 spawnedBy）时给它当初那副装备 */
    child?: ChildAgentConfig;
  }): ReturnType<typeof createAgent> => {
    const base = {
      store,
      workspace: args.workspace,
      push,
      attachments: attachmentStore,
      getAccessToken,
      makeBrowser: (sid: string) => ({
        read: (o?: BrowserReadOptions) => browsers.read(sid, o),
      }),
      ...(args.resumeSessionId ? { resumeSessionId: args.resumeSessionId } : {}),
    };
    if (args.child && args.resumeSessionId) {
      // 子会话重建走 createChildAgent：它的签名里没有 subagentRunner 这一项，
      // 于是"重建出来的子 agent 没有 task 工具"是类型层面的事实，不是纪律
      // （world 是新造的 LocalWorld——父 agent 可能早已不在内存里了；
      // 围栏一样是日志第 0 条记的那个 workspace）
      return createChildAgent({
        ...base,
        resumeSessionId: args.resumeSessionId,
        config: args.child,
        alwaysAllow: () => loadAlwaysAllow(permissionsPath),
      });
    }
    // 主会话：能派活。parent() 要拿到"正在构造的这个 agent"，而 createAgent
    // 还没返回——先声明后赋值：parent() 只在派活那一刻被调用（远在这行之后）。
    // 这里不能改成先起个快照，快照会把后续 switchModel 等运行时变化锁死在
    // 创建那一刻的值上
    let self: ReturnType<typeof createAgent>;
    self = createAgent({
      ...base,
      alwaysAllow: () => loadAlwaysAllow(permissionsPath),
      persistAlwaysAllow: (tool) => void addAlwaysAllow(permissionsPath, tool),
      listSubagents,
      subagentRunner: createSubagentRunner({
        store,
        attachments: attachmentStore,
        push,
        list: listSubagents,
        parent: () => ({
          sessionId: self.sessionId,
          workspace: self.workspace,
          world: self.world,
          model: self.model,
        }),
        getAccessToken,
        alwaysAllow: () => loadAlwaysAllow(permissionsPath),
        // 子 agent 也进注册表：它的 sessionId 从建好那一刻起就是活的，
        // resumeSession 必须查得到它、只切视线而不是另建一个 agent（review C1）
        register: (child) => void agents.set(child.sessionId, child),
      }),
    });
    return self;
  };

  ipcMain.handle(CHANNELS.boot, () => bootInfo());

  ipcMain.handle(CHANNELS.getWindowFullscreen, () => win.isFullScreen());

  ipcMain.handle(CHANNELS.listSessions, () => store.sessions());

  // 只读地取一个会话的全部事件，不建 agent、不切视图（resumeSession 那一套围栏
  // 重建在这里都不需要）——时间线上的 subagent 卡问一眼子会话的事实(步数/token)
  // 用的是这个通道，不是 resumeSession。
  // 收窄成"只能读子会话"（Task 8 review Important 3）：目标必须带 spawnedBy，
  // 且指回当前正看着的会话——不然这就是一个凭 sessionId 就能读任意会话全文的
  // 静默通道：resumeSession 好歹会切视图，是"看得见"的；这个不会，读了不留痕迹。
  // currentSessionId 是渲染层此刻唯一正当的"我在哪"
  ipcMain.handle(CHANNELS.readSessionEvents, (_e, sessionId: string) => {
    const events = store.load(sessionId);
    const first = events[0];
    if (
      !first ||
      first.type !== "session_created" ||
      !first.spawnedBy ||
      first.spawnedBy.sessionId !== currentSessionId
    ) {
      throw new Error("只能读取当前会话派出的子会话");
    }
    return events;
  });

  // 选文件夹和建会话拆开：新会话 composer 里用户先配齐（文件夹/模型/模式/thinking）
  // 再一次性落地，中途反悔不留任何痕迹——没建的会话不该存在半个
  ipcMain.handle(CHANNELS.pickWorkspace, async (): Promise<string | null> => {
    const picked = await dialog.showOpenDialog(win, {
      title: "选择工程文件夹",
      buttonLabel: "用这个文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  });

  ipcMain.handle(CHANNELS.startSession, (_e, opts: StartSessionOptions): BootInfo => {
    if (typeof opts?.workspace !== "string" || !opts.workspace) {
      throw new Error("未选择工程文件夹");
    }
    const agent = createSessionAgent({ workspace: opts.workspace });
    agents.set(agent.sessionId, agent);
    currentSessionId = agent.sessionId;
    // 开局偏好复用运行时切换的既有通道：model 落 model_changed（resume 记得，
    // 与默认相同时 switchModel 内部 no-op，零多余事件）；审批/thinking 是运行时偏好
    if (opts.model) agent.switchModel(opts.model, opts.lane ?? "auto");
    if (opts.approvalMode === "ask" || opts.approvalMode === "auto") {
      agent.setApprovalMode(opts.approvalMode);
    }
    if (opts.thinking && opts.thinking !== agent.thinking) agent.setThinking(opts.thinking);
    const info = bootInfo();
    if (!info) throw new Error("创建会话失败"); // 理论不可达，让 TS 安心
    return info;
  });

  ipcMain.handle(CHANNELS.resumeSession, (_e, sessionId: string): BootInfo => {
    // 已在注册表里（包括正在跑 turn 的）→ 只是把视线切过去，agent 原样活着
    if (!agents.has(sessionId)) {
      // 恢复 = 重新投影：workspace 从日志第 0 条读回来，
      // 围栏（LocalWorld root）和 system 消息（deriveMessages）随之自动重建。
      const events = store.load(sessionId);
      const first = events[0];
      if (!first || first.type !== "session_created" || !first.workspace) {
        throw new Error(`会话 ${sessionId} 没有记录工程文件夹，无法恢复`);
      }
      // C1 的第二道门：父 turn 还跑着的时候，它派出去的子会话一定是活的
      // （runner 正在跑它）。此刻它不在注册表里就说明登记那一环漏了——
      // 绝不能顺手再建一个 agent 顶上：第二个 agent 的崩溃修复会给还在飞的
      // 工具调用补一条"app 在执行中退出"的假结果，紧接着真结果也落盘，
      // 同一个 toolCallId 两条 tool_result，这个会话从此永久 400。
      // 重启后的真崩溃修复不受影响：那时 runningSessions 是空的
      if (first.spawnedBy && runningSessions.has(first.spawnedBy.sessionId)) {
        throw new Error("这个子会话正在跑，稍等一下再看");
      }
      // 是子会话就按它当初那副装备重建（工具白名单 / 审批链 / 没有 task）
      const child = childAgentConfig(events, listSubagents());
      agents.set(
        sessionId,
        createSessionAgent({
          workspace: first.workspace,
          resumeSessionId: sessionId,
          ...(child ? { child } : {}),
        })
      );
    }
    currentSessionId = sessionId;
    const info = bootInfo();
    if (!info) throw new Error("恢复会话失败"); // 理论不可达，让 TS 安心
    return info;
  });

  // skill 根目录：otter 原生排前（同名覆盖优先），其后兼容 Claude Code 的安装位
  const skillRoots = [join(homedir(), ".otter", "skills"), join(homedir(), ".claude", "skills")];

  ipcMain.handle(CHANNELS.listSkills, () => scanSkills(skillRoots));

  ipcMain.handle(CHANNELS.listSubagents, () => listSubagents());

  ipcMain.handle(CHANNELS.saveSubagent, (_e, def: SubagentDef) => {
    // def.path / def.readOnly 是渲染层传来的,不可信——一个 readOnly:false 配任意
    // path 就能让这个 handler 写任意文件。落地地址必须从信任侧(现扫一遍磁盘的清单)
    // 按名字查出来,渲染层的 def 只当"要存的内容"用,不当"写去哪"用
    // (同 protocolService.readAdr 的路径越界防法,ADR 路径钉死在白名单目录内那条)
    const found = listSubagents().find((d) => d.name === def.name);
    if (!found) throw new Error(`没有名叫「${def.name}」的 subagent`);
    if (found.readOnly) throw new Error(`${found.name} 是只读的（来自 ${found.source}），不能保存`);
    // writeSubagent 内部的 readOnly 检查留着当第二道防线(defense in depth)——
    // 这里已经挡过一次,但两处独立判断比互相信任更皮实
    writeSubagent({ ...def, path: found.path, source: found.source, readOnly: found.readOnly });
    return listSubagents();
  });

  ipcMain.handle(CHANNELS.createSubagent, (_e, name: string) => {
    const clean = name.trim();
    // 校验必须在 IPC 边界之内：渲染层那道同款检查只是"别让请求白跑一趟"，
    // 挡不住任何东西——这个 handler 的活儿就是往磁盘写文件（同 saveSubagent
    // 收权的理由：渲染层传来的，不可信）。
    // 而且是**拒绝**不是改写：以前把非法字符换成 "-"，"搜索员" 会塌成 "---"，
    // 非空、通过、建出一个名叫 --- 的 subagent —— 用户看不出自己建了什么，
    // 模型也永远打不出他心里那个名字
    const nameError = subagentNameError(clean);
    if (nameError) throw new Error(nameError);
    // 建之前先查重:用户输入一个已存在的名字往往就是想看看这个名字有没有被占——
    // 不查重会直接截断写空,把已有的 description/instructions/tools 全冲掉,
    // 没有确认也没有撤回
    if (listSubagents().some((d) => d.name === clean)) {
      throw new Error(`已经有一个叫「${clean}」的 subagent 了，换个名字`);
    }
    const root = subagentRoots[0]!.root;
    writeSubagent({
      name: clean,
      description: "",
      instructions: "",
      tools: [...DEFAULT_SUBAGENT_TOOLS],
      unknownTools: [],
      approval: "deny",
      path: join(root, `${clean}.md`),
      source: root,
      readOnly: false,
    });
    return listSubagents();
  });

  // Protocol 仪表盘(只读):service 无状态,建一次全局复用
  const protocol = createProtocolService();
  ipcMain.handle(CHANNELS.protocolListAdrs, (_e, repoDir: string) => protocol.listAdrs(repoDir));
  ipcMain.handle(CHANNELS.protocolReadAdr, (_e, repoDir: string, relPath: string) =>
    protocol.readAdr(repoDir, relPath)
  );
  ipcMain.handle(CHANNELS.protocolListIssues, (_e, repoDir: string) => protocol.listIssues(repoDir));
  ipcMain.handle(CHANNELS.protocolGetIssue, (_e, repoDir: string, n: number) => protocol.getIssue(repoDir, n));

  // Git Graph(只读):service 无状态,建一次全局复用
  const gitGraph = createGitGraphService();
  ipcMain.handle(CHANNELS.gitGraphLog, (_e, repoDir: string, limit?: number) => gitGraph.log(repoDir, limit));
  ipcMain.handle(CHANNELS.gitBranches, (_e, repoDir: string) => gitGraph.branches(repoDir));
  ipcMain.handle(CHANNELS.gitStatus, (_e, repoDir: string) => gitGraph.status(repoDir));
  ipcMain.handle(CHANNELS.gitCheckout, (_e, repoDir: string, branch: string) =>
    gitGraph.checkout(repoDir, branch)
  );
  ipcMain.handle(CHANNELS.gitGraphCommit, (_e, repoDir: string, hash: string) =>
    gitGraph.commit(repoDir, hash)
  );

  // ── 终端 ────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.terminalList, (_e, sessionId: string) => terminals.list(sessionId));

  ipcMain.handle(CHANNELS.terminalOpen, (_e, sessionId: string, cols: number, rows: number) => {
    const agent = agents.get(sessionId);
    if (!agent) throw new Error("会话不存在，开不了终端");
    // cwd 取会话的工程文件夹:终端是"这个会话的终端",不是随便一个 shell
    return terminals.open(sessionId, agent.workspace, cols, rows);
  });

  ipcMain.handle(CHANNELS.terminalAttach, (_e, id: string) => terminals.attach(id));
  ipcMain.handle(CHANNELS.terminalInput, (_e, id: string, data: string) => terminals.input(id, data));
  ipcMain.handle(CHANNELS.terminalResize, (_e, id: string, cols: number, rows: number) =>
    terminals.resize(id, cols, rows)
  );
  ipcMain.handle(CHANNELS.terminalClose, (_e, id: string) => terminals.close(id));

  // ── 浏览器 ──────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.browserOpen, (_e, sessionId: string) => browsers.open(sessionId));
  ipcMain.handle(CHANNELS.browserNavigate, (_e, sessionId: string, url: string) =>
    browsers.navigate(sessionId, url)
  );
  ipcMain.handle(CHANNELS.browserSetBounds, (_e, sessionId: string, bounds: BrowserBounds | null) =>
    browsers.setBounds(sessionId, bounds)
  );
  ipcMain.handle(CHANNELS.browserBack, (_e, sessionId: string) => browsers.back(sessionId));
  ipcMain.handle(CHANNELS.browserForward, (_e, sessionId: string) => browsers.forward(sessionId));
  ipcMain.handle(CHANNELS.browserReload, (_e, sessionId: string) => browsers.reload(sessionId));
  ipcMain.handle(CHANNELS.browserClose, (_e, sessionId: string) => browsers.close(sessionId));

  // 安全硬约束：只回 AccountInfo 四字段，token/session 对象永不过 IPC
  ipcMain.handle(CHANNELS.getAccount, () => manager.getAccount());
  ipcMain.handle(CHANNELS.walletBalance, () => fetchWalletBalance(getAccessToken));

  // 设置页的用量图：SQL 只捞窗口内的计费行，投影成"每家每天多少 token"再过桥。
  // 两倍窗口是为了那个涨跌对比（前一个同长度窗口的合计），投影函数自己会切
  ipcMain.handle(CHANNELS.usageByProvider, (_e, days: number) => {
    const span = Math.max(1, Math.floor(days));
    const now = Date.now();
    const since = now - span * 2 * 86_400_000;
    return usageSnapshot(store.billedUsage(since), { now, days: span });
  });
  // 余额：key 在主进程 env 里，问的是签出这把 key 的那家自己（见 providerBalance.ts）
  ipcMain.handle(CHANNELS.providerBalances, () => fetchProviderBalances());

  // ── 牌桌 ────────────────────────────────────────────────────────
  // 同一时刻只订一张桌：换桌先退订。两条流同时推会互相盖着，
  // 而"盖着"在牌桌上意味着看到的是上一张桌的底牌
  let unwatchPoker: (() => void) | null = null;
  ipcMain.handle(CHANNELS.pokerTables, () => listTables(getAccessToken));
  ipcMain.handle(CHANNELS.pokerCreateTable, (_e, input: PokerTableInput) =>
    createTable(getAccessToken, input)
  );
  ipcMain.handle(CHANNELS.pokerJoin, (_e, tableId: string, amount: number) =>
    joinTable(getAccessToken, tableId, amount)
  );
  ipcMain.handle(CHANNELS.pokerLeave, (_e, tableId: string) =>
    leaveTable(getAccessToken, tableId)
  );
  ipcMain.handle(CHANNELS.pokerStart, (_e, tableId: string) =>
    startHand(getAccessToken, tableId)
  );
  ipcMain.handle(CHANNELS.pokerAct, (_e, tableId: string, action: PokerAction) =>
    sendAction(getAccessToken, tableId, action)
  );
  ipcMain.handle(CHANNELS.pokerWatch, (_e, tableId: string | null) => {
    unwatchPoker?.();
    unwatchPoker = null;
    if (!tableId) {
      send(CHANNELS.pokerHand, null);
      return;
    }
    unwatchPoker = watchTable(
      getAccessToken,
      tableId,
      (view) => send(CHANNELS.pokerHand, view),
      (err) => send(CHANNELS.pokerError, err instanceof Error ? err.message : String(err))
    );
  });
  // signIn/handleCallback 失败会 throw——这里不吞，让 invoke 自然 reject（渲染层 Task 7 接）
  ipcMain.handle(CHANNELS.signIn, (_e, provider: "google" | "github") => manager.signIn(provider));
  ipcMain.handle(CHANNELS.signOut, () => manager.signOut());

  // 本人资料:读/写 profiles 自己那一行。结构化回流(ProfileResult),不靠 invoke reject
  // 没有对应的推送频道:profiles 只被用户自己在这台机器上改,主进程不会背着渲染层
  // 动它。回值即新状态,渲染层照着 set 就行(登录时由 onAccountChanged 触发补拉)
  ipcMain.handle(CHANNELS.myProfile, () => userProfile.load());
  ipcMain.handle(CHANNELS.updateProfile, (_e, patch: ProfilePatch) => userProfile.save(patch));

  // 好友系统:全部结构化回流(FriendsResult),渲染层按 ok 分支,不靠 invoke reject
  ipcMain.handle(CHANNELS.friendsSearch, (_e, email: string) => friends.search(email));
  ipcMain.handle(CHANNELS.friendsSendRequest, (_e, userId: string) => friends.sendRequest(userId));
  ipcMain.handle(CHANNELS.friendsRespond, (_e, id: string, accept: boolean) => friends.respond(id, accept));
  ipcMain.handle(CHANNELS.friendsRemove, (_e, id: string) => friends.remove(id));
  ipcMain.handle(CHANNELS.friendsList, () => friends.list());
  ipcMain.handle(CHANNELS.friendsSendMessage, (_e, friendId: string, body: string) =>
    friends.sendMessage(friendId, body));
  ipcMain.handle(CHANNELS.friendsListMessages, (_e, friendId: string, beforeId?: number) =>
    friends.listMessages(friendId, beforeId));
  ipcMain.handle(CHANNELS.friendsSendInvite, (_e, friendId: string, tableId: string, tableName: string) =>
    friends.sendInvite(friendId, tableId, tableName));
  ipcMain.handle(CHANNELS.friendsRespondInvite, (_e, inviteId: string, accept: boolean) =>
    friends.respondInvite(inviteId, accept));
  ipcMain.handle(CHANNELS.friendsCancelInvite, (_e, inviteId: string) => friends.cancelInvite(inviteId));
  ipcMain.handle(CHANNELS.friendsListInvites, () => friends.listInvites());
  // dock 角标:未读数只有渲染层算得出(它知道哪个面板开着),主进程只负责画。
  // 非 mac 平台没有 dock,setBadgeCount 在那边是 no-op,不用分支
  ipcMain.handle(CHANNELS.setBadgeCount, (_e, count: number) => {
    app.setBadgeCount(Math.max(0, Math.floor(count)));
  });

  // 白名单：渲染层只能配厂商目录里声明过的 key 变量，不然被攻破的渲染进程能改任意 env。
  // 按厂商算而不是按型号算——一家厂暂时 0 个型号时，它的 key 也该能先填上
  const allowedKeyEnvs = new Set(providerKeyEnvs());

  ipcMain.handle(CHANNELS.keyStatus, (): Record<string, string> => {
    const status: Record<string, string> = {};
    // 遮罩在这一侧算完再过桥：过去的是一个推不回原文的派生物（前 8 + 五颗星 + 后 4），
    // key 本体永远不过这座桥。空串 = 没配（"配没配"照旧靠真假值判断）
    for (const env of allowedKeyEnvs) status[env] = maskKey(process.env[env] ?? "");
    return status;
  });

  // 领 key 的入口。只认目录里的厂商 id，URL 从目录里查——渲染层递不进来任意外链
  ipcMain.handle(CHANNELS.openProviderConsole, (_e, providerId: string) => {
    const info = findProvider(providerId as ProviderId);
    if (!info) throw new Error(`不认识的厂商: ${providerId}`);
    void shell.openExternal(info.consoleUrl);
  });

  // 本机 Ollama：型号清单 + 各自能力（探测逻辑住 main/ollamaModels.ts，这里只接线）
  ipcMain.handle(CHANNELS.listOllamaModels, async () => {
    const info = findProvider("ollama")!;
    const cap = Number(process.env["OLLAMA_CONTEXT_LENGTH"]);
    const result = await probeOllamaModels({
      defaultBaseUrl: info.baseUrl,
      baseUrlOverride: process.env[info.baseUrlEnv],
      // Ollama 自己的开关。用户改过它就该生效，不该逼他再学一个我们发明的变量
      ollamaHost: process.env["OLLAMA_HOST"],
      apiKey: process.env[info.apiKeyEnv],
      prefix: OLLAMA_MODEL_PREFIX,
      ...(Number.isFinite(cap) && cap > 0 ? { contextCap: cap } : {}),
      fetchImpl: fetch,
    });
    // 探到的端点固化进 env：adapter 和 routeModel 读的都是这个变量，
    // 不固化的话它们会继续拨目录里的默认值，而清单是从另一个地址问来的——
    // "看得见却连不上"正是这类分叉的典型症状。keyVault 也是这么把 key 落进 env 的
    if (result.baseUrl && !process.env[info.baseUrlEnv]) {
      process.env[info.baseUrlEnv] = result.baseUrl;
    }
    // agent 要按型号决定发不发图，能力表只有探测知道
    rememberOllamaModels(result.models);
    for (const a of agents.values()) a.reloadAdapter();
    return result;
  });

  ipcMain.handle(CHANNELS.setApiKey, (_e, envName: string, key: string) => {
    if (!allowedKeyEnvs.has(envName)) throw new Error(`不认识的 key 变量: ${envName}`);
    applyToEnv(saveKey(keyVaultPath, envName, key), process.env);
    if (!key) delete process.env[envName]; // 清除时 applyToEnv 不会删，补一刀
    clearBalanceCache(); // 换了 key,60 秒缓存里那条余额说的是上一把 key 的账
    for (const a of agents.values()) a.reloadAdapter(); // 所有活 agent 的 adapter 都捏着旧 key
  });

  ipcMain.handle(CHANNELS.deleteSession, (_e, sessionId: string) => {
    if (runningSessions.has(sessionId)) throw new Error("turn 进行中不能删除会话");
    // 删除 = 整会话物理抹除（ADR-0002）。用户点删就是要它从库里消失，不可逆。
    // purge 会连它派出去的子会话一起抹（否则子会话成孤儿：够不着、删不掉、
    // 账还在算），返回真正被抹掉的那几个 id——活资源按同一份名单注销
    for (const id of store.purge(sessionId)) {
      terminals.killSession(id); // 会话没了,它名下的终端也不该继续跑
      browsers.close(id); // 会话没了,它的浏览器也该没
      agents.delete(id); // 注册表里的活 agent 一并注销（空闲状态，无挂起可丢）
    }
    if (currentSessionId === sessionId) currentSessionId = null; // 渲染层据此回欢迎页
  });

  ipcMain.handle(CHANNELS.renameSession, (_e, sessionId: string, title: string) => {
    const t = title.trim();
    if (!t) throw new Error("标题不能为空（用法：/rename 新标题）");
    if (store.load(sessionId).length === 0) throw new Error("会话不存在"); // 别给幽灵会话开日志
    // 改名不碰 agent、不限 turn 状态：纯追加一条事件，投影层自然换标题
    const appended = store.append({ sessionId, ts: Date.now(), type: "session_renamed", title: t });
    send(CHANNELS.event, appended); // 时间线同款直播通道
  });

  ipcMain.handle(CHANNELS.switchModel, (_e, model: string, lane?: ModelLane) => {
    const agent = currentSessionId ? agents.get(currentSessionId) : undefined;
    if (!agent) throw new Error("还没有会话");
    if (runningSessions.has(agent.sessionId)) throw new Error("turn 进行中不能换模型");
    agent.switchModel(model, lane ?? "auto");
    // 换完之后 thinking 落在哪一档由主进程说了算（新型号的挡位表未必装得下旧档）
    return agent.thinking;
  });

  ipcMain.handle(CHANNELS.setApprovalMode, (_e, sessionId: string, mode: "ask" | "auto") => {
    const agent = agents.get(sessionId);
    if (!agent) throw new Error("会话不存在或未激活");
    // turn 进行中也允许：auto 切 ask 是"踩刹车"，必须随时可踩
    agent.setApprovalMode(mode);
  });

  ipcMain.handle(CHANNELS.setThinking, (_e, sessionId: string, mode: ThinkingMode) => {
    const agent = agents.get(sessionId);
    if (!agent) throw new Error("会话不存在或未激活");
    if (runningSessions.has(sessionId)) throw new Error("turn 进行中不能切 thinking");
    agent.setThinking(mode);
    return agent.thinking; // 钳位后的实际档
  });

  ipcMain.handle(
    CHANNELS.sendMessage,
    async (_e, sessionId: string, text: string, skill?: string, attachments?: OutgoingAttachment[]) => {
      const agent = agents.get(sessionId);
      if (!agent) throw new Error("会话不存在或未激活");
      if (runningSessions.has(sessionId)) throw new Error("该会话上一个 turn 还在跑");
      // skill 先解析再落盘：发送时刻现读 SKILL.md 做快照（不是列表页那份陈旧拷贝）。
      // 找不到就整条拒发——不静默降级成"没有 skill 的普通消息"
      let invoked: { name: string; content: string } | null = null;
      if (skill) {
        const found = scanSkills(skillRoots).find((s) => s.name === skill);
        if (!found) throw new Error(`skill 不存在: ${skill}`);
        invoked = { name: found.name, content: found.content };
      }
      // 文本文件结构化存进事件 textFiles(快照语义,同 skill_invoked:日志自
      // 包含,原文件后续改/删不影响重放)——不内联进 content,UI 才能渲染成
      // 文件卡片而不是摊开全文;模型投影时由 composeUserText 拼全文。图片只走 ref
      const textFiles: UserTextFile[] = [];
      const refs: UserAttachmentRef[] = [];
      // 渲染层送来的 OutgoingAttachment 是不可信输入——形状必须在这把关。
      // 坏形状（undefined/缺 id/id 非法）一旦被 push 进 refs，会原样存进
      // append-only 的 user_message 事件；日志落了错的东西改不了、也不能删，
      // deriveMessages 重放到这条时对 a.id 取值直接抛错，整个会话从此永久
      // 不可重放（违反"旧日志必须永远可重放"硬规则）。所以宁可整条 send 拒发，
      // 也不能让半吊子附件混进日志——拒绝发生在 runningSessions.add / 任何
      // append 之前，坏请求不会留下任何痕迹。
      for (const a of attachments ?? []) {
        if (a.kind === "text") {
          if (typeof a.name !== "string" || typeof a.content !== "string") {
            throw new Error("附件形状非法(渲染层送来的 OutgoingAttachment 不合规)");
          }
          textFiles.push({
            name: a.name,
            content: a.content,
            bytes: Buffer.byteLength(a.content, "utf8"),
          });
        } else if (
          a.kind === "image" &&
          a.ref &&
          typeof a.ref.id === "string" &&
          /^sha256:[a-f0-9]{64}$/.test(a.ref.id)
        ) {
          refs.push(a.ref);
        } else {
          throw new Error("附件形状非法(渲染层送来的 OutgoingAttachment 不合规)");
        }
      }
      runningSessions.add(sessionId);
      send(CHANNELS.turnStatus, { sessionId, status: "running" });
      try {
        if (invoked) {
          // 快照落在 user_message 之前：模型先看到说明书，再看到任务
          const fullEvent = store.append({ sessionId, ts: Date.now(), type: "skill_invoked", ...invoked });
          send(CHANNELS.event, fullEvent);
        }
        // vision-bridge：当前模型没眼睛而消息带图 → 先请视觉款代读成文字。
        // 解析出自模型且随后就喂给当前模型（model-visible means logged）→ 必须
        // 落事件；位置在 user_message 之前，投影读起来是"先解析、后问题"。
        // 代读失败（无 key/限流/断网）＝ turn 失败，事件一条不落——不静默降级成
        // "模型看不见图还装看过"
        // 代读拿到的文本 = 模型将看到的同一份全文(正文+文件),口径一致
        const modelText = composeUserText(text, textFiles);
        if (refs.length > 0 && !(describeModel(agent.model)?.supportsVision ?? false)) {
          const describeImages = createVisionBridge((id) => attachmentStore.read(id));
          const described = await describeImages(refs, modelText);
          const descEvent = store.append({
            sessionId, ts: Date.now(), type: "image_described",
            content: described, model: VISION_BRIDGE_MODEL,
          });
          send(CHANNELS.event, descEvent);
        }
        await agent.engine.runTurn(text, refs, textFiles);
      } finally {
        runningSessions.delete(sessionId);
        send(CHANNELS.turnStatus, { sessionId, status: "idle" });
      }
      // 分区分类：turn 收口后跑一次便宜模型，判断话题是否换了（会话目录用）。
      // 位置与 vision-bridge 对称——那个在 turn 前，这个在 turn 后，都在 engine 外面。
      // runTurn 抛错时根本走不到这（失败的 turn 不值得分区）。
      // 刻意排在 finally 外面：分类是又一次完整往返，答案早就渲染完了，
      // 让它压着 turn 锁 = 用户在那几秒里发不出消息、换不了模型、删不掉会话——
      // 那不是转圈，是硬锁输入。放开锁再排队，串行由 sectionQueues 保证
      let aborted = false;
      for (const e of store.load(sessionId).slice().reverse()) {
        if (e.type === "turn_ended") { aborted = e.outcome === "aborted"; break; }
      }
      // 用户按了停止就别再起新的模型调用。半截对话确实也是对话，但停止键的契约
      // 是"停"——在它之后自作主张再烧一次配额，是把契约让位给了目录的完整性
      if (!aborted) {
        enqueueSectionClassify(sessionId);
        // 建议同样只在正常收口后跑:用户按了停止就别再起新的模型调用(同上一段的理由)。
        // catch 挂在这:suggestFollowUps 自己不抛,但它外面的 store.append / send 会,
        // 变成 unhandledRejection 会把主进程带走
        void suggestAndAppend(sessionId).catch((err) => console.error("跟进建议失败", err));
      }
    }
  );

  ipcMain.handle(CHANNELS.pickAttachments, async () => {
    const picked = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      // 不设 filters:什么都能选,分类闸门(intakeFile)决定收不收——
      // 拒收带人话理由,比灰掉文件更能让用户明白为什么
    });
    if (picked.canceled) return [];
    return Promise.all(
      picked.filePaths.map((p) => intakeFile(p, readFileSync(p), attachmentStore))
    );
  });

  // 粘贴/拖入:字节已经在渲染层手上(剪贴板给的是 File,不是路径),
  // 直接过同一道闸门。上限交给 intakeFile/AttachmentStore,这里不另设策略
  ipcMain.handle(
    CHANNELS.intakePastedFiles,
    (_e, files: { name: string; data: Uint8Array }[]) =>
      Promise.all(files.map((f) => intakeFile(f.name, new Uint8Array(f.data), attachmentStore)))
  );

  ipcMain.handle(CHANNELS.attachmentDataUrl, (_e, id: string) => {
    const data = attachmentStore.read(id); // id 非法/不存在 = 抛,渲染层兜
    const mediaType = detectImageType(data) ?? "application/octet-stream";
    return `data:${mediaType};base64,${Buffer.from(data).toString("base64")}`;
  });

  ipcMain.handle(CHANNELS.stopTurn, (_e, sessionId: string) => {
    // 幂等：turn 已收尾 / 重复点击都静默无操作——停止键连按不该报错
    if (!runningSessions.has(sessionId)) return;
    agents.get(sessionId)?.engine.abortTurn();
    // 收尾（turnStatus idle、runningSessions 清理）仍由 sendMessage 的 finally 负责：
    // 中断只是翻信号，turn 的退出路径全程只有一条
  });

  ipcMain.handle(CHANNELS.compact, async (_e, sessionId: string) => {
    const agent = agents.get(sessionId);
    if (!agent) throw new Error("会话不存在或未激活");
    if (runningSessions.has(sessionId)) throw new Error("turn 进行中不能压缩上下文");
    // compact 是一次真实的模型调用（几秒），复用 turn 状态灯让 UI 有反馈、挡并发
    runningSessions.add(sessionId);
    send(CHANNELS.turnStatus, { sessionId, status: "running" });
    try {
      await agent.engine.compact();
    } finally {
      runningSessions.delete(sessionId);
      send(CHANNELS.turnStatus, { sessionId, status: "idle" });
    }
  });

  ipcMain.handle(
    CHANNELS.decideApproval,
    (_e, sessionId: string, toolCallId: string, incoming: ApprovalDecisionOutcome) => {
      const agent = agents.get(sessionId);
      if (!agent) return;
      const outcome: ApprovalOutcome = {
        decision: incoming.decision,
        ...(incoming.reason ? { reason: incoming.reason } : {}),
        ...(incoming.grant ? { grant: incoming.grant } : {}),
        ...(incoming.revisedArgs !== undefined ? { revisedArgs: incoming.revisedArgs } : {}),
      };
      // 授权先记下再唤醒：唤醒之后管线立刻往下跑，同一个 turn 里紧跟着的
      // 下一个调用就该享受到这条授权了（ADR-0041）
      if (incoming.decision === "approved" && incoming.grant) {
        agent.grant(toolCallId, incoming.grant);
      }
      agent.approver.resolve(toolCallId, outcome);
    }
  );

  ipcMain.handle(
    CHANNELS.answerQuestions,
    (_e, sessionId: string, toolCallId: string, outcome: AskUserOutcome) => {
      agents.get(sessionId)?.answerQuestions(toolCallId, outcome);
    }
  );

  app.on("before-quit", () => {
    terminals.killAll(); // 孤儿 dev server 会占着端口而没人知道是谁占的
    browsers.closeAll(); // 窗口没了,挂在它 contentView 上的 view 全部收掉
    store.close();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
