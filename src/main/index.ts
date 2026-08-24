// 主进程 — Electron 接线层：开窗、IPC 应答、把 agent 的推送接到 webContents。
// agent 懒加载：用户选完工程文件夹（startSession）才组装，选之前 boot 返回 null。

import { app, BrowserWindow, Menu, dialog, ipcMain, Notification, shell } from "electron";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  CHANNELS,
  type BootInfo,
  type StartSessionOptions,
  type OutgoingAttachment,
  type PokerAction,
  type PokerTableInput,
  type BrowserBounds,
  type ApprovalDecisionOutcome,
  type McpServerConfig,
  type McpServersSnapshot,
  type IslandBoot,
  type ApprovalRequest,
  type ApprovalPreview,
} from "../shared/shellBridge.js";
import { createAgent, loadDotEnv, type AgentPush } from "./agent.js";
import { createHistoryCapability } from "./historyCapability.js";
import { createTerminalHub } from "./terminalHub.js";
import { createBrowserHub } from "./browserHub.js";
import { createMcpHub } from "./mcpHub.js";
import { configDir } from "./configDir.js";
import { connectMcpClient } from "./mcpClient.js";
import { loadMcpConfig, saveMcpConfig } from "./mcpConfig.js";
import { createWebContentsViewHandle } from "./webContentsViewFactory.js";
import { EventStore, type SessionSummary } from "../session/store.js";
import { AttachmentStore, detectImageType } from "../session/attachments.js";
import type { ToolCallRequest, UserAttachmentRef, UserTextFile } from "../session/events.js";
import type { Tool } from "../tools/tool.js";
import { composeUserText, deriveMessages, COMPACT_COMPRESSION } from "../session/deriveMessages.js";
import { settleNudgeSpawn, MEMORY_NUDGE_EVERY, reviewerTranscript } from "./memoryNudge.js";
import { intakeFile } from "./attachmentIntake.js";
import { createVisionBridge } from "./visionBridge.js";
import { loadVisionModel, saveVisionModel } from "./visionModelStore.js";
import { classifyLogView } from "./sectionClassifier.js";
import { annotateTurn } from "./turnAnnotator.js";
import { autoTitleSource } from "./sessionTitler.js";
import { createCheapAdapter } from "./cheapAdapter.js";
import { microCompactOnce } from "../loop/microCompact.js";
import { loadKeys, saveKey, applyToEnv } from "./keyVault.js";
import { loadAlwaysAllow, addAlwaysAllow } from "./permissionStore.js";
import { loadAutoCompact, saveAutoCompact } from "./autoCompactStore.js";
import { loadHelperModel, saveHelperModel } from "./helperModelStore.js";
import type { AutoCompactSettings } from "../shared/autoCompact.js";
import type { IslandSettings, UpdaterState } from "../shared/shellBridge.js";
import { createUpdater } from "./updater.js";
import { createUpdaterHostDeps } from "./updaterHost.js";
import { RELEASES_PAGE_URL } from "./updaterCore.js";
import { scanSkills } from "./skills.js";
import {
  scanSubagents,
  subagentRoots,
  subagentSlotTaken,
  trustedWorkspace,
  trustedWorkspaceForWrite,
  writeSubagent,
} from "./subagents.js";
import { withBuiltins } from "./builtinSubagents.js";
import { createSubagentDef, saveSubagentDef, type SubagentWriteDeps } from "./subagentWrites.js";
import { createSubagentRunner } from "./subagentRunner.js";
import { childAgentConfig, createChildAgent, type ChildAgentConfig } from "./resumeChild.js";
import type { BrowserReadOptions, McpCapability } from "../world/executionWorld.js";
import type { ToolDefinition } from "../model/adapter.js";
import { DEFAULT_PREAMBLE, type SubagentDef } from "../shared/subagent.js";
import { createProtocolService } from "./protocolService.js";
import { profileDirName } from "./profile.js";
import { createGitGraphService } from "./gitGraphService.js";
import { MEMORY_FILES, isMemoryTarget, parseEntries, formatEntries, type MemoryTarget } from "../shared/memoryStore.js";
import { applyUserEdit } from "./memoryEdit.js";
import { createWorkspacePresence } from "./workspacePresence.js";
import { describeModel, OLLAMA_MODEL_PREFIX } from "../shared/modelCatalog.js";
import type { ThinkingMode } from "../shared/thinking.js";
import { probeOllamaModels, rememberOllamaModels } from "./ollamaModels.js";
import { clearBalanceCache, fetchProviderBalances } from "./providerBalance.js";
import { usageSnapshot } from "../shared/usageStats.js";
import { islandUsage, type IslandUsageRow } from "../shared/islandUsage.js";
import { loadIslandSettings, normaliseIslandSettings, saveIslandSettings } from "./islandSettingsStore.js";
import { maskKey } from "../shared/keyMask.js";
import type { ModelLane } from "../shared/modelLane.js";
import { findProvider, providerKeyEnvs, type ProviderId } from "../shared/providerCatalog.js";
import { markSecretEnv, unmarkSecretEnv } from "../shared/secretEnv.js";
import { mcpToolName } from "../shared/mcp.js";
import { singleFlight } from "../shared/singleFlight.js";
import type { ApprovalOutcome } from "../loop/approvalGate.js";
import type { AskUserOutcome } from "../shared/askUser.js";
import { AccountManager, createSupabaseAuthClient } from "./account.js";
import {
  createTable, joinTable, leaveTable, listTables, sendAction, startHand, watchTable,
} from "./pokerApi.js";
import { fetchWalletBalance } from "./walletApi.js";
import { createSend } from "./rendererPush.js";
import { createDeltaCoalescer } from "./deltaCoalescer.js";
import { createIslandBridge, type IslandCommand } from "./islandBridge.js";
import { flattenFleet, initialIsland, reduceIsland, type IslandInput, type IslandState } from "./islandProjection.js";
import { resolveIslandBinPath } from "./islandBinPath.js"; // Task 7 提供正式实现;本任务先内联占位
import { FriendsManager } from "./friends.js";
import { createSupabaseFriendsApi } from "./supabaseFriendsApi.js";
import { UserProfileManager } from "./userProfile.js";
import { createSupabaseUserProfileApi } from "./supabaseUserProfileApi.js";
import {
  approvalRequestNotification, askUserNotification, createNotifier, dmNotification,
  friendRequestNotification, inviteNotification, turnCompleteNotification, turnFailedNotification,
  newIncomingInvites, newIncomingRequests,
} from "./friendNotifier.js";
import type { FriendsSnapshot, GameInvite } from "../shared/friends.js";
import type { ProfilePatch } from "../shared/profile.js";
import { findMrottoDeepLink } from "./deepLink.js";

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

// Windows/Linux 深链走 argv 而不是 open-url（issue #310）：浏览器跳 mrotto:// 时
// 系统会启动第二个实例，URL 在它的 argv 里。single instance lock 把冗余实例拦下，
// URL 经 second-instance 事件转交给存活实例。锁文件在 userData 里——所以必须在
// 上面 setPath("userData") 之后再抢锁（issue #322 发现的 bug：原来锁在 setPath
// 之前抢，落在默认目录，OTTO_PROFILE 双开 / e2e 会跟已安装版互相抢锁秒退）。
// OTTO_PROFILE 双开（docs/dev-two-accounts.md）各有各的 userData，互不抢锁。
// 抢不到锁 = 本进程只是个送信的，用 app.exit 立即退（此刻什么都没初始化，无需清理）。
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

// Windows/Linux 摘掉 Electron 默认菜单栏（File/Edit/View/Window，issue #320）：
// UI 全在窗体内，那排菜单只占一行还暴露 DevTools。剪贴板/输入快捷键是 Chromium
// 原生行为，不靠菜单 accelerator。macOS 的应用菜单要留——Cmd+C/V/Q 挂在上面，
// 摘了整个键盘习惯就废了。
if (process.platform !== "darwin") {
  Menu.setApplicationMenu(null);
}

let accountManager: AccountManager | null = null;
let pendingAuthUrl: string | null = null;
let mainWindow: BrowserWindow | null = null;
// 真的要退了吗?mac 上主窗的关闭键是"藏起来"而不是"关掉"(见 createWindow 里的
// close 拦截),只有走到 before-quit 才算数 —— 这个标志是两者之间唯一的区分
let quitting = false;

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

// open-url（macOS）与 second-instance（Windows/Linux）两个入口共用一条回调通道：
// AccountManager 就绪则直接处理，否则缓存到 ready 后 flush（那边带 restore 互斥逻辑）
function handleAuthUrl(url: string): void {
  if (accountManager) {
    accountManager
      .handleCallback(url)
      .then(() => focusMainWindow())
      .catch((err) => console.error("account.handleCallback 失败", err));
  } else {
    pendingAuthUrl = url;
  }
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleAuthUrl(url);
});

app.on("second-instance", (_event, argv) => {
  const url = findMrottoDeepLink(argv);
  if (url) {
    handleAuthUrl(url);
  } else {
    // 没带深链的二次启动（用户又点了图标）：把已有窗口拉回前台
    focusMainWindow();
  }
});

