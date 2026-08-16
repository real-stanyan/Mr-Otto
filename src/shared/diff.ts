// 行级 diff — 审批卡 write_file 预览用的最小实现（LCS 动态规划）。
// diff 是投影：旧内容 + 新内容两个事实推得出，所以不落盘、不进事件，
// 渲染层拿到两份文本现算。纯函数放 shared：主进程/渲染层/测试三边可用。

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/** DP 表规模上限（行数乘积）。超了返回 null——调用方退回"不展示 diff"。
    O(n·m) 内存在 2000×2000 附近约 16MB（Int32），再大就不值得为预览烧内存 */
const MAX_CELLS = 4_000_000;

/** 经典 LCS 对齐：same 行是两边共有的最长公共子序列，
    不在 LCS 里的旧行标 del、新行标 add。输出顺序 = 先删后加（同一位置的替换
    显示为 del 紧跟 add，人读 diff 的习惯顺序） */
export function diffLines(oldText: string, newText: string): DiffLine[] | null {
  // 空文本 = 零行，不是"一个空行"（"".split 会给 [""]，让新文件的 diff
  // 凭空多一条删空行的噪音）
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  if (a.length * b.length > MAX_CELLS) return null;

  // dp[i][j] = a 前 i 行与 b 前 j 行的 LCS 长度（一维滚动省内存不省清晰度，教学期用二维）
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]! + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  // 从表尾回溯出对齐路径（倒着走，最后反转）
  const out: DiffLine[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      out.push({ kind: "same", text: a[--i]! });
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      out.push({ kind: "add", text: b[--j]! });
    } else {
      out.push({ kind: "del", text: a[--i]! });
    }
  }
  out.reverse();

  // 回溯天然产出 add-before-del 的段落顺序不稳定；规范化成"先删后加"：
  // 把每个连续变更块内的 del 提到 add 前面（same 行是块边界）
  const normalized: DiffLine[] = [];
  let block: DiffLine[] = [];
  const flush = () => {
    normalized.push(...block.filter((l) => l.kind === "del"), ...block.filter((l) => l.kind === "add"));
    block = [];
  };
  for (const line of out) {
    if (line.kind === "same") {
      flush();
      normalized.push(line);
    } else {
      block.push(line);
    }
  }
  flush();
  return normalized;
}
