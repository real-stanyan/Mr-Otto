// 往输入框里注入一段文本 —— 「引用选中文字」和「展开 MCP prompt」共用的那条语义。
//
// 抽出来是因为它有一条容易被无声改掉的不变量（F2 / issue #158）：注入是**追加**，
// 不是清空重写。用户在敲 `/xxx` 之前完全可能已经打了半句话——slash 菜单的
// removeOnExecute 只挪走 `/token` 本身，更早敲的那些字原样留在 composer 里。
// 覆盖档存在（调用方传 append: false），但那是另一件事，不该是默认。
//
// 从前这几行长在 App.tsx 的一个 effect 里，测不动：把 append 从 true 改回 false
// CI 抓不到。

/** 注入之后 composer 里应该是什么。
    追加时用空行隔开——注入的通常是一整段（引用块 / 展开的 prompt），
    直接贴在半句话屁股后面会连成一句读不通的东西。
    原文是空白（只有空格换行）时不留那个空行：那不是"用户写了东西"。 */
export function composeInjectedText(prev: string, injected: string, append: boolean): string {
  if (!append) return injected;
  if (prev.trim() === "") return injected;
  // 先削掉原文尾部的空白，再统一补两个换行——不然用户已经敲的换行会和这里
  // 补的叠在一起，注入几次就多出一片空行
  return `${prev.replace(/\s*$/, "\n\n")}${injected}`;
}
