// 轨迹详情「Schema」页：工具名 → 参数 JSON Schema。
// 直接读工具定义（def.parameters），不另存一份——工具改了参数，这里自动跟。
// 工具模块只依赖 ExecutionWorld 接口（硬规则），没有 Node import，渲染层可以安全引用；
// 工厂型工具传个哑依赖只为拿 def，run 永远不会在这里被调。

import type { ToolDefinition } from "../../../model/adapter.js";
import { readFileTool } from "../../../tools/readFile.js";
import { writeFileTool } from "../../../tools/writeFile.js";
import { bashTool } from "../../../tools/bash.js";
import { todoWriteTool } from "../../../tools/todoWrite.js";
import { browserReadTool } from "../../../tools/browserRead.js";
import { createAskUserTool } from "../../../tools/askUser.js";
import { createWebSearchTool } from "../../../tools/webSearch.js";
import { createWebExtractTool } from "../../../tools/webExtract.js";
import { createTaskTool } from "../../../tools/task.js";

const never = () => {
  throw new Error("schema-only stub");
};

const DEFS: ToolDefinition[] = [
  readFileTool.def,
  writeFileTool.def,
  bashTool.def,
  todoWriteTool.def,
  browserReadTool.def,
  createAskUserTool(never as never).def,
  createWebSearchTool(never).def,
  createWebExtractTool(never).def,
  createTaskTool(never as never, () => []).def,
];

const BY_NAME = new Map(DEFS.map((d) => [d.name, d]));

/** 没登记的名字（旧日志里已下线的工具）→ undefined，界面显示 unavailable */
export function toolSchema(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}
