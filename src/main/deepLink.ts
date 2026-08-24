// mrotto:// 深链的 argv 通道（issue #310）。
//
// macOS 深链走 open-url 事件；Windows/Linux 没有这个事件，URL 以命令行参数到达：
// - app 已在跑:系统启动第二个实例,URL 在新实例 argv 里,经 second-instance 事件转交
// - 冷启动:URL 在本进程 process.argv 里
// argv 里混着 Chromium 开关(--no-sandbox 之类)和可执行文件路径,按 scheme 前缀挑。
export function findMrottoDeepLink(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith("mrotto://")) ?? null;
}
