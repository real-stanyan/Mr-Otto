// 终端在渲染层可见的形态 —— 挪到 shared/ 是因为它本该在这:
// shellBridge.ts 是"共享世界,零运行时依赖"的边界文件,三边(main/renderer/preload)共 import,
// 之前它反过来 import ../main/terminalHub.js,把依赖方向指向了主进程模块
// (类型擦除后运行时无害,但方向是反的,下一次改 terminalHub 的实现细节
// 容易顺手带乱 shellBridge 的 import 图)。TerminalInfo 本身只是标签行要渲染的数据形状,
// 跟"pty 怎么实现"无关,天生该住在 shared/。

export interface TerminalInfo {
  id: string;
  title: string;
  /** 进程已经退了。标签还留着——遗言得让人看得见,是用户点 × 才消失 */
  exited: boolean;
}
