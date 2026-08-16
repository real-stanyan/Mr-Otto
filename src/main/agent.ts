// 组装根（agent 侧）— 把 store/adapter/tools/world/approver 拼成 engine。
// 刻意不 import electron：接缝都是回调，Electron 接线在 index.ts。

import { EventStore } from "../session/store.js";
import { LoopEngine } from "../loop/engine.js";
import { createOpenAICompatibleAdapter } from "../model/openaiCompatible.js";
import { resolveModel, type ModelChoice } from "../shared/modelCatalog.js";
import { createLocalWorld } from "../world/localWorld.js";
import { readFileTool } from "../tools/readFile.js";
import { writeFileTool } from "../tools/writeFile.js";
import { bashTool } from "../tools/bash.js";
import { UIApprover } from "./uiApprover.js";
import type { SessionEvent, ToolCallRequest } from "../session/events.js";
import type { Tool } from "../tools/tool.js";

export interface AgentPush {
  event(e: SessionEvent): void;
  /** 带 sessionId：审批卡要挂靠到具体会话的视图上 */
  approvalRequest(sessionId: string, call: ToolCallRequest, tool: Tool): void;
}

export function createAgent(opts: {
  /** app 级资源，由外面注入——欢迎页列会话时 agent 还不存在，库必须先活着 */
  store: EventStore;
  workspace: string;
  push: AgentPush;
  /** 给了 = 恢复旧会话：复用它的 id，不再追加 session_created */
  resumeSessionId?: string;
}) {
  const { store } = opts;

  const sessionId =
    opts.resumeSessionId ?? `s-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  const approver = new UIApprover((call, tool) =>
    opts.push.approvalRequest(sessionId, call, tool)
  );
  if (!opts.resumeSessionId) {
    // workspace 写进日志第 0 条：它是会话事实，不是运行时配置。
    // system 消息（deriveMessages）和文件围栏（LocalWorld root）都从这个事实派生。
    // resume 时它已在日志里——engine 每 turn 从日志现算，所以这里啥都不用"恢复"。
    store.append({ sessionId, ts: Date.now(), type: "session_created", workspace: opts.workspace });
  }

  // 当前模型 = 日志投影：最后一条 model_changed 说了算，没有就用默认。
  // resume 时上次的选择自动回来——和 workspace 同一招，零额外持久化。
  const lastSwitch = store
    .load(sessionId)
    .filter((e) => e.type === "model_changed")
    .at(-1);
  let current: ModelChoice = resolveModel(
    lastSwitch?.type === "model_changed"
      ? lastSwitch.model
      : (process.env["OTTER_MODEL"] ?? "deepseek-v4-flash")
  );

  // key 本体只在这里碰 process.env；缺 key 不拦启动，chat 时报错给 UI
  const makeAdapter = (choice: ModelChoice) =>
    createOpenAICompatibleAdapter({
      baseUrl: process.env[choice.baseUrlEnv] ?? choice.baseUrl,
      apiKey: process.env[choice.apiKeyEnv] ?? "",
      model: choice.model,
    });

  const engine = new LoopEngine({
    store,
    adapter: makeAdapter(current),
    tools: [readFileTool, writeFileTool, bashTool],
    world: createLocalWorld({ root: opts.workspace }),
    sessionId,
    approver,
    onEvent: opts.push.event,
  });

  /** 切换 = 先落事实（model_changed），再换投影（adapter 实例）。顺序是硬规则 */
  function switchModel(modelId: string): void {
    if (modelId === current.model) return;
    const next = resolveModel(modelId);
    const full = store.append({
      sessionId,
      ts: Date.now(),
      type: "model_changed",
      provider: next.provider,
      model: next.model,
    });
    opts.push.event(full); // engine 外落的盘，推送自己负责
    engine.setAdapter(makeAdapter(next));
    current = next;
  }

  return {
    engine,
    approver,
    sessionId,
    workspace: opts.workspace,
    switchModel,
    /** 设置页存了新 key 后调：现 adapter 捏的还是旧 key，重建一个 */
    reloadAdapter(): void {
      engine.setAdapter(makeAdapter(current));
    },
    get model() {
      return current.model;
    },
  };
}

/** 极简 .env 装载：只补空缺，不覆盖已有环境变量。组装根特权，别处禁用 fs */
export function loadDotEnv(readFile: (p: string) => string, path: string): void {
  let text: string;
  try {
    text = readFile(path);
  } catch {
    return; // 没有 .env 就算了
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && m[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2] ?? "";
    }
  }
}
