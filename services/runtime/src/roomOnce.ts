// 一条会话同一时刻只许有一间房（#1441 终审 I2）。daemon.ts 的 openSessionRoom 每次都起新 transport、装配新的
// CloudSession、覆盖 activeSessions——对一条已经开着的会话再开一次，就是两个 CloudSession 写同一份日志：
// 两边各跑一遍重启补跑（汇报那一轮答两遍）、各自折叠外联状态（刚打出去的那通被另一边按 failed 收掉）。
// 启动补开那一圈是错峰的，等到它走到某一行时，那间房可能已经被别的路径开过了（外联会话装配时 resume() 收掉
// 进行中的那通 → 汇报回原聊天 → 开原聊天的房；或者错峰期间 call_friend 派出去 → 开外联会话的房）。
// 判断放在这里而不是 daemon.ts：那个文件进不了 vitest
/** 已经开着就用现成的，没开才开 */
export function liveOr<S>(live: S | null | undefined, open: () => S): S {
  return live ?? open();
}
