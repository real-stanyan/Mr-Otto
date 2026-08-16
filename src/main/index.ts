// 主进程 — Electron 接线层：开窗、IPC 应答、把 agent 的推送接到 webContents。
// agent 懒加载：用户选完工程文件夹（startSession）才组装，选之前 boot 返回 null。

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CHANNELS, type BootInfo } from "../shared/shellBridge.js";
import { createAgent, loadDotEnv, type AgentPush } from "./agent.js";
import { EventStore } from "../session/store.js";
import { loadKeys, saveKey, applyToEnv } from "./keyVault.js";
import { MODEL_CATALOG } from "../shared/modelCatalog.js";
import type { ApprovalOutcome } from "../loop/approvalGate.js";

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "otter",
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
  const dbPath = join(app.getPath("userData"), "sessions.db");
  // store 是 app 级资源：欢迎页列会话时 agent 还不存在，库必须先开着
  const store = new EventStore(dbPath);

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
        }
      : null;
  };

  // 所有 agent 共用同一份推送接线；靠消息里的 sessionId 区分来源
  const push: AgentPush = {
    event: (e) => win.webContents.send(CHANNELS.event, e),
    approvalRequest: (sessionId, call, tool) =>
      win.webContents.send(CHANNELS.approvalRequest, {
        sessionId,
        call,
        toolDescription: tool.def.description,
      }),
    assistantDelta: (sessionId, text, kind) =>
      win.webContents.send(CHANNELS.assistantDelta, { sessionId, text, kind }),
  };

  ipcMain.handle(CHANNELS.boot, () => bootInfo());

  ipcMain.handle(CHANNELS.listSessions, () => store.sessions());

  ipcMain.handle(CHANNELS.startSession, async (): Promise<BootInfo | null> => {
    const picked = await dialog.showOpenDialog(win, {
      title: "选择工程文件夹",
      buttonLabel: "在此开始会话",
      properties: ["openDirectory", "createDirectory"],
    });
    const dir = picked.filePaths[0];
    if (picked.canceled || !dir) return null;

    const agent = createAgent({ store, workspace: dir, push });
    agents.set(agent.sessionId, agent);
    currentSessionId = agent.sessionId;
    return bootInfo();
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
        createAgent({ store, workspace: first.workspace, push, resumeSessionId: sessionId })
      );
    }
    currentSessionId = sessionId;
    const info = bootInfo();
    if (!info) throw new Error("恢复会话失败"); // 理论不可达，让 TS 安心
    return info;
  });

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

  ipcMain.handle(CHANNELS.sendMessage, async (_e, sessionId: string, text: string) => {
    const agent = agents.get(sessionId);
    if (!agent) throw new Error("会话不存在或未激活");
    if (runningSessions.has(sessionId)) throw new Error("该会话上一个 turn 还在跑");
    runningSessions.add(sessionId);
    win.webContents.send(CHANNELS.turnStatus, { sessionId, status: "running" });
    try {
      await agent.engine.runTurn(text);
    } finally {
      runningSessions.delete(sessionId);
      win.webContents.send(CHANNELS.turnStatus, { sessionId, status: "idle" });
    }
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
