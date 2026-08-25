// 用户钩子配置文件（issue #395）：userData/hooks.json。
//
// 与 execPolicyStore.ts 同一套纪律：
// - 加载期校验，坏文件拒绝加载——整份按空钩子处理并把错误留在返回值里
//   （fail-safe：没有钩子 = 工具调用一切照旧，不存在"半份钩子误拦/误放"）
// - 热更新：读取方每次工具调用现读本函数（engine 的 hooks getter），
//   用户改完文件下一次调用立即生效，不用重开会话
// - v1 没有设置页入口，文件手写（形状见 shared/userHooks.ts 的 validateUserHooks）

import { readFileSync } from "node:fs";
import { validateUserHooks, type ValidatedUserHooks } from "../shared/userHooks.js";

export function loadUserHooks(path: string): ValidatedUserHooks {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // 没有文件 = 还没写过钩子，正常空态；坏 JSON = 拒绝加载并报错
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { hooks: [] };
    return { hooks: [], error: `hooks.json 不是合法 JSON：${(err as Error).message}` };
  }
  return validateUserHooks(parsed);
}
