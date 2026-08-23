// 三点式服从率——门禁档断言：恰好三条 `- ` 开头的单行要点，无其它内容。
// promptfoo 的 javascript assert 约定：默认导出 (output, context) => {pass, score, reason}。
// ESM：仓库 package.json 是 "type": "module"，.js 一律按 ESM 解析。
//
// 自检（不花钱）：node metrics/compliance.js

export function check(output) {
  const lines = String(output ?? "")
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "");
  const bullets = lines.filter((l) => l.startsWith("- "));
  const pass = lines.length === 3 && bullets.length === 3;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? "恰好三条要点"
      : `${lines.length} 行，其中 ${bullets.length} 条以「- 」开头（要求 3/3）`,
  };
}

export default (output) => check(output);

// 自检：直接 node 跑这个文件时断言自己
if (import.meta.url === `file://${process.argv[1]}`) {
  const { default: assert } = await import("node:assert");
  assert.ok(check("- 一\n- 二\n- 三").pass, "标准三条要过");
  assert.ok(check("  - 一\n- 二\n- 三\n\n").pass, "整串首尾空白宽容（trim 收走）");
  assert.ok(!check("- 一\n  - 二\n- 三").pass, "中间行带缩进不算「- 」开头");
  assert.ok(!check("好的，以下是要点：\n- 一\n- 二\n- 三").pass, "开场白要挂");
  assert.ok(!check("- 一\n- 二").pass, "两条要挂");
  assert.ok(!check("- 一\n- 二\n- 三\n- 四").pass, "四条要挂");
  assert.ok(!check("").pass, "空输出要挂");
  console.log("compliance.js 自检通过");
}
