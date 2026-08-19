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
