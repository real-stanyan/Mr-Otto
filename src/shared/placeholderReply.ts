// 模型「没什么要说」时吐出来的占位话（#1682 / #1683 真模型模拟）：「（没接话）」「（无补充）」「（无输出）」「(no reply)」。
// 提示词说了三遍别写，还是会写——手机上就是一个只写着这几个字的气泡。整句只是一对括号里的几个字才算：
// 正常的话里带括号（「好的（已改到 7:45）」）一个字不动。纯函数，engine 与测试共用。
const PLACEHOLDER = /^\s*[（(【\[]\s*(无|没有?|暂无|不用|无需|no|nothing|none|n\/a)[^）)】\]]{0,12}[）)】\]]\s*$/i;

export function isPlaceholderReply(content: string): boolean {
  return content.length <= 40 && PLACEHOLDER.test(content);
}
