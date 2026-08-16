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
  startSession: () => ipcRenderer.invoke(CHANNELS.startSession),
  listSessions: () => ipcRenderer.invoke(CHANNELS.listSessions),
  resumeSession: (sessionId) => ipcRenderer.invoke(CHANNELS.resumeSession, sessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke(CHANNELS.deleteSession, sessionId),
  switchModel: (model) => ipcRenderer.invoke(CHANNELS.switchModel, model),
  keyStatus: () => ipcRenderer.invoke(CHANNELS.keyStatus),
  setApiKey: (envName, key) => ipcRenderer.invoke(CHANNELS.setApiKey, envName, key),
  sendMessage: (sessionId, text) => ipcRenderer.invoke(CHANNELS.sendMessage, sessionId, text),
  decideApproval: (sessionId, toolCallId, decision, reason) =>
    ipcRenderer.invoke(CHANNELS.decideApproval, sessionId, toolCallId, decision, reason),
  onEvent: subscribe(CHANNELS.event),
  onApprovalRequest: subscribe(CHANNELS.approvalRequest),
  onTurnStatus: subscribe(CHANNELS.turnStatus),
};

contextBridge.exposeInMainWorld("otter", bridge);
