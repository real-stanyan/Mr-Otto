// 选中的文字 → markdown 引用块。
// 单独一个函数是为了能验:每行都要有前缀,空行也要——只给首行加前缀的话
// 粘进输入框、发出去之后模型看到的就不是一个引用块了

export function toBlockquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return trimmed
    .split("\n")
    .map((line) => {
      const body = line.trimEnd();
      return body === "" ? ">" : `> ${body}`;
    })
    .join("\n");
}

/** 一条待发出的引用（issue #881）。**渲染层暂存**：不进 `staged`、不变成
    `OutgoingAttachment`、不落日志——发送那一刻折回引用块拼进正文，模型看到的
    与改动前逐字相同。id 只服务于 React key 和 × 按钮（同 QueuedTask 的规矩）。 */
export interface QuotedSnippet {
  id: string;
  text: string;
}

/** chip 上那两行字。名字取**第一行有字的**——刷选常从行尾开始，首行是空的时候
    画一张空名字的 chip 等于让用户认不出自己引了哪一段。 */
export function quoteChipLines(text: string): { name: string; meta: string } {
  const trimmed = text.trim();
  const lines = trimmed === "" ? [] : trimmed.split("\n");
  return {
    name: lines.find((l) => l.trim() !== "")?.trim() ?? "",
    meta: `引用 · ${lines.length} 行`,
  };
}

/** 引用 chips + 输入框里的正文 → 真正发给模型的那条消息。
    引用在**前**：引用回复的通行读法是先摆出在说哪一段、再说要求。
    （改动前靠 injectComposer 追加，引用反而落在草稿后面——那是通道的副作用，
    不是有人选的，见 issue #881。）

    折成正文而不是新开一档 OutgoingAttachment：引用本来就是这条消息的一部分，
    塞进那个类型会让「附件」这个词同时指两种东西，而主进程/事件日志/重发
    三条路都得跟着加一档。代价是发出去之后引用与用户自己打的字在日志里
    重新混在一起——分层只发生在输入框这一侧（ADR-0284）。 */
export function composeQuotedMessage(
  quotes: readonly { text: string }[],
  text: string
): string {
  const blocks = quotes.map((q) => toBlockquote(q.text)).filter((b) => b !== "");
  if (blocks.length === 0) return text;
  return text === "" ? blocks.join("\n\n") : `${blocks.join("\n\n")}\n\n${text}`;
}
