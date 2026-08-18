// preload — 桥梁世界：只做转发，零业务逻辑（桥越薄，换壳越便宜）。
// invoke = 请求/响应；on = 订阅，返回退订函数（不退订 = 监听器泄漏）。

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CHANNELS, type ShellBridge, type Unsubscribe } from "../shared/shellBridge.js";

function subscribe<T>(channel: string) {
  return (cb: (payload: T) => void): Unsubscribe => {
    const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

const bridge: ShellBridge = {
  boot: () => ipcRenderer.invoke(CHANNELS.boot),
  pickWorkspace: () => ipcRenderer.invoke(CHANNELS.pickWorkspace),
  startSession: (opts) => ipcRenderer.invoke(CHANNELS.startSession, opts),
  listSessions: () => ipcRenderer.invoke(CHANNELS.listSessions),
  resumeSession: (sessionId) => ipcRenderer.invoke(CHANNELS.resumeSession, sessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke(CHANNELS.deleteSession, sessionId),
  renameSession: (sessionId, title) => ipcRenderer.invoke(CHANNELS.renameSession, sessionId, title),
  switchModel: (model) => ipcRenderer.invoke(CHANNELS.switchModel, model),
  setApprovalMode: (sessionId, mode) => ipcRenderer.invoke(CHANNELS.setApprovalMode, sessionId, mode),
  setThinking: (sessionId, on) => ipcRenderer.invoke(CHANNELS.setThinking, sessionId, on),
  setMaxSteps: (sessionId, n) => ipcRenderer.invoke(CHANNELS.setMaxSteps, sessionId, n),
  listSkills: () => ipcRenderer.invoke(CHANNELS.listSkills),
  protocolListAdrs: (repoDir) => ipcRenderer.invoke(CHANNELS.protocolListAdrs, repoDir),
  protocolReadAdr: (repoDir, relPath) => ipcRenderer.invoke(CHANNELS.protocolReadAdr, repoDir, relPath),
  protocolListIssues: (repoDir) => ipcRenderer.invoke(CHANNELS.protocolListIssues, repoDir),
  protocolGetIssue: (repoDir, number) => ipcRenderer.invoke(CHANNELS.protocolGetIssue, repoDir, number),
  gitGraphLog: (repoDir) => ipcRenderer.invoke(CHANNELS.gitGraphLog, repoDir),
  gitGraphCommit: (repoDir, hash) => ipcRenderer.invoke(CHANNELS.gitGraphCommit, repoDir, hash),
  gitBranches: (repoDir) => ipcRenderer.invoke(CHANNELS.gitBranches, repoDir),
  gitCheckout: (repoDir, branch) => ipcRenderer.invoke(CHANNELS.gitCheckout, repoDir, branch),
  getAccount: () => ipcRenderer.invoke(CHANNELS.getAccount),
  signIn: (provider) => ipcRenderer.invoke(CHANNELS.signIn, provider),
  signOut: () => ipcRenderer.invoke(CHANNELS.signOut),
  keyStatus: () => ipcRenderer.invoke(CHANNELS.keyStatus),
  setApiKey: (envName, key) => ipcRenderer.invoke(CHANNELS.setApiKey, envName, key),
  sendMessage: (sessionId, text, skill, attachments) =>
    ipcRenderer.invoke(CHANNELS.sendMessage, sessionId, text, skill, attachments),
  pickAttachments: () => ipcRenderer.invoke(CHANNELS.pickAttachments),
  attachmentDataUrl: (id) => ipcRenderer.invoke(CHANNELS.attachmentDataUrl, id),
  stopTurn: (sessionId) => ipcRenderer.invoke(CHANNELS.stopTurn, sessionId),
  compact: (sessionId) => ipcRenderer.invoke(CHANNELS.compact, sessionId),
  decideApproval: (sessionId, toolCallId, decision, reason) =>
    ipcRenderer.invoke(CHANNELS.decideApproval, sessionId, toolCallId, decision, reason),
  onEvent: subscribe(CHANNELS.event),
  onApprovalRequest: subscribe(CHANNELS.approvalRequest),
  onTurnStatus: subscribe(CHANNELS.turnStatus),
  onAssistantDelta: subscribe(CHANNELS.assistantDelta),
  onToolOutput: subscribe(CHANNELS.toolOutput),
  onAccountChanged: subscribe(CHANNELS.accountChanged),
};

contextBridge.exposeInMainWorld("otter", bridge);