// Windows/Linux 冷启动深链：URL 在本进程 argv 里。此刻 AccountManager 必然未建
// （ready 前），走 pendingAuthUrl 缓存。macOS 上 argv 不会有 mrotto://，无害。
{
  const coldStartUrl = findMrottoDeepLink(process.argv);
  if (coldStartUrl) pendingAuthUrl = coldStartUrl;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Mr Otto",
    backgroundColor: "#121212",
    // macOS 隐藏原生标题栏那一行,红绿灯(hiddenInset)叠进内容左上角——
    // 与侧栏收起钮同一行(Claude 桌面端同款)。非 mac 平台保持默认标题栏。
    // hiddenInset 默认把红绿灯钉死在左上角(约 12,11pt),和下面 work/game 分段控件的
    // 左边距(8px)对不齐、又贴顶 —— 显式挪到 (16,16)pt:顶栏统一 h-11(44px,见 App.tsx
    // HEADER_H),中心 22;y=19 让灯的视觉中心落在 22(截图实测:y=16 时灯比中心高 3px,
    // 这个 y 不是灯的几何顶边),和侧栏开关钮 / 搜索钮(SidebarNub.tsx 的 TOGGLE_TOP)
    // 同一条水平线。三颗灯占到 x=68,开关钮从 72 起
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 19 } }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // mac 惯例:Cmd+W / 点红灯是"收起窗口",app 不退。这里必须拦,否则主窗一关
  // 就 destroy 了——推送目标(createSend 的唯一目标)没了,还在跑的 turn
  // 推给谁都是丢(issue #53),而且用户没有"回主窗看看"的路了(#175 I5)。
  // 真退出时 before-quit 先把 quitting 置上,这里就放行
  if (process.platform === "darwin") {
    win.on("close", (e) => {
      if (quitting) return;
      e.preventDefault();
      win.hide();
    });
  }
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
  // 图标找不到只丢掉图标,不能把整条启动链拖死:这个 then 里往下是建窗口,
  // 抛在这儿窗口就永远不出来(e2e 冒烟用 `electron out/main/index.js` 起 app 时
  // getAppPath 指向 out/main,就踩到过 —— 白屏都没有,是根本没有窗)
  if (process.platform === "darwin") {
    try {
      app.dock?.setIcon(join(app.getAppPath(), "resources/icon.png"));
    } catch (e) {
      console.warn("dock 图标没装上:", e instanceof Error ? e.message : e);
    }
  }
  app.setAboutPanelOptions({ applicationName: "Mr Otto", applicationVersion: app.getVersion() });

  loadDotEnv((p) => readFileSync(p, "utf8"), join(process.cwd(), ".env"));
  // 设置页存的 key 后加载 = 覆盖 .env（用户最新意志优先）
  const keyVaultPath = join(app.getPath("userData"), "keys.json");
  // 永久授权名单（ADR-0041）。和 keys.json 一样是 app 级、跨会话的东西,
  // 所以和它放在一起装配；每次现读文件 —— 名单被改了不用重启
  const permissionsPath = join(app.getPath("userData"), "permissions.json");
  // 自动压缩设置（ADR-0062）。和 permissions.json 同款：app 级、跨会话，
  // 每次造 agent 前现读——设置页改了不用重启
  const autoCompactPath = join(app.getPath("userData"), "auto-compact.json");
  // 三个 turn 外挂共用的那一款小模型（issue #112）。现读不缓存：设置页改了当场生效。
  // 出厂默认和 vision-bridge 共一家的免费额度——那条路失败会让整个 turn 失败，
  // 而外挂失败只少一条标题；愿意换家的人在设置页换，换了就换了一把 key、一份额度
  const helperModelPath = join(app.getPath("userData"), "helper-model.json");
  const helperModel = (): string => loadHelperModel(helperModelPath);
  const visionModelPath = join(app.getPath("userData"), "vision-model.json");
  const visionModel = (): string => loadVisionModel(visionModelPath);
  // 灵动岛设置(#199)。app 级、跨会话;启动读一次进内存——只有 set handler 会改它,
  // 不像 autoCompact 有"造 agent 前现读"的需求(岛推送每个工具事件都在跑,现读太贵)
  const islandSettingsPath = join(app.getPath("userData"), "island.json");
  let islandSettings = loadIslandSettings(islandSettingsPath);
  applyToEnv(loadKeys(keyVaultPath), process.env);
  // .env 那条路不经过 keyVault，登记不到（loadDotEnv 只认"补空缺"这一件事）。
  // 补登记：本仓认识的那几个 provider key 变量，此刻有值的都算凭据——
  // 不管它来自 .env 还是用户自己的 shell。名单是精确的（providerCatalog 列的
  // 就那几个），不是启发式，所以不会误伤用户的普通变量（issue #153）
  for (const envName of providerKeyEnvs()) {
    if (process.env[envName]) markSecretEnv(envName);
  }

  const win = createWindow();
  mainWindow = win;

  // 主进程里所有推给渲染层的消息都走这一个出口——窗口销毁后静默丢弃(issue #53)。
  // 别在别处直接 win.webContents.send：那正是这个 bug 上次只修了一半的原因
  const rawSend = createSend(win);
  // 流式合帧（issue #278）：assistantDelta/toolOutput 先进 16ms 缓冲再走 rawSend
  //（接线在下面的 push 里）。任何非 delta 推送之前必须把缓冲放行——完整事件落地
  // 时渲染层会清直播缓冲，压着的尾段晚到会把幽灵字写回去（deltaCoalescer.ts 顶注）。
  // 把 flush 焊进统一出口：所有非 delta 推送本来就都走 send，这条纪律自动覆盖全部
  const deltas = createDeltaCoalescer({
    assistantDelta: (sessionId, text, kind) =>
      rawSend(CHANNELS.assistantDelta, { sessionId, text, kind }),
    toolOutput: (sessionId, toolCallId, chunk, stream) =>
      rawSend(CHANNELS.toolOutput, { sessionId, toolCallId, chunk, stream }),
  });
  const send: typeof rawSend = (channel, ...args) => {
    deltas.flush();
    rawSend(channel, ...args);
  };

  // 全屏状态推给渲染层:macOS 全屏隐红绿灯,左上角 logo 该让位/回来。
  // 变化走推送给已订阅的 renderer,首帧快照走 getWindowFullscreen(见下方 handle)
  win.on("enter-full-screen", () => send(CHANNELS.windowFullscreen, true));
  win.on("leave-full-screen", () => send(CHANNELS.windowFullscreen, false));

  // 固定接线形态（Task 6 裁定，见 account.ts 顶部注释）：openExternal 走系统浏览器，
  // onChange 推 accountChanged 事件，client 是真 supabase client（authStorage 落盘于 userData）
  const supabase = createSupabaseAuthClient(join(app.getPath("userData"), "auth.json"));
  // 提示音走渲染层播 wav(mac/win 同一份音频):聚焦分支两端都用它;
  // 失焦分支只有 win 用(toast 不支持自定义音),mac 用原生音名——
  // 这样 mac 窗口已关(Cmd+W,渲染层不在)时失焦通知的声音也不丢
  const playSound = (sound: string) => {
    if (!win.isDestroyed()) send(CHANNELS.playSound, sound);
  };
  // 系统通知:窗口没聚焦才发横幅,聚焦只响声;点了就聚焦 + 告诉渲染层落到哪个面板(friendNotifier.ts)
  const notify = createNotifier({
    isFocused: () => !win.isDestroyed() && win.isFocused(),
    playSound,
    show: (spec, onClick) => {
      if (!Notification.isSupported()) return;
      // sound 是 macOS 系统音名(Notification 原生支持);不设 = 静默,好友通知维持原状。
      // win 的 toast 不认自定义音:静音掉系统默认"叮",换成渲染层播同名 wav,
      // 两个平台听到同一份音频(win 上窗口全关 = app 退出,渲染层必在,不漏)
      const mac = process.platform === "darwin";
      const n = new Notification({
        title: spec.title,
        body: spec.body,
        ...(spec.sound ? (mac ? { sound: spec.sound } : { silent: true }) : {}),
      });
      n.on("click", onClick);
      n.show();
      if (spec.sound && !mac) playSound(spec.sound);
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
      workspacesChanged: (snapshot) => send(CHANNELS.workspacesChanged, snapshot),
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
  // 本次进程运行里派出去过的子会话 id。只增不减，且只在本次运行内有意义：
  // 它是 resumeSession 那道"绝不重建第二个 agent"守卫的判据（见那里的注释）。
  // 上一轮 app 留下的子会话不在里面 —— 它们本来就该按崩溃修复重建（issue #141）
  const spawnedThisRun = new Set<string>();
  let currentSessionId: string | null = null;
  // 岛只跟主窗当前会话。主进程存这一个 id:helper ready 时补一次快照,变化时喂投影器
  let activeSessionId: string | null = null;

  // 灵动岛(ADR-0059 推翻版):不再是第二个 BrowserWindow,换成 stdio 桥接一个
  // 原生 Swift helper 进程。helper 二进制不存在(未打包 / 非 mac)时 bridge 为
  // null,岛静默不启动——不拖死启动链,也不留一块空白窗口。
  const islandStates = new Map<string, IslandState>();
  const bridge =
    process.platform === "darwin"
      ? (() => {
          const bin = resolveIslandBinPath();
          if (!bin) return null;
          return createIslandBridge({
            binPath: bin,
            spawn: (p) => {
              const cp = spawn(p, [], { stdio: ["pipe", "pipe", "inherit"] });
              return { stdin: cp.stdin!, stdout: cp.stdout!, on: cp.on.bind(cp), kill: () => cp.kill() };
            },
            onCommand: (c) => handleIslandCommand(c),
            log: (m) => console.warn(m),
          });
        })()
      : null;

  // 整包推当前会话集合(侧栏可见会话 × 各自 reducer 状态)。会话多时也只是几字段/行,
  // 沿用 ADR-0059 的"丢弃成本可忽略"
  // display=usage 时每次推送都要一份用量表,但账单 SQL + 聚合不值得跟着每个
  // 工具事件跑——30s 记忆化:表里的数字是"今天烧了多少"量级,30s 的陈旧无感,
  // 而工具事件可以一秒好几个
  let islandUsageCache: { at: number; rows: IslandUsageRow[] } | null = null;
  const islandUsageRows = (): IslandUsageRow[] => {
    const now = Date.now();
    if (!islandUsageCache || now - islandUsageCache.at > 30_000) {
      const since = now - 14 * 86_400_000;
      islandUsageCache = { at: now, rows: islandUsage(store.billedUsage(since), { now }) };
    }
    return islandUsageCache.rows;
  };

  // sessions() 是全表扫描级的查询(标题/归档子查询),而 pushFleet 跟着**每条**
  // 事件跑——工具密集的 turn 一秒好几次。1s 记忆化:岛上会用到的字段里只有
  // lastTs 排序会随普通事件漂移,晚 1 秒重排无感;真正改会话表形状的三类事件
  // (建会话/改名/归档)在 feedIsland 里当场失效缓存,岛上立即可见
  let fleetSessionsCache: { at: number; rows: SessionSummary[] } | null = null;
  const fleetSessions = (): SessionSummary[] => {
    const now = Date.now();
    if (!fleetSessionsCache || now - fleetSessionsCache.at > 1_000) {
      fleetSessionsCache = { at: now, rows: store.sessions() };
    }
    return fleetSessionsCache.rows;
  };

  const pushFleet = (): void => {
    if (!bridge) return;
    const fleet = flattenFleet(islandStates, fleetSessions(), activeSessionId);
    fleet.display = islandSettings.display;
    if (islandSettings.display === "usage") fleet.usage = islandUsageRows();
    bridge.pushState(fleet);
  };

  /** 投影器入口:四类输入都带 sessionId,路由到 Map 里对应那份 IslandState 跑
      reduceIsland;变了就重推整包 fleet。activeSession 输入顺便更新 focused */
  const feedIsland = (input: IslandInput): void => {
    if (!bridge) return;
    const sid = islandInputSessionId(input);
    if (sid) {
      const cur = islandStates.get(sid) ?? { ...initialIsland, sessionId: sid };
      const next = reduceIsland(cur, input);
      if (next !== cur) islandStates.set(sid, next);
    }
    // 改会话表形状的事件让缓存立即失效,岛上不吃 1s 延迟
    if (
      input.kind === "event" &&
      (input.event.type === "session_created" ||
        input.event.type === "session_renamed" ||
        input.event.type === "session_autotitled" ||
        input.event.type === "session_archived")
    ) {
      fleetSessionsCache = null;
    }
    pushFleet();
  };

  /** 从 IslandInput 取它作用的 sessionId(activeSession 用 boot.activeSessionId) */
  function islandInputSessionId(input: IslandInput): string | null {
    switch (input.kind) {
      case "event": return input.event.sessionId;
      case "turnStatus": return input.update.sessionId;
      case "approvalRequest": return input.req.sessionId;
      case "activeSession": return input.boot.activeSessionId;
    }
  }

  // 分区分类 + 跟进建议的合并调用（issue #284，调用本体在 turnAnnotator.ts）：
  // 两个外挂同型号、同时机、上下文重合，一次便宜模型往返各取所需。
  // 按会话串行队列。合并调用跑在 turn 锁之外（见 sendMessage 末尾），
  // 所以同一会话的两次分类会撞车：各自的 store.load 都看不到对方还没落的
  // section_classified，于是两个标题描述同一段、startSeq 却各开一处。
  // 链起来 = 同一会话永远只有一个在跑；跨度锚点本来就是自愈的
  // （最后一条分类事件之后的全部事件），后来的那次只是看到更宽的一段。
  // 代价：分类在飞的时候下一个 turn 可以开跑，分类#N+1 看到的跨度被分类#N 的事件
  // 切割得只剩 turn N+1 本身那几条、汇总后是空。分类不落事件，turn N+1 根本没被
  // 分类；若它开了新话题，章节标题要等 turn N+2 才出现，而且锚点是 N+2 不是 N+1——
  // 导航跳过去会落在话题开始之后。下一个 turn 的分类自动补上漏掉的那段（自愈）。
  // 这点代价换来的是输入框不被锁住，值。
  // 建议原来不排队（没有锚点，后落盘天然覆盖前一条），合并后跟着分类串行：
  // 排队期间新 turn 收口的话，本次跑的时候读到的已是更新的最后一轮——结果一样，
  // 只是到得稍晚。省一次往返换来的这点延迟，值（权衡记录：ADR-0080）
  const sectionQueues = new Map<string, Promise<void>>();

  const annotateAndAppend = async (sessionId: string): Promise<void> => {
    // 分类读尾段切片而不是全量 load（issue #279，等价性论证在 classifyLogView 注释里）；
    // 建议只读最后一轮问答：lastExchange 本来就只看最后一条 user_message
    // 起的那段——从它开始读（afterSeq 不含端点，所以 -1），没有用户消息就给空数组
    // （lastExchange([]) 也是空，summarize 出空串那一边直接不进提示词）
    const lastUser = store.lastSeqOf(sessionId, "user_message");
    // 会话自动命名（issue #335）搭同一次便宜模型往返：手动改过名或已命名过就不再跑
    // （一次会话最多一条），首行够短也不跑（现状已是合格标题，判定在 autoTitleSource）
    const titleSource =
      store.lastSeqOf(sessionId, "session_renamed") >= 0 ||
      store.lastSeqOf(sessionId, "session_autotitled") >= 0
        ? null
        : autoTitleSource(store.firstUserMessage(sessionId));
    const result = await annotateTurn(
      classifyLogView(store, sessionId),
      lastUser < 0 ? [] : store.load(sessionId, { afterSeq: lastUser - 1 }),
      helperModel(),
      titleSource
    );
    if (!result) return;
    // 出了 turn 锁，delete-session 不再被挡住：这一跑期间会话可能已被 purge。
    // 往 purge 过的 sessionId 上 append 会凭空造出一条没有 session_created 的
    // 幽灵会话，而删除按 ADR-0002 是不可逆的物理抹除。agents 只在 purge 时删条目，
    // 所以它在不在就是会话还活不活着
    if (!agents.has(sessionId)) return;
    // 一次调用一份账：usage 只挂在先落的那条事件上，两条都挂 deriveUsage 会算两次
    let usageSpent = false;
    const billOnce = () => {
      if (usageSpent || !result.usage) return {};
      usageSpent = true;
      return { usage: result.usage };
    };
    if (result.section) {
      const sectionEvent = store.append({
        sessionId, ts: Date.now(), type: "section_classified",
        title: result.section.title, model: result.model, ...billOnce(),
      });
      send(CHANNELS.event, sectionEvent);
    }
    if (result.suggestions) {
      const event = store.append({
        sessionId, ts: Date.now(), type: "suggestions_generated",
        suggestions: result.suggestions, model: result.model, ...billOnce(),
      });
      send(CHANNELS.event, event);
    }
    if (result.sessionTitle) {
      const event = store.append({
        sessionId, ts: Date.now(), type: "session_autotitled",
        title: result.sessionTitle, model: result.model, ...billOnce(),
      });
      send(CHANNELS.event, event);
    }
  };

  // 记忆审查：与分区分类/跟进建议同构的第三条外挂（turn 锁之外、永不抛、
  // 会话被 purge 就不落）。每 10 个 user turn 落一条 memory_nudge，然后派内置
  // memory-reviewer 子智能体；子会话自己调 memory 工具写盘，结果不回父上下文
  // （父会话整个 session 看到的记忆仍是开头那份快照，ADR-0060）。
  //
  // 子会话没有自己的 subagentRunner——这里现造一个，接线和 createSessionAgent
  // 里派活那份完全同构（同一个 list / parent / alwaysAllow / register），
  // 只是派活的时机不是模型调 task 工具，而是 turn 收口这一刻
  const nudgeMemory = async (sessionId: string): Promise<void> => {
    const agent = agents.get(sessionId);
    if (!agent) return;
    // 该不该提醒不用全量 load（issue #279），与 shouldNudge(全量日志) 语义逐条对齐：
    // spawnedBy 判定 = 第 0 条 session_created（单行 PK 查询）；
    // "距上次提醒过了几轮" = 最后一条 memory_nudge 之后的 user_message 条数（COUNT）。
    // 触发了（1/10 个 turn）才为 reviewer 转写全量读一次——转写要整段投影，省不掉
    const created = store.window(sessionId, 0, 0)[0];
    if (created?.type === "session_created" && created.spawnedBy) return;
    const turns = store.countType(sessionId, "user_message", store.lastSeqOf(sessionId, "memory_nudge"));
    if (turns < MEMORY_NUDGE_EVERY) return;
    const log = store.load(sessionId);
    const nudgeEvent = store.append({
      sessionId, ts: Date.now(), type: "memory_nudge", userTurns: MEMORY_NUDGE_EVERY,
    });
    send(CHANNELS.event, nudgeEvent);
    // 转写给 reviewer 看：只丢 system（那条尾部拼着 MEMORY/USER 块，reviewer
    // 拿到的是下面 readMemoryFiles() 现读的最新版本，喂旧投影是重复信息）。
    // user/assistant/tool 全留——工具怪癖长在 tool 消息和 assistant 的
    // tool_calls 里，reviewerTranscript 里有截尾逻辑，纯函数拆进 memoryNudge.ts 好测
    const transcript = reviewerTranscript(deriveMessages(log, COMPACT_COMPRESSION));
    const mem = readMemoryFiles();
    const runner = createSubagentRunner({
      store,
      attachments: attachmentStore,
      push,
      list: () => listSubagents(agent.workspace),
      parent: () => ({
        sessionId: agent.sessionId,
        workspace: agent.workspace,
        world: agent.world,
        model: agent.model,
        approvalMode: agent.approvalMode,
      }),
      getAccessToken,
      alwaysAllow: () => loadAlwaysAllow(permissionsPath),
      autoCompactSettings: () => loadAutoCompact(autoCompactPath),
      // 子 agent 也要进注册表：道理同 createSessionAgent 里那份——它的 sessionId
      // 从建好那一刻起就是活的，resumeSession 必须查得到它
      register: (child) => {
        agents.set(child.sessionId, child);
        spawnedThisRun.add(child.sessionId);
      },
    });
    // 收口走 settleNudgeSpawn（issue #186）：跑完往父会话落配对的 tool_result，
    // 时间线那张卡才翻得成 done——不落的话合成 toolCallId 永远没有结果
    const toolCallId = `memory-nudge-${nudgeEvent.seq}`;
    await settleNudgeSpawn(
      { append: (e) => store.append(e), send: (e) => send(CHANNELS.event, e) },
      sessionId, toolCallId,
      () => runner.run({
        agent: "memory-reviewer",
        task: `当前 MEMORY:\n${mem.memory || "(空)"}\n\n当前 USER:\n${mem.user || "(空)"}\n\n最近对话：\n${transcript}`,
        parentToolCallId: toolCallId,
      }),
    );
  };

  // 微压缩（ADR-0064）：第四条 turn 后外挂，与分区分类同构——turn 锁外、永不抛、
  // 会话被 purge 就不落。**必须串行**（同 sectionQueues 的理由）：两次并发的
  // microCompactOnce 各自看不到对方的 micro_compacted，会对同一个 exchange 摘两次、
  // 后落的那条 running summary 丢掉先落那条的内容。
  const MICRO_TIMEOUT_MS = 30_000;
  const microQueues = new Map<string, Promise<void>>();

  const microCompactAndAppend = async (sessionId: string): Promise<void> => {
    if (!loadAutoCompact(autoCompactPath).micro) return; // 现读：设置页一关当场停
    // cheapAdapter 必须每跑一次现造：它带的是 AbortSignal.timeout(30s)，从造出来
    // 那一刻开始走表。提到闭包外面 = 主进程开机 30 秒后每次微压缩都当场超时
    // 现读一次、记在局部：这一跑要几十秒，期间用户可能在设置页换了型号——
    // 落盘那条 micro_compacted 记的必须是真正跑这一次的那款
    const model = helperModel();
    const cheap = createCheapAdapter(model, MICRO_TIMEOUT_MS);
    if (!cheap) return;
    const log = store.load(sessionId);
    const result = await microCompactOnce(log, cheap.adapter, {
      signal: cheap.signal,
    });
    if (!result) return;
    // 同 classifyAndAppend：出了 turn 锁，这一跑期间会话可能已被 purge，
    // 往 purge 过的 sessionId 上 append 会凭空造出一条幽灵会话
    if (!agents.has(sessionId)) return;
    // turn 在跑就丢弃（issue #283 ②）：cheap 模型这几十秒里用户可能已开下一个
    // turn，此刻落 micro_compacted = 该 turn 后续每圈投影中段突变，prefix cache
    // 全废——ADR-0073 攒批省下的又赔回去。丢弃无害：摘要没落盘，下个收口的
    // enqueue 重算一份（microCompactOnce 本来就是"失败=不落事件，下一 turn 自愈"）
    if (runningSessions.has(sessionId)) return;
    // 跑的这几十秒里下一个 turn 可能已经 auto-compact 了：那份摘要描述的是被 compact
    // 替换掉的历史，投影侧（latestMicroCompacted）会按 coversUpTo 丢弃它，这里干脆
    // 不落——落了也只是一条永远不投影、却记在账上的事件。
    // 只查开跑之后的尾巴（issue #197）：开跑前的日志喂过 microCompactOnce，
    // 它选出的 coversUpTo 天然在当时最新的 compact 之后，旧事件里不可能命中
    const lastSeen = log.at(-1)?.seq ?? -1;
    const compactedSince = store
      .load(sessionId, { afterSeq: lastSeen })
      .some((e) => e.type === "context_compacted" && e.seq > result.coversUpTo);
    if (compactedSince) return;
    const event = store.append({
      sessionId, ts: Date.now(), type: "micro_compacted",
      summary: result.summary, coversUpTo: result.coversUpTo, model,
      ...(result.usage ? { usage: result.usage } : {}),
    });
    send(CHANNELS.event, event);
  };

  const enqueueMicroCompact = (sessionId: string): void => {
    const prev = microQueues.get(sessionId) ?? Promise.resolve();
    // catch 挂在链上：microCompactOnce 自己不抛，但它外面的 store.append / send 会。
    // 一环炸了不能毒死后面的环，也不能变成 unhandledRejection 把主进程带走
    const next = prev
      .then(() => microCompactAndAppend(sessionId))
      .catch((err) => console.error("微压缩失败", err));
    microQueues.set(sessionId, next);
    // 排空即删（同 sectionQueues）：只有自己仍是队尾才删
    void next.then(() => {
      if (microQueues.get(sessionId) === next) microQueues.delete(sessionId);
    });
  };

  const enqueueAnnotate = (sessionId: string): void => {
    const prev = sectionQueues.get(sessionId) ?? Promise.resolve();
    // catch 挂在链上：annotateTurn 自己不抛，但它外面的 store.append / send 会。
    // 一环炸了不能毒死后面的环，也不能变成 unhandledRejection 把主进程带走
    const next = prev
      .then(() => annotateAndAppend(sessionId))
      .catch((err) => console.error("分区分类/跟进建议失败", err));
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

  // MCP server 登记表:配置存 userData 外的 ~/.mr-otto/mcp.json(与 skill 目录同一条口径,
  // 是人手编的配置而不是 app 生成的状态)。connect 注入 SDK 客户端(mcpClient.ts)——
  // hub 本身不碰 SDK,状态机能用假 connect 测干净(mcpHub.ts 顶部注释)。
  const mcpConfigPath = join(configDir(homedir()), "mcp.json");
  const mcpHub = createMcpHub({
    load: () => loadMcpConfig(mcpConfigPath),
    save: (servers, unrecognizedIds) => saveMcpConfig(mcpConfigPath, servers, unrecognizedIds),
    connect: connectMcpClient,
  });
  // 桥上四个读写方法共用同一份快照形状:server 清单 + 这份配置文件解析阶段
  // 的人话错误(review finding 4——一份 mcp.json 坏了不该连原因都传不到
  // 设置页,即便 Task 8/9 那张表本次没开工,这份走出去的形状也不该是错的)
  const mcpSnapshot = (): McpServersSnapshot => ({ servers: mcpHub.list(), errors: mcpHub.configErrors() });
  // hub 状态变了就推一次全量快照(设置页/斜杠面板都靠这个通道刷新)
  /** 把活跃会话此刻的工具声明推给渲染层（issue #141）。agent.toolDefs 是活 getter，
      BootInfo 里那份是 boot/resume 那一刻的快照——建出第一个子智能体（task 从
      available() 为 false 变成 true）、一台 MCP server 连上或掉线，主进程当场就变，
      镜像不推的话要等下次 boot 才对得上，而上下文占用弹窗算的正是这份表。
      没有活跃会话就什么都不推：那时渲染层那份本来就是空的 */
  const sendToolDefs = (): void => {
    const agent = currentSessionId ? agents.get(currentSessionId) : undefined;
    if (agent) send(CHANNELS.toolDefsChanged, { sessionId: agent.sessionId, toolDefs: agent.toolDefs });
  };
  mcpHub.onChange(() => { send(CHANNELS.mcpChanged, mcpSnapshot()); sendToolDefs(); });

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

  // 审批卡的载荷只在这里拼一次:实时推送(push.approvalRequest)和岛窗补快照
  // (islandSnapshot)必须交出同一形状的东西 —— 否则"中途切进来看到的卡"和
  // "刚推过来的卡"会长得不一样,而它们说的是同一件事(#175 I1)
  const approvalPayload = (
    sessionId: string,
    call: ToolCallRequest,
    tool: Tool,
    preview?: ApprovalPreview,
    fromAgent?: string
  ): ApprovalRequest => ({
    sessionId,
    call,
    toolDescription: tool.def.description,
    ...(preview ? { preview } : {}),
    ...(fromAgent ? { fromAgent } : {}),
  });

  // 所有 agent 共用同一份推送接线；靠消息里的 sessionId 区分来源
  const push: AgentPush = {
    event: (e) => {
      send(CHANNELS.event, e);
      feedIsland({ kind: "event", event: e });
    },
    approvalRequest: (sessionId, call, tool, preview, fromAgent) => {
      const req = approvalPayload(sessionId, call, tool, preview, fromAgent);
      send(CHANNELS.approvalRequest, req);
      feedIsland({ kind: "approvalRequest", req });
      // agent 停在原地等人批(#336):聚焦只响声,失焦弹横幅,点了落回那个会话
      notify(approvalRequestNotification(store.titleOf(sessionId), call.name, sessionId));
    },
    askUserRequest: (sessionId, toolCallId, questions) => {
      send(CHANNELS.askUserRequest, { sessionId, toolCallId, questions });
      // 同审批:turn 悬停在等答案(#336)
      notify(askUserNotification(store.titleOf(sessionId), questions[0]?.question ?? "", sessionId));
    },
    // 两条流式通道走合帧器（issue #278），不直发：50-100 次/秒的 IPC 压到 ~60
    assistantDelta: (sessionId, text, kind) => deltas.assistantDelta(sessionId, text, kind),
    toolOutput: (sessionId, toolCallId, chunk, stream) =>
      deltas.toolOutput(sessionId, toolCallId, chunk, stream),
  };

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
  //
  // 拎成函数是因为它有第二个用处：设置页画子智能体的工具勾选框要的正是这份表
  // （issue #141 —— 没有会话时 BootInfo.toolDefs 是空的，而首次使用路径恰恰是
  // 「新用户 → 设置 → 新建」）。那次调用要带上 mcp，这次开机探名字不带，
  // 差别只有这一个参数，其余装配必须逐字一致——否则两份表会各说各话
  const probeToolDefs = (mcp?: McpCapability): ToolDefinition[] => {
    const probeStore = new EventStore(":memory:");
    return createAgent({
      store: probeStore,
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
      // 给 configRoot：这条装配只用来探名字、永远不会真跑一轮，但不给的话
      // world.config 是 undefined，memory 工具不会出现在 TOOL_NAMES 里——
      // builtinSubagents 的 memory-reviewer 定义会把 "memory" 过滤成不认识的
      // 工具名，装出来的清单永远挂不上它要用的那把工具
      configRoot: configDir(homedir()),
      // 同理给 history：不给的话 world.history 是 undefined，session_search
      // 不会出现在 TOOL_NAMES 里——固定假 id 就够，这条装配永远不会真跑一轮
      history: createHistoryCapability(probeStore, () => "probe"),
      autoCompactSettings: () => loadAutoCompact(autoCompactPath),
      // 开机那次刻意不给 mcp（与 browser 的桩子相反）：那一步跑在注册第一个 IPC
      // 通道之前，给了就得先 await mcpHub.ready()，等一轮握手才能开门。
      // MCP 的工具名走另一条路补进来——mcpToolNamesNow() 现算（ADR-0054），
      // 因为它本来就会随 server 连上/掉线变，快照在这里表达不了
      ...(mcp ? { mcp } : {}),
    }).toolDefs;
  };

  let TOOL_NAMES: string[];
  try {
    TOOL_NAMES = probeToolDefs().map((d) => d.name);
  } catch {
    TOOL_NAMES = [];
  }
  /** 此刻活着的那些 server 提供的工具名（ADR-0054）。TOOL_NAMES 那个探针装配
      刻意不给 mcp，所以这份得单独现算——现算而不是快照：server 会连上、掉线、
      改清单，快照会让"认不认得这个名字"停在装配那一刻。
      mcp_read_resource 一并算上：它同样只在有 mcp 能力时才挂 */
  const mcpToolNamesNow = (): string[] => {
    const live = mcpHub.servers().filter((s) => s.live);
    if (live.length === 0) return [];
    return [
      "mcp_read_resource",
      ...live.flatMap((s) => s.tools.map((t) => mcpToolName(s.name, t.name))),
    ];
  };

  /** 现扫磁盘的清单。workspace 决定要不要带上工作区那两条根（ADR-0048）。
      null = 只看用户级（设置页的「用户」视图、探针装配） */
  const listSubagents = (workspace: string | null) => {
    // 磁盘定义和内置定义用的必须是同一份已知工具名单，否则同一个 mcp__… 名字
    // 在两边一个认得一个不认得
    const known = [...TOOL_NAMES, ...mcpToolNamesNow()];
    // subagentRoots 只拼路径;搬家(.otter → .mr-otto)在这里先做一遍,用户级和工作区级都搬
    configDir(homedir());
    if (workspace) configDir(workspace);
    return withBuiltins(scanSubagents(subagentRoots(homedir(), workspace), known), known);
  };
  // 渲染层传来的 workspace 不可信——它会变成 mkdir + 写文件的落点。
  // 白名单 = 日志里真实存在过的会话围栏。它把可写面收窄到"这个路径至少在会话日志里
  // 出现过"，比直接采信参数强得多；但它**不等于**"用户在原生目录选择器里亲手指过
  // 这个目录"：startSession 只校验了 `typeof workspace === "string" && workspace !== ""`，
  // 既不验来源、也不验存在性，所以任何能调到 startSession 的渲染层都能往白名单里
  // 塞一条自己编的路径。要真正堵死，得在 startSession 那侧校验来源——不在这次范围内。
  const known = () => store.sessions().map((s) => s.workspace);
  /** 读路径：认不出就降级成用户级（只影响界面看哪一层） */
  const trusted = (workspace: unknown) => trustedWorkspace(workspace, known());
  /** 写路径：认不出就抛。降级在这里等于把文件静默写到用户级去（见 trustedWorkspaceForWrite） */
  const trustedForWrite = (workspace: unknown) => trustedWorkspaceForWrite(workspace, known());

  /** 两个记忆文件的当前内容（ADR-0060）。读不到 = 空——"没记过"不是故障。
      同步读：index.ts 是组装根，本来就允许碰 fs（AGENTS.md 的硬规则挡的是工具层）；
      createAgent 是同步的，这份快照必须在调它之前就手上有值 */
  const readMemoryFiles = (): { memory: string; user: string } => {
    const root = configDir(homedir());
    const read = (rel: string): string => {
      try {
        return readFileSync(join(root, rel), "utf8");
      } catch (err) {
        // ENOENT = 没记过，不是故障。别的错误（EACCES 之类）不能装没看见——
        // 那会让"文件在但读不了"呈现成"记忆是空的"（issue #186）。但会话装配
        // 也不该因此挂掉：记下来，快照按空处理
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`读记忆文件 ${rel} 失败（按空快照继续）`, err);
        }
        return "";
      }
    };
    return { memory: read(MEMORY_FILES.memory), user: read(MEMORY_FILES.user) };
  };

  /** applyUserEdit 的 fs 依赖（Task 8）：异步版 readFile/writeFile，配合
      memoryEdit.ts 保持不碰 Electron/fs 的纯函数身份——真正碰盘的活都在这里做 */
  const memoryEditDeps = {
    store,
    readFile: async (rel: string) => {
      try {
        return await readFile(join(configDir(homedir()), rel), "utf8");
      } catch (err) {
        // ENOENT = 没记过。别的错误必须抛（issue #186）：吞掉的话 before 会被
        // 记成空串，writeFile 若碰巧成功，memory_user_edit 的留证就在说谎
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return "";
      }
    },
    writeFile: async (rel: string, c: string) => {
      const abs = join(configDir(homedir()), rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, c, "utf8");
    },
  };

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
        autoCompactSettings: () => loadAutoCompact(autoCompactPath),
        // 挂上 MCP 能力，用不用得着由 config.allowTools 那份白名单说了算
        // （ADR-0054）。活着的那一侧（subagentRunner）从父的 world 实例里继承，
        // 这一侧父可能早就不在内存里了，只能显式给
        mcp: mcpHub,
      });
    }
    // 主会话：能派活。parent() 要拿到"正在构造的这个 agent"，而 createAgent
    // 还没返回——先声明后赋值：parent() 只在派活那一刻被调用（远在这行之后）。
    // 这里不能改成先起个快照，快照会把后续 switchModel 等运行时变化锁死在
    // 创建那一刻的值上
    // 运行时的清单绑定在会话的 workspace 上：工作区级的定义只在本工程的会话里
    // 进得了 task 工具的清单。绑定点放在组装根，SubagentRunner / createTaskTool
    // 的签名一个字不用改——工具那层不需要知道有"作用域"这回事
    const listForSession = () => listSubagents(args.workspace);
    let self: ReturnType<typeof createAgent>;
    self = createAgent({
      ...base,
      // 只有主会话（这条装配路径）才有长期记忆：world 带 config 能力才挂得上
      // memory 工具；memory 快照只在新 session 落盘（resume 时 agent.ts 内部
      // 按 resumeSessionId 忽略它——日志里那条才是模型看过的，见 ADR-0060）
      configRoot: configDir(homedir()),
      memory: readMemoryFiles(),
      // 主会话才有历史查询能力（session_search 只在这条装配路径上挂）。
      // self 此刻还没被赋值，但闭包只在 session_search 真被调用那一刻才读
      // self.sessionId——和上面 parent() 闭包同一招（此刻它已经是活的）
      history: createHistoryCapability(store, () => self.sessionId),
      alwaysAllow: () => loadAlwaysAllow(permissionsPath),
      persistAlwaysAllow: (tool) => void addAlwaysAllow(permissionsPath, tool),
      autoCompactSettings: () => loadAutoCompact(autoCompactPath),
      // 长 turn 软告警（issue #283 ⑥）：不拦不停（无步数上限是 DSH 式决定，
      // 兜底是停止键），只把"还在跑、已经烧了很多步"送到不在屏幕前的用户眼前。
      // 同 friendNotifier 的纪律：通知是打断，窗口聚焦（人就在看）时不发
      onLongTurn: (rounds) => {
        if (win.isDestroyed() || win.isFocused() || !Notification.isSupported()) return;
        const n = new Notification({
          title: "Mr Otto 还在干活",
          body: `本轮已连续跑了 ${rounds} 步模型调用，仍在继续。若不符合预期，回来按停止。`,
        });
        n.on("click", () => {
          if (!win.isDestroyed()) {
            win.show();
            win.focus();
          }
        });
        n.show();
      },
      // 子会话也挂 MCP（ADR-0054）：挂载归挂载，能不能用由那份 subagent 定义的
      // 工具白名单逐个点名——没点名就是没有，所以默认行为和"压根不挂"一样。
      // 不自动继承的理由同 ADR-0047 给子 agent 收权：派出去的 agent 没人盯着，
      // 而 MCP server 是第三方代码，接一台新 server 不该悄悄扩大所有子 agent 的权限面。
      // 两条调用点（startSession / resumeSession）都在调这个函数之前
      // await 过 mcpHub.ready()——工具表挂载一次定终身，拼之前必须等到
      mcp: mcpHub,
      listSubagents: listForSession,
      subagentRunner: createSubagentRunner({
        store,
        attachments: attachmentStore,
        push,
        list: listForSession,
        parent: () => ({
          sessionId: self.sessionId,
          workspace: self.workspace,
          world: self.world,
          model: self.model,
          approvalMode: self.approvalMode,
        }),
        getAccessToken,
        alwaysAllow: () => loadAlwaysAllow(permissionsPath),
        autoCompactSettings: () => loadAutoCompact(autoCompactPath),
        // 子 agent 也进注册表：它的 sessionId 从建好那一刻起就是活的，
        // resumeSession 必须查得到它、只切视线而不是另建一个 agent（review C1）
        register: (child) => {
          agents.set(child.sessionId, child);
          spawnedThisRun.add(child.sessionId);
        },
      }),
    });
    return self;
  };

  ipcMain.handle(CHANNELS.boot, () => bootInfo());

  ipcMain.handle(CHANNELS.getWindowFullscreen, () => win.isFullScreen());

  const islandSnapshot = (): IslandBoot => {
    const agent = activeSessionId ? agents.get(activeSessionId) : undefined;
    // 挂着的审批原样补给岛:UIApprover 存的就是 requestFromUI 当初拿到的 (call, tool)。
    // 刻意不补 preview —— 它是异步现算的(buildApprovalPreview 要 world),而岛的
    // 审批卡只用 call 做一行摘要,补一份算不出来的东西不如明确地不给(preview 可选)。
    // fromAgent 同理缺席:这里问的是主 agent 自己的 approver,子 agent 的卡是冒泡来的
    const pending = agent?.approver.pendingRequest();
    return {
      activeSessionId,
      model: agent?.model ?? null,
      running: activeSessionId ? runningSessions.has(activeSessionId) : false,
      pendingApproval:
        pending && activeSessionId ? approvalPayload(activeSessionId, pending.call, pending.tool) : null,
    };
  };
  ipcMain.handle(CHANNELS.setActiveSession, (_e, sessionId: string | null) => {
    activeSessionId = sessionId;
    feedIsland({ kind: "activeSession", boot: islandSnapshot(), now: Date.now() });
  });

  ipcMain.handle(CHANNELS.listSessions, () => store.sessions());

  // 只读地取一个会话的全部事件，不建 agent、不切视图（resumeSession 那一套围栏
  // 重建在这里都不需要）——时间线上的 subagent 卡问一眼子会话的事实(步数/token)
  // 用的是这个通道，不是 resumeSession。
  // 收窄成"只能读子会话"（Task 8 review Important 3）：目标必须带 spawnedBy，
  // 且指回当前正看着的会话——不然这就是一个凭 sessionId 就能读任意会话全文的
  // 静默通道：resumeSession 好歹会切视图，是"看得见"的；这个不会，读了不留痕迹。
  // currentSessionId 是渲染层此刻唯一正当的"我在哪"
  ipcMain.handle(CHANNELS.readSessionEvents, (_e, sessionId: string) => {
    // 授权判据只在第 0 条里——先单行 PK 查询把门守住，过了门才全量读（issue #279）：
    // 被拒的调用不该先付一整个会话的 JSON.parse
    const first = store.window(sessionId, 0, 0)[0];
    if (
      !first ||
      first.type !== "session_created" ||
      !first.spawnedBy ||
      first.spawnedBy.sessionId !== currentSessionId
    ) {
      throw new Error("只能读取当前会话派出的子会话");
    }
    return store.load(sessionId);
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

  ipcMain.handle(CHANNELS.startSession, async (_e, opts: StartSessionOptions): Promise<BootInfo> => {
    if (typeof opts?.workspace !== "string" || !opts.workspace) {
      throw new Error("未选择工程文件夹");
    }
    // 工具表是一次性拼好的（挂载一次定终身）：必须在 createSessionAgent 之前
    // 就知道每台 server 提供了什么，所以这里先 await，agent.ts 里的
    // void opts.mcp?.ready() 只是幂等兜底，不能指望它把 ready 等到位。
    // createSessionAgent 是同步的（它调的 createAgent 就是同步的），
    // 等这件事只能发生在它外面
    await mcpHub.ready();
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

  // 同一个 sessionId 的两次 resume 只真正重建一次（issue #155）。
  // 下面那道 agents.has() 守卫和 agents.set() 之间隔着一个 await（mcpHub.ready()），
  // 不设防的话两次 resume 会双双穿过守卫、各建一个 agent。守卫那条注释里的
  // 不变量（"绝不能顺手再建一个 agent 顶上"）当初是在这段代码还是同步的时候
  // 写的，靠 Node 单线程天然原子；await 一进来就不成立了
  const resumeOnce = singleFlight<string, void>();

  ipcMain.handle(CHANNELS.resumeSession, async (_e, sessionId: string): Promise<BootInfo> => {
    // 已在注册表里（包括正在跑 turn 的）→ 只是把视线切过去，agent 原样活着
    if (!agents.has(sessionId)) {
      await resumeOnce(sessionId, async () => {
        // 恢复 = 重新投影：workspace 从日志第 0 条读回来，
        // 围栏（LocalWorld root）和 system 消息（deriveMessages）随之自动重建。
        const events = store.load(sessionId);
        const first = events[0];
        if (!first || first.type !== "session_created" || !first.workspace) {
          throw new Error(`会话 ${sessionId} 没有记录工程文件夹，无法恢复`);
        }
        // C1 的第二道门：本次运行派出去的子会话，从 register 那一刻起就在 agents 里，
        // 走不到这里；走到这里说明登记那一环漏了。绝不能顺手再建一个 agent 顶上——
        // 第二个 agent 的崩溃修复会给还在飞的工具调用补一条"app 在执行中退出"的假结果，
        // 紧接着真结果也落盘，同一个 toolCallId 两条 tool_result，这个会话从此永久 400。
        //
        // 判据是 spawnedThisRun 而不是"父会话此刻有没有 turn 在跑"（issue #141）：
        // 后者会说假话——重启后点开一张上一轮遗留的子会话卡片、而父会话此刻恰好在跑，
        // 用户会看到"它正在跑"，其实它早停了。上一轮的子会话该走下面的崩溃修复重建
        if (spawnedThisRun.has(sessionId)) {
          throw new Error("这个子会话本次运行里已经建过 agent，重建会毁掉它的日志——重启应用后再看");
        }
        // 是子会话就按它当初那副装备重建（工具白名单 / 审批链 / 没有 task）
        const child = childAgentConfig(events);
        // 同 startSession：工具表挂载一次定终身，拼之前必须等 ready。
        // 排在上面那两道门之后——它们该抛就抛，没必要先等一轮握手
        await mcpHub.ready();
        agents.set(
          sessionId,
          createSessionAgent({
            workspace: first.workspace,
            resumeSessionId: sessionId,
            ...(child ? { child } : {}),
          })
        );
      });
    }
    currentSessionId = sessionId;
    const info = bootInfo();
    if (!info) throw new Error("恢复会话失败"); // 理论不可达，让 TS 安心
    return info;
  });

  // skill 根目录：Mr Otto 自己的排前（同名覆盖优先），其后兼容 Claude Code 的安装位
  const skillRoots = [join(configDir(homedir()), "skills"), join(homedir(), ".claude", "skills")];

  ipcMain.handle(CHANNELS.listSkills, () => scanSkills(skillRoots));

  // ── 记忆（设置页读/改，Task 8）────────────────────────────────────
  ipcMain.handle(CHANNELS.getMemory, () => readMemoryFiles());
  ipcMain.handle(CHANNELS.saveMemory, (_e, target: MemoryTarget, text: string, sessionId?: string) =>
    applyUserEdit(memoryEditDeps, target, text, sessionId));
  // 索引是 events 的派生物，rebuildFts 幂等重灌（issue #190：索引损坏时的修复入口）
  ipcMain.handle(CHANNELS.rebuildSearchIndex, () => store.rebuildFts());
  // 设置页的试搜框。不排除当前会话（用户验证「索引里有没有」，不是模型回忆）；
  // tool_result 能有上万字符，截断后再过 IPC
  ipcMain.handle(CHANNELS.searchIndex, (_e, query: unknown) => {
    if (typeof query !== "string") throw new Error("query 必须是字符串");
    return store
      .searchText(query, { limit: 20 })
      .map((h) => ({ ...h, text: [...h.text].length > 200 ? [...h.text].slice(0, 200).join("") + "…" : h.text }));
  });
  ipcMain.handle(CHANNELS.forgetMemory, async (_e, target: MemoryTarget, entry: string, sessionId: string) => {
    // IPC 入参不直接信（issue #186）：applyUserEdit 入口有同款守卫，但这里先用
    // MEMORY_FILES[target] 拼了路径，得在拼之前挡
    if (!isMemoryTarget(target)) throw new Error(`target 只能是 memory 或 user，收到 ${String(target)}`);
    const cur = parseEntries(await memoryEditDeps.readFile(MEMORY_FILES[target]));
    await applyUserEdit(memoryEditDeps, target, formatEntries(cur.filter((x) => x !== entry)), sessionId);
  });

  // ── 自动压缩设置（设置页读/改）────────────────────────────────────
  ipcMain.handle(CHANNELS.getAutoCompact, () => loadAutoCompact(autoCompactPath));
  ipcMain.handle(CHANNELS.setAutoCompact, (_e, settings: AutoCompactSettings) =>
    saveAutoCompact(autoCompactPath, settings));
  ipcMain.handle(CHANNELS.getHelperModel, () => helperModel());
  ipcMain.handle(CHANNELS.setHelperModel, (_e, model: unknown) =>
    saveHelperModel(helperModelPath, model));
  ipcMain.handle(CHANNELS.getVisionModel, () => visionModel());
  ipcMain.handle(CHANNELS.setVisionModel, (_e, model: unknown) =>
    saveVisionModel(visionModelPath, model));
  // 灵动岛设置(#199):normalise 在 store 层做(渲染层传什么不直接信),
  // set 完立刻重推岛快照——切换即时生效,不等下一个事件
  ipcMain.handle(CHANNELS.getIslandSettings, () => islandSettings);
  ipcMain.handle(CHANNELS.setIslandSettings, (_e, settings: IslandSettings) => {
    islandSettings = normaliseIslandSettings(settings);
    saveIslandSettings(islandSettingsPath, islandSettings);
    islandUsageCache = null; // 切换瞬间给最新数,别端上一份 30s 前的缓存
    pushFleet();
  });

  // ── OTA 更新（ADR-0075；win 席位 ADR-0081）──────────────────────
  // 打包的 mac / win 版才启用：开发模式没有可换的安装，查了也白查。
  // 节奏（issue #322，推翻 #316 的「停在 available 等点击」）：
  // 启动 30s 后一次（别挤开冷启动关键路径）+ 每 30min 一次 + 窗口 focus
  // 触发（节流 10min——「发完版切回 app」就能撞上，不用等定时器）；
  // 查到新版直接自动下载，卡片带着进度自己弹出来。
  // checkNow 内部有互斥，定时器 / focus / 设置页按钮撞上也只跑一轮
  const updater =
    (process.platform === "darwin" || process.platform === "win32") && app.isPackaged
      ? createUpdater(createUpdaterHostDeps((s) => send(CHANNELS.updaterState, s)))
      : null;
  const updaterDisabled: UpdaterState = {
    phase: "disabled",
    currentVersion: app.getVersion(),
    reason: app.isPackaged ? "仅支持 macOS 与 Windows" : "开发模式不检查更新",
  };
  ipcMain.handle(CHANNELS.updaterGetState, () => updater?.getState() ?? updaterDisabled);
  // 手动检测也串自动下载（issue #322）：available 一律是过渡态，查到就下
  ipcMain.handle(CHANNELS.updaterCheckNow, async () => {
    if (updater === null) return updaterDisabled;
    const s = await updater.checkNow();
    if (s.phase === "available") void updater.startDownload();
    return s;
  });
  ipcMain.handle(CHANNELS.updaterStartDownload, () => updater?.startDownload() ?? updaterDisabled);
  ipcMain.handle(CHANNELS.updaterInstallAndRestart, () => updater?.installAndRestart());
  ipcMain.handle(CHANNELS.updaterOpenReleasePage, () => shell.openExternal(RELEASES_PAGE_URL));
  if (updater !== null) {
    let lastAutoCheckAt = 0;
    const autoCheck = async () => {
      lastAutoCheckAt = Date.now();
      const s = await updater.checkNow();
      if (s.phase === "available") void updater.startDownload();
    };
    setTimeout(() => void autoCheck(), 30_000);
    setInterval(() => void autoCheck(), 30 * 60 * 1000);
    win.on("focus", () => {
      if (Date.now() - lastAutoCheckAt >= 10 * 60 * 1000) void autoCheck();
    });
  }

  // ── MCP ─────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.listMcpServers, (): McpServersSnapshot => mcpSnapshot());
  ipcMain.handle(CHANNELS.saveMcpServer, async (_e, id: string, cfg: McpServerConfig): Promise<McpServersSnapshot> => {
    await mcpHub.save(id, cfg);
    return mcpSnapshot();
  });
  ipcMain.handle(CHANNELS.removeMcpServer, async (_e, id: string): Promise<McpServersSnapshot> => {
    await mcpHub.remove(id);
    return mcpSnapshot();
  });
  ipcMain.handle(CHANNELS.reconnectMcpServer, async (_e, id: string): Promise<McpServersSnapshot> => {
    await mcpHub.reconnect(id);
    return mcpSnapshot();
  });
  ipcMain.handle(CHANNELS.listMcpPrompts, () =>
    mcpHub.servers().filter((s) => s.live).flatMap((s) => s.prompts.map((p) => ({ ...p, server: s.name })))
  );
  ipcMain.handle(
    CHANNELS.expandMcpPrompt,
    (_e, server: string, name: string, args: Record<string, string>) => {
      const hit = mcpHub.servers().find((s) => s.live && s.name === server);
      if (!hit) throw new Error(`没有连上名叫「${server}」的 MCP server`);
      return mcpHub.getPrompt(hit.id, name, args);
    }
  );

  // 工具目录（issue #141）：与 BootInfo.toolDefs 同源、但不需要会话。
  // 每次现装一条探针而不是缓存：MCP server 会连上/掉线/改清单，缓存会让
  // 设置页的勾选框停在开机那一刻。代价是一次内存库 + 一次装配，
  // 只发生在用户打开子智能体设置页的时候
  ipcMain.handle(CHANNELS.toolCatalog, async (): Promise<ToolDefinition[]> => {
    // 先等握手：mcp 工具是"挂载一次定终身"，装配之前 server 没连上就一把都不挂
    await mcpHub.ready();
    // task 过滤掉：子 agent 不能再派子 agent（main/subagents.ts 解析时也剔）。
    // 这条探针本来就没有 subagentRunner、装不出 task，留着这句是写给下一个人看的
    return probeToolDefs(mcpHub).filter((d) => d.name !== "task");
  });
  ipcMain.handle(CHANNELS.listSubagents, (_e, workspace: unknown) =>
    listSubagents(trusted(workspace))
  );

  // 两个写盘动作的本体在 subagentWrites.ts（issue #146）：handler 里只剩接线，
  // 不变量和它们的测试住在一起
  const subagentWriteDeps: SubagentWriteDeps = {
    listSubagents,
    trustedForWrite,
    roots: (ws) => subagentRoots(homedir(), ws),
    slotTaken: (root, name) => subagentSlotTaken(root, name, TOOL_NAMES),
    write: (def) => writeSubagent(def),
    join,
  };

  // 写完推一次工具表：清单从空变成有人，task 工具的 available() 当场翻面
  // （见 agent.ts 的 toolDefs getter），渲染层那份镜像得跟着动
  ipcMain.handle(CHANNELS.saveSubagent, (_e, def: SubagentDef, workspace: unknown) => {
    const list = saveSubagentDef(subagentWriteDeps, def, workspace);
    sendToolDefs();
    return list;
  });

  ipcMain.handle(CHANNELS.createSubagent, (_e, name: string, workspace: unknown) => {
    const list = createSubagentDef(subagentWriteDeps, name, workspace);
    sendToolDefs();
    return list;
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

  // 好友分支在场(issue #167):渲染层报当前会话的工作区,这里盯 HEAD、算 repoKey/分支,
  // 交 FriendsManager 两条腿广播。路径按 known() 校验——虽然这条只读 git 不写盘,
  // 也不让渲染层指挥主进程去任意目录跑 git(同 subagent 那条防线的口径)
  const workspacePresence = createWorkspacePresence((ws) => friends.setWorkspace(ws), {
    workspace: (dir) => gitGraph.workspace(dir),
    gitDir: (dir) => gitGraph.gitDir(dir),
  });
  ipcMain.handle(CHANNELS.setPresenceWorkspace, (_e, repoDir: unknown) => {
    const dir = typeof repoDir === "string" && repoDir !== "" && known().includes(repoDir) ? repoDir : null;
    workspacePresence.setRepoDir(dir);
  });
  // 重新聚焦窗口时对一次账:用户可能在终端里切了分支,fs.watch 没报也能追上
  win.on("focus", () => workspacePresence.refresh());

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
  ipcMain.handle(CHANNELS.browserPickElement, (_e, sessionId: string) => browsers.pickElement(sessionId));
  ipcMain.handle(CHANNELS.browserCancelPick, (_e, sessionId: string) => browsers.cancelPick(sessionId));

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
  ipcMain.handle(CHANNELS.friendsSearch, (_e, query: string) => friends.search(query));
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
    if (!key) {
      delete process.env[envName]; // 清除时 applyToEnv 不会删，补一刀
      unmarkSecretEnv(envName); // 已经不是凭据了，再登记着只会白白从子进程里摘掉一个普通变量
    }
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
      islandStates.delete(id); // 岛的 Map 投影也剪掉——不然拍平出来的 fleet 会带一行死会话
    }
    if (currentSessionId === sessionId) currentSessionId = null; // 渲染层据此回欢迎页
    fleetSessionsCache = null; // purge 不走事件流,缓存不会自己失效——当场清
    pushFleet(); // store.sessions() 已经不含被删的会话,重推让岛上的行跟着掉
  });

  ipcMain.handle(CHANNELS.renameSession, (_e, sessionId: string, title: string) => {
    const t = title.trim();
    if (!t) throw new Error("标题不能为空（用法：/rename 新标题）");
    if (!store.has(sessionId)) throw new Error("会话不存在"); // 别给幽灵会话开日志
    // 改名不碰 agent、不限 turn 状态：纯追加一条事件，投影层自然换标题
    const appended = store.append({ sessionId, ts: Date.now(), type: "session_renamed", title: t });
    send(CHANNELS.event, appended); // 时间线同款直播通道
    fleetSessionsCache = null; // 这条路不走 push.event,缓存不会自己失效
    pushFleet(); // 岛上的行标题立即换,不等下一个事件
  });

  ipcMain.handle(CHANNELS.switchModel, (_e, model: string, lane?: ModelLane) => {
    const agent = currentSessionId ? agents.get(currentSessionId) : undefined;
    if (!agent) throw new Error("还没有会话");
    if (runningSessions.has(agent.sessionId)) throw new Error("turn 进行中不能换模型");
    agent.switchModel(model, lane ?? "auto");
    // 换模型也是"活跃会话的快照变了"——同 setActiveSession,喂一次投影器,
    // 岛上挂着的模型名跟着换
    feedIsland({ kind: "activeSession", boot: islandSnapshot(), now: Date.now() });
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

  // 抽成命名函数:ipc handler 和 handleIslandCommand("send" 命令)都调它,
  // 逻辑只有一份——岛上发消息和主窗输入框发消息必须走同一条路(含附件校验/
  // vision-bridge/分区分类),不能有第二套实现悄悄 drift
  async function handleSendMessage(
    sessionId: string,
    text: string,
    skill?: string,
    attachments?: OutgoingAttachment[],
    skillArgs?: string
  ): Promise<void> {
    const agent = agents.get(sessionId);
    if (!agent) throw new Error("会话不存在或未激活");
    if (runningSessions.has(sessionId)) throw new Error("该会话上一个 turn 还在跑");
    // skill 先解析再落盘：发送时刻现读 SKILL.md 做快照（不是列表页那份陈旧拷贝）。
    // 找不到就整条拒发——不静默降级成"没有 skill 的普通消息"。
    // skillArgs 与附件同理是渲染层送来的不可信输入：非字符串会原样进 append-only
    // 日志且改不了，宁可拒发（形状把关先于任何 append，坏请求零痕迹）
    if (skillArgs !== undefined && typeof skillArgs !== "string") {
      throw new Error("skill 参数形状非法(渲染层送来的 skillArgs 不是字符串)");
    }
    let invoked: { name: string; content: string; args?: string } | null = null;
    if (skill) {
      const found = scanSkills(skillRoots).find((s) => s.name === skill);
      if (!found) throw new Error(`skill 不存在: ${skill}`);
      invoked = { name: found.name, content: found.content, ...(skillArgs ? { args: skillArgs } : {}) };
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
    feedIsland({ kind: "turnStatus", update: { sessionId, status: "running" }, now: Date.now() });
    // runTurn 抛错时走不到下面（整个 sendMessage 一起抛），所以这个初值只是让
    // TS 安心；真正的取值只有 runTurn 的返回
    let outcome: "completed" | "aborted" = "aborted";
    try {
      // vision-bridge：当前模型没眼睛而消息带图 → 先请视觉款代读成文字。
      // 解析出自模型且随后就喂给当前模型（model-visible means logged）→ 必须
      // 落事件；位置在 user_message 之前，投影读起来是"先解析、后问题"。
      // 代读失败（无 key/限流/断网）＝ turn 失败，事件一条不落——不静默降级成
      // "模型看不见图还装看过"
      // 代读拿到的文本 = 模型将看到的同一份全文(正文+文件),口径一致
      //
      // 调用先于任何 append（issue #283 ⑦）：skill_invoked 若先落、代读再失败，
      // 日志里就留下一条没有任务跟随的孤儿 skill 事件——而台账语义是"启用过=
      // 永久生效"（ADR-0066），append-only 日志又收不回。先把会失败的外呼做完，
      // 全成了再按原序落盘，失败一条不落
      const modelText = composeUserText(text, textFiles);
      let described: { content: string; model: string } | null = null;
      if (refs.length > 0 && !(describeModel(agent.model)?.supportsVision ?? false)) {
        // 代读员型号现读设置（改了对下一条带图消息生效）；事件里记的必须是
        // 真正代读的那一款，不是常量
        const bridgeModel = visionModel();
        const describeImages = createVisionBridge((id) => attachmentStore.read(id), undefined, bridgeModel);
        described = { content: await describeImages(refs, modelText), model: bridgeModel };
      }
      if (invoked) {
        // 快照落在 user_message 之前：模型先看到说明书，再看到任务
        const fullEvent = store.append({ sessionId, ts: Date.now(), type: "skill_invoked", ...invoked });
        send(CHANNELS.event, fullEvent);
      }
      if (described) {
        // 紧贴 user_message 之前（barrenTurns 按 events[i-1] 认领它，中间不能夹别的）
        const descEvent = store.append({
          sessionId, ts: Date.now(), type: "image_described",
          content: described.content, model: described.model,
        });
        send(CHANNELS.event, descEvent);
      }
      outcome = await agent.engine.runTurn(text, refs, textFiles);
    } catch (err) {
      // 任务失败通知(#336):失败比完成更该把人叫回来。aborted 不进这里
      // (runTurn 把中断吞成返回值),vision-bridge 代读失败也算 turn 失败,一并覆盖。
      // 通知完原样上抛——落盘/报错链路不动
      notify(turnFailedNotification(
        store.titleOf(sessionId),
        err instanceof Error ? err.message : String(err),
        sessionId
      ));
      throw err;
    } finally {
      runningSessions.delete(sessionId);
      send(CHANNELS.turnStatus, { sessionId, status: "idle" });
      feedIsland({ kind: "turnStatus", update: { sessionId, status: "idle" }, now: Date.now() });
    }
    // 分区分类：turn 收口后跑一次便宜模型，判断话题是否换了（会话目录用）。
    // 位置与 vision-bridge 对称——那个在 turn 前，这个在 turn 后，都在 engine 外面。
    // runTurn 抛错时根本走不到这（失败的 turn 不值得分区）。
    // 刻意排在 finally 外面：分类是又一次完整往返，答案早就渲染完了，
    // 让它压着 turn 锁 = 用户在那几秒里发不出消息、换不了模型、删不掉会话——
    // 那不是转圈，是硬锁输入。放开锁再排队，串行由 sectionQueues 保证
    // 用户按了停止就别再起新的模型调用。半截对话确实也是对话，但停止键的契约
    // 是"停"——在它之后自作主张再烧一次配额，是把契约让位给了目录的完整性。
    // outcome 由 runTurn 直接给（issue #112）：原来是在这里做一次全量 store.load
    // + 倒着找最后一条 turn_ended，把 engine 早一帧就知道的事实又推导了一遍——
    // 每个 turn 一次、同步跑在主进程，长会话上是白读整份日志
    if (outcome === "completed") {
      // 任务完成通知(issue #290):notify 内部自带"窗口聚焦不打扰"判定(ADR-0027),
      // 人在屏幕前时答案已经渲染出来了,不必再弹。aborted 不通知——停止是用户自己按的。
      // titleOf 是单条 SQL 投影,不是全量 load
      notify(turnCompleteNotification(store.titleOf(sessionId), text, sessionId));
      // 分区分类 + 跟进建议合并成一次调用（issue #284），串行由 sectionQueues 保证
      enqueueAnnotate(sessionId);
      // 记忆审查同理：只在正常收口后跑，且自己内部已经挡了子会话（nudgeMemory 开头的 spawnedBy 判定）
      // 和已被 purge 的会话（agents.has），这里只需要同款兜底不让它毒死主进程
      void nudgeMemory(sessionId).catch((err) => console.error("记忆审查失败", err));
      // 微压缩同理：只在正常收口后跑；自己内部读设置，关着就立刻返回
      enqueueMicroCompact(sessionId);
    }
  }

  ipcMain.handle(
    CHANNELS.sendMessage,
    (
      _e,
      sessionId: string,
      text: string,
      skill?: string,
      attachments?: OutgoingAttachment[],
      skillArgs?: string
    ) => handleSendMessage(sessionId, text, skill, attachments, skillArgs)
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
    // compact 也是一次真实的 turn 状态变化——旧岛窗(单进程内共享 IPC 推送)本就
    // 会收到这条,喂投影器保持同样的观感,不因这次重接线悄悄丢一种状态
    feedIsland({ kind: "turnStatus", update: { sessionId, status: "running" }, now: Date.now() });
    try {
      await agent.engine.compact();
    } finally {
      runningSessions.delete(sessionId);
      send(CHANNELS.turnStatus, { sessionId, status: "idle" });
      feedIsland({ kind: "turnStatus", update: { sessionId, status: "idle" }, now: Date.now() });
    }
  });

  // 抽成命名函数，同 handleSendMessage 的理由：ipc handler 和 handleIslandCommand
  // ("approve"/"deny" 命令)都调它。声明成 async 是为了给 handleIslandCommand 一个
  // 统一的 Promise 接口好挂 .catch()——函数体本身仍是同步的，返回的 Promise 不会
  // 真的 reject，除非 agent.grant / approver.resolve 意外抛出
  async function handleDecideApproval(
    sessionId: string,
    toolCallId: string,
    incoming: ApprovalDecisionOutcome
  ): Promise<void> {
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
      // revisedArgs 一起递过去：授权 key 从实际执行的参数算（issue #342）
      agent.grant(toolCallId, incoming.grant, incoming.revisedArgs);
    }
    agent.approver.resolve(toolCallId, outcome);
  }

  ipcMain.handle(
    CHANNELS.decideApproval,
    (_e, sessionId: string, toolCallId: string, incoming: ApprovalDecisionOutcome) =>
      handleDecideApproval(sessionId, toolCallId, incoming)
  );

  // 岛发来的命令（stdio 桥的另一半）：ready 补一次快照,send/approve/deny 复用
  // 上面两个命名函数——发消息/审批这两条路,不管是主窗输入框还是岛,只走一份逻辑
  function handleIslandCommand(c: IslandCommand): void {
    if (c.type === "ready") {
      // helper 起来了:把当前 fleet 补推一次(等价旧 islandBoot)
      pushFleet();
      return;
    }
    if (c.type === "send") {
      void handleSendMessage(c.sessionId, c.text).catch((e) => console.warn("岛发消息失败", e));
      return;
    }
    if (c.type === "focusSession") {
      // 点岛上的会话行 = "我要看这个会话"(#210):掀主窗 + 让渲染层切过去
      // (切会话是渲染层的事——store.resume 那条路带侧栏刷新/事件回放,主进程不重造)
      if (!win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        send(CHANNELS.islandFocusSession, c.sessionId);
      }
      return;
    }
    const outcome =
      c.type === "approve"
        ? { decision: "approved" as const, ...(c.grant ? { grant: c.grant } : {}) }
        : { decision: "denied" as const };
    void handleDecideApproval(c.sessionId, c.callId, outcome).catch((e) => console.warn("岛审批失败", e));
  }

  ipcMain.handle(
    CHANNELS.answerQuestions,
    (_e, sessionId: string, toolCallId: string, outcome: AskUserOutcome) => {
      agents.get(sessionId)?.answerQuestions(toolCallId, outcome);
    }
  );

  app.on("before-quit", () => {
    quitting = true; // 放行 createWindow 里那道 close 拦截 —— 这次是真要退
    bridge?.dispose(); // stdio 桥收掉;helper 子进程跟着退出
    terminals.killAll(); // 孤儿 dev server 会占着端口而没人知道是谁占的
    browsers.closeAll(); // 窗口没了,挂在它 contentView 上的 view 全部收掉
    // stdio server 是子进程,退出时得跟着收掉:closeAll() 虽然是 async 函数,
    // 但 kill() 那一段是它函数体里第一个 await 之前的同步代码,这里一调用
    // 就已经跑完(不依赖谁去 await 这个 promise)。之前只调 close() 的版本
    // 是幂等噪音——SDK 的优雅关闭全靠两个 2s 定时器,before-quit 一返回
    // Electron 就继续退出流程,那两个定时器永远没机会触发,子进程变孤儿
    // (review finding 1;kill() 的同步保证见 mcpClient.ts / mcpHub.ts 的注释)
    void mcpHub.closeAll();
    store.close();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 主窗被 Cmd+W 藏起来之后,点 dock 图标是把它叫回来的那条路(mac 惯例)。
// 没有这一条,藏起来的窗就再也没有入口了 —— 只剩一个岛在屏幕顶上(#175 I5)
app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
});
