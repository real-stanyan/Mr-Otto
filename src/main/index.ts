// 主进程 — Electron 接线层：开窗、IPC 应答、把 agent 的推送接到 webContents。
// agent 懒加载：用户选完工程文件夹（startSession）才组装，选之前 boot 返回 null。

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import {
  CHANNELS,
  type BootInfo,
  type StartSessionOptions,
  type OutgoingAttachment,
} from "../shared/shellBridge.js";
import { createAgent, loadDotEnv, type AgentPush } from "./agent.js";
import { EventStore } from "../session/store.js";
import { AttachmentStore, detectImageType } from "../session/attachments.js";
import type { UserAttachmentRef } from "../session/events.js";
import { intakeFile } from "./attachmentIntake.js";
import { loadKeys, saveKey, applyToEnv } from "./keyVault.js";
import { scanSkills } from "./skills.js";
import { MODEL_CATALOG } from "../shared/modelCatalog.js";
import type { ApprovalOutcome } from "../loop/approvalGate.js";
import { AccountManager, createSupabaseAuthClient } from "./account.js";

// mrotto:// 深链：注册 + open-url 监听必须在 app ready 前完成——macOS 冷启动时
// 深链事件可能在 ready 之前就到达。AccountManager 要等 ready 后（依赖 app.getPath）
// 才能实例化，中间这段空档收到的 URL 先缓存，ready 后 flush。
app.setAsDefaultProtocolClient("mrotto");

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
  loadDotEnv((p) => readFileSync(p, "utf8"), join(process.cwd(), ".env"));
  // 设置页存的 key 后加载 = 覆盖 .env（用户最新意志优先）
  const keyVaultPath = join(app.getPath("userData"), "keys.json");
  applyToEnv(loadKeys(keyVaultPath), process.env);

  const win = createWindow();
  mainWindow = win;

  // 固定接线形态（Task 6 裁定，见 account.ts 顶部注释）：openExternal 走系统浏览器，
  // onChange 推 accountChanged 事件，client 是真 supabase client（authStorage 落盘于 userData）
  accountManager = new AccountManager({
    openExternal: (url) => shell.openExternal(url),
    onChange: (info) => win.webContents.send(CHANNELS.accountChanged, info),
    client: createSupabaseAuthClient(join(app.getPath("userData"), "auth.json")),
  });
  const manager = accountManager;
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
          maxSteps: agent.maxSteps,
        }
      : null;
  };

  // 所有 agent 共用同一份推送接线；靠消息里的 sessionId 区分来源
  const push: AgentPush = {
    event: (e) => win.webContents.send(CHANNELS.event, e),
    approvalRequest: (sessionId, call, tool, preview) =>
      win.webContents.send(CHANNELS.approvalRequest, {
        sessionId,
        call,
        toolDescription: tool.def.description,
        ...(preview ? { preview } : {}),
      }),
    assistantDelta: (sessionId, text, kind) =>
      win.webContents.send(CHANNELS.assistantDelta, { sessionId, text, kind }),
    toolOutput: (sessionId, toolCallId, chunk, stream) =>
      win.webContents.send(CHANNELS.toolOutput, { sessionId, toolCallId, chunk, stream }),
  };

  ipcMain.handle(CHANNELS.boot, () => bootInfo());

  ipcMain.handle(CHANNELS.listSessions, () => store.sessions());

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
    const agent = createAgent({ store, workspace: opts.workspace, push, attachments: attachmentStore });
    agents.set(agent.sessionId, agent);
    currentSessionId = agent.sessionId;
    // 开局偏好复用运行时切换的既有通道：model 落 model_changed（resume 记得，
    // 与默认相同时 switchModel 内部 no-op，零多余事件）；审批/thinking 是运行时偏好
    if (opts.model) agent.switchModel(opts.model);
    if (opts.approvalMode === "ask" || opts.approvalMode === "auto") {
      agent.setApprovalMode(opts.approvalMode);
    }
    if (typeof opts.thinking === "boolean" && opts.thinking !== agent.thinking) {
      agent.setThinking(opts.thinking);
    }
    const info = bootInfo();
    if (!info) throw new Error("创建会话失败"); // 理论不可达，让 TS 安心
    return info;
  });

  ipcMain.handle(CHANNELS.resumeSession, (_e, sessionId: string): BootInfo => {
    // 已在注册表里（包括正在跑 turn 的）→ 只是把视线切过去，agent 原样活着
    if (!agents.has(sessionId)) {
      // 恢复 = 重新投影：workspace 从日志第 0 条读回来，
      // 围栏（LocalWorld root）和 system 消息（deriveMessages）随之自动重建。
      const first = store.load(sessionId)[0];
      if (!first || first.type !== "session_created" || !first.workspace) {
        throw new Error(`会话 ${sessionId} 没有记录工程文件夹，无法恢复`);
      }
      agents.set(
        sessionId,
        createAgent({
          store,
          workspace: first.workspace,
          push,
          resumeSessionId: sessionId,
          attachments: attachmentStore,
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

  // 安全硬约束：只回 AccountInfo 四字段，token/session 对象永不过 IPC
  ipcMain.handle(CHANNELS.getAccount, () => manager.getAccount());
  // signIn/handleCallback 失败会 throw——这里不吞，让 invoke 自然 reject（渲染层 Task 7 接）
  ipcMain.handle(CHANNELS.signIn, (_e, provider: "google" | "github") => manager.signIn(provider));
  ipcMain.handle(CHANNELS.signOut, () => manager.signOut());

  // 白名单：渲染层只能配目录里声明过的 key 变量，不然被攻破的渲染进程能改任意 env
  const allowedKeyEnvs = new Set(MODEL_CATALOG.map((m) => m.apiKeyEnv));

  ipcMain.handle(CHANNELS.keyStatus, (): Record<string, boolean> => {
    const status: Record<string, boolean> = {};
    for (const env of allowedKeyEnvs) status[env] = Boolean(process.env[env]);
    return status; // 只有布尔——key 本体永远不过这座桥
  });

  ipcMain.handle(CHANNELS.setApiKey, (_e, envName: string, key: string) => {
    if (!allowedKeyEnvs.has(envName)) throw new Error(`不认识的 key 变量: ${envName}`);
    applyToEnv(saveKey(keyVaultPath, envName, key), process.env);
    if (!key) delete process.env[envName]; // 清除时 applyToEnv 不会删，补一刀
    for (const a of agents.values()) a.reloadAdapter(); // 所有活 agent 的 adapter 都捏着旧 key
  });

  ipcMain.handle(CHANNELS.deleteSession, (_e, sessionId: string) => {
    if (runningSessions.has(sessionId)) throw new Error("turn 进行中不能删除会话");
    // 删除 = 整会话物理抹除（ADR-0002）。用户点删就是要它从库里消失，不可逆。
    store.purge(sessionId);
    agents.delete(sessionId); // 注册表里的活 agent 一并注销（空闲状态，无挂起可丢）
    if (currentSessionId === sessionId) currentSessionId = null; // 渲染层据此回欢迎页
  });

  ipcMain.handle(CHANNELS.renameSession, (_e, sessionId: string, title: string) => {
    const t = title.trim();
    if (!t) throw new Error("标题不能为空（用法：/rename 新标题）");
    if (store.load(sessionId).length === 0) throw new Error("会话不存在"); // 别给幽灵会话开日志
    // 改名不碰 agent、不限 turn 状态：纯追加一条事件，投影层自然换标题
    const appended = store.append({ sessionId, ts: Date.now(), type: "session_renamed", title: t });
    win.webContents.send(CHANNELS.event, appended); // 时间线同款直播通道
  });

  ipcMain.handle(CHANNELS.switchModel, (_e, model: string) => {
    const agent = currentSessionId ? agents.get(currentSessionId) : undefined;
    if (!agent) throw new Error("还没有会话");
    if (runningSessions.has(agent.sessionId)) throw new Error("turn 进行中不能换模型");
    agent.switchModel(model);
  });

  ipcMain.handle(CHANNELS.setApprovalMode, (_e, sessionId: string, mode: "ask" | "auto") => {
    const agent = agents.get(sessionId);
    if (!agent) throw new Error("会话不存在或未激活");
    // turn 进行中也允许：auto 切 ask 是"踩刹车"，必须随时可踩
    agent.setApprovalMode(mode);
  });

  ipcMain.handle(CHANNELS.setThinking, (_e, sessionId: string, on: boolean) => {
    const agent = agents.get(sessionId);
    if (!agent) throw new Error("会话不存在或未激活");
    if (runningSessions.has(sessionId)) throw new Error("turn 进行中不能切 thinking");
    agent.setThinking(on);
  });

  ipcMain.handle(CHANNELS.setMaxSteps, (_e, sessionId: string, n: number) => {
    const agent = agents.get(sessionId);
    if (!agent) throw new Error("会话不存在或未激活");
    // 参数出自渲染层输入框，边界在这把关（engine 信任组装根）
    if (!Number.isInteger(n) || n < 1 || n > 64) {
      throw new Error("步数上限须为 1–64 的整数（用法：/steps 16）");
    }
    // turn 进行中也允许：调低是"踩刹车"，loop 每圈现读、当圈生效
    agent.setMaxSteps(n);
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
      // 文本文件内联进 content(快照语义,同 skill_invoked:日志自包含,原文件
      // 后续改/删不影响重放);图片只走 ref。二者都在落盘前拼好——先落盘再喂模型
      let full = text;
      const refs: UserAttachmentRef[] = [];
      for (const a of attachments ?? []) {
        if (a.kind === "text") full += `\n\n[用户附上文件「${a.name}」,内容如下]\n${a.content}`;
        else refs.push(a.ref);
      }
      runningSessions.add(sessionId);
      win.webContents.send(CHANNELS.turnStatus, { sessionId, status: "running" });
      try {
        if (invoked) {
          // 快照落在 user_message 之前：模型先看到说明书，再看到任务
          const fullEvent = store.append({ sessionId, ts: Date.now(), type: "skill_invoked", ...invoked });
          win.webContents.send(CHANNELS.event, fullEvent);
        }
        await agent.engine.runTurn(full, refs);
      } finally {
        runningSessions.delete(sessionId);
        win.webContents.send(CHANNELS.turnStatus, { sessionId, status: "idle" });
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
    return picked.filePaths.map((p) => intakeFile(p, readFileSync(p), attachmentStore));
  });

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
    win.webContents.send(CHANNELS.turnStatus, { sessionId, status: "running" });
    try {
      await agent.engine.compact();
    } finally {
      runningSessions.delete(sessionId);
      win.webContents.send(CHANNELS.turnStatus, { sessionId, status: "idle" });
    }
  });

  ipcMain.handle(
    CHANNELS.decideApproval,
    (_e, sessionId: string, toolCallId: string, decision: "approved" | "denied", reason?: string) => {
      const outcome: ApprovalOutcome = { decision, ...(reason ? { reason } : {}) };
      agents.get(sessionId)?.approver.resolve(toolCallId, outcome);
    }
  );

  app.on("before-quit", () => store.close());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
