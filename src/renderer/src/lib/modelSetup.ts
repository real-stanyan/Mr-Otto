// 新用户「配第一个大模型」引导：该不该弹 + 本机盖章（issue #328）。
//
// 盖章走 localStorage 而不是服务端：key 本来就存在这台机器的 keyVault 里
// （userData/keys.json），"这台机器引导过没有"跟着机器走才对——换机器
// 没有 key，可以再被引导一次。theme.ts 同款口径：UI 偏好非会话事实，
// 不走 IPC，不进事件日志。
//
// profile 引导（ProfileSetupDialog）盖的是服务端 onboarded_at，两者刻意不同。

const STAMP_KEY = "otter-model-setup-done";

/**
 * 该不该弹。"配过" = keyStatus 里任何一家的遮罩非空（与设置页口径一致，
 * 见 shared/keyMask.ts）。keyless（Ollama）不经过 keyStatus，也刻意不算：
 * 引导的目的是让用户至少主动接一家能用的模型。
 */
export function needsModelSetup(keyStatus: Record<string, string>, stamped: boolean): boolean {
  if (stamped) return false;
  return !Object.values(keyStatus).some((mask) => mask !== "");
}

export function hasModelSetupStamp(): boolean {
  return localStorage.getItem(STAMP_KEY) !== null;
}

export function stampModelSetup(): void {
  localStorage.setItem(STAMP_KEY, new Date().toISOString());
}
