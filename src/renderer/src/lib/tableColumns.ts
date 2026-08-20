// markdown 表格的列排版判据。
//
// 单拎出来是因为它是纯逻辑、要测:元件文件里带着 @/ 别名的 import，vitest 解析不了，
// 而这条判断值得有测试 —— 判错的后果是把一列话压成省略号（见下面的注释）。

/** 这一列是不是数字列。数字列才配右对齐 + 等宽 + 固定窄宽度 ——
    原件三列写死成"名字 + 两个数"，是因为它演示的就是用量表；而 markdown 表格
    的列可能是整句话，按数字列排版就会被那 80px 挤成省略号（实测第一版就是这样，
    "极快（开发时…" —— 把模型写的内容截掉，正是这张卡本来要避免的事）。

    判据保守:每一个非空格子都得长得像数字（可带货币号/正负号/千分位/百分号/
    K、M 这类单位后缀）。有一格不是，整列就按正文排 —— 宁可少右对齐一列，
    也不能把一列话压成省略号。 */
const NUMERIC = /^[$¥€£]?[+-]?\d[\d,._]*\s*[%‰]?\s*[KMGTkmgtBb]?$/;

export function isNumericColumn(
  rows: readonly (readonly string[])[],
  index: number,
): boolean {
  let seen = 0;
  for (const row of rows) {
    const cell = (row[index] ?? "").trim();
    if (cell === "") continue; // 空格子不表态
    if (!NUMERIC.test(cell)) return false;
    seen += 1;
  }
  return seen > 0; // 一整列都是空的,不算数字列
}

