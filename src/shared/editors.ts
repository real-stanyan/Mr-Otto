// Files 面板「用编辑器打开」的候选名单(纯数据,零 IO)。
//
// 为什么是固定名单而不是扫 /Applications:那边有几百个 app,列出来的菜单
// 没法看。名单只管"哪些算编辑器",装没装是主进程去问文件系统。
//
// 名字 = macOS 上的 bundle 名(不含 .app),`open -a <名字>` 认的就是它。

export interface EditorApp {
  /** 菜单里显示的名字,也是 `open -a` 的参数 */
  name: string;
  /** 探到的 bundle 绝对路径(菜单不显示,用来做 tooltip 和去重) */
  appPath: string;
}

/** 常见编辑器/IDE。顺序 = 菜单顺序,前面的更常用 */
export const EDITOR_CATALOG: readonly string[] = [
  "Visual Studio Code",
  "Cursor",
  "Zed",
  "ZCode",
  "Windsurf",
  "Trae",
  "Sublime Text",
  "WebStorm",
  "IntelliJ IDEA",
  "PyCharm",
  "Android Studio",
  "Xcode",
  "Nova",
  "BBEdit",
  "TextMate",
];

/** app 可能装在哪两层。用户级那层是 Setapp/手动装的常见落点 */
export function editorSearchDirs(homeDir: string): string[] {
  return ["/Applications", `${homeDir}/Applications`];
}
