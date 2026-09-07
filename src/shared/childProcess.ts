// 起子进程的平台差异收口（issue #1027）。
//
// 背景：Windows 版 Mr Otto 是无控制台的 GUI 进程，agent 每跑一条 bash 工具
// 用户屏幕就弹一个 cmd 黑框。机制分两层：
//
// 1. Node 的 child_process 在 Windows 上起 console 子系统程序时，若进程找不到
//    可继承的控制台，Windows 会给它**新建一个控制台窗口**——GUI 进程没有这个
//    可继承的控制台，所以每个子进程都弹一次窗。
// 2. `windowsHide: true`（翻成 CREATE_NO_WINDOW）能压掉这个窗口，但 MSDN 明写：
//    与 `detached: true`（DETACHED_PROCESS）**同时给出时被忽略**——两个旗标互斥，
//    detached 胜出（ADR-0163 在 updater 那边已经踩过同一颗雷）。
//
// 所以 win32 上必须 `windowsHide: true` 且**不能** `detached: true`。
// 去掉 detached 在 win32 上没有行为损失：进程组信号（killGroup 的负 pid）
// 本来就是 Unix 原语，Windows 上 process.kill(-pid) 是 no-op。
// 其他平台维持 `detached: true`——独立进程组是 killGroup「全组连坐」的前提
// （issue #759：不然命令里 `&` 起的孙进程会被 reparent 逃逸）。

/**
 * spawn/execFile 选项里「控制台与进程组」那一对的平台取值。
 * 用法：`spawn(cmd, { shell: true, ...consoleSafeSpawnOpts(), ... })`。
 * win32 → windowsHide:true + detached:false（理由见文件头）；
 * 其他平台 → windowsHide:true（无副作用，顺手统一）+ detached:true（进程组）。
 */
export function consoleSafeSpawnOpts(
  platform: NodeJS.Platform = process.platform
): { windowsHide: boolean; detached: boolean } {
  if (platform === "win32") {
    return { windowsHide: true, detached: false };
  }
  // 非 win32：detached:true = 独立进程组，组长 pgid = child.pid
  return { windowsHide: true, detached: true };
}
