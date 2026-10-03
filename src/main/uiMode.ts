// uiMode —— 这一次开机画哪一套界面（#1386）。
//
// 维护者在 #1391 拍板：本机写代码那一半（任务 / 项目两栏、本机会话、Files、终端、轨迹……）
// **先藏起来**，代码一行不删，删另开一条。藏的是入口：默认只画微信式的聊天界面；
// 环境变量 `OTTO_CODING=1` 时整个旧界面原样回来——维护者自己还要用，e2e 还要跑。
//
// 只认字面量 "1"：`OTTO_CODING=0` / 空串 / 随手写的 "true" 都当没开——一个开关的真值
// 有好几种写法，就会有人以为关掉了而实际开着（或反过来）。

export const CODING_UI_ENV = "OTTO_CODING";

export function codingUiFromEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[CODING_UI_ENV] === "1";
}
