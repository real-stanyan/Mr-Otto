import { describe, expect, it } from "vitest";

import { parseBlock } from "../../src/renderer/src/lib/ottoBlocks.js";

/** 解析 + 收窄到那一种块的 data。认不出来返回 null */
const spec = (o: unknown) => {
  const b = parseBlock("otto-spec", JSON.stringify(o));
  return b?.kind === "otto-spec" ? b.data : null;
};
const compare = (o: unknown) => {
  const b = parseBlock("otto-compare", JSON.stringify(o));
  return b?.kind === "otto-compare" ? b.data : null;
};
const score = (o: unknown) => {
  const b = parseBlock("otto-score", JSON.stringify(o));
  return b?.kind === "otto-score" ? b.data : null;
};
const flow = (o: unknown) => {
  const b = parseBlock("otto-flow", JSON.stringify(o));
  return b?.kind === "otto-flow" ? b.data : null;
};

describe("parseBlock —— 模型写的块认不认", () => {
  it("不是本仓的围栏语言一律不认", () => {
    expect(parseBlock("json", '{"title":"x","rows":[]}')).toBeNull();
    expect(parseBlock("otto-nope", "{}")).toBeNull();
  });

  it("半段 JSON（还在流）→ null，不是崩", () => {
    expect(parseBlock("otto-spec", '{"title":"参数","rows":[{"lab')).toBeNull();
  });

  it("顶层不是对象就不认", () => {
    expect(parseBlock("otto-spec", "[1,2,3]")).toBeNull();
    expect(parseBlock("otto-spec", '"字符串"')).toBeNull();
  });
});

describe("otto-spec", () => {
  it("认标准形状", () => {
    expect(spec({ title: "参数", rows: [{ label: "端口", value: "5173" }] })).toEqual({
      title: "参数",
      rows: [{ label: "端口", value: "5173" }],
    });
  });

  it("emphasis 只收布尔真值 —— 省略时不进对象（exactOptionalPropertyTypes）", () => {
    expect(spec({ title: "t", rows: [{ label: "a", value: "b", emphasis: true }] })).toEqual({
      title: "t",
      rows: [{ label: "a", value: "b", emphasis: true }],
    });
    expect(spec({ title: "t", rows: [{ label: "a", value: "b", emphasis: "yes" }] })).toBeNull();
  });

  it("空行数组不收 —— 一张没有行的卡就是个空框", () => {
    expect(spec({ title: "t", rows: [] })).toBeNull();
  });

  it("缺字段就不认", () => {
    expect(spec({ rows: [{ label: "a", value: "b" }] })).toBeNull();
    expect(spec({ title: "t", rows: [{ label: "a" }] })).toBeNull();
  });
});

describe("otto-compare", () => {
  const ok = {
    traitLabels: ["价格", "速度"],
    options: [
      { id: "a", name: "A", headline: "便宜", traits: ["¥1", false] },
      { id: "b", name: "B", headline: "快", traits: [false, "10ms"] },
    ],
    recommendedId: "b",
    reason: "快得多",
  };

  it("认标准形状；traits 的 false 是合法值，不是解析失败", () => {
    expect(compare(ok)?.options[0]?.traits).toEqual(["¥1", false]);
  });

  it("推荐项不在选项里就不认 —— 一栏都不高亮却写着推荐理由是自相矛盾", () => {
    expect(compare({ ...ok, recommendedId: "c" })).toBeNull();
  });

  it("traits 里出现 true / 数字都不收", () => {
    expect(
      compare({ ...ok, options: [{ id: "a", name: "A", headline: "h", traits: [true] }, ok.options[1]] }),
    ).toBeNull();
  });
});

describe("otto-score", () => {
  const ok = { verdict: "可以上", total: 8.5, outOf: 10, criteria: [{ label: "覆盖", score: 4, weight: 1 }] };

  it("认标准形状", () => {
    expect(score(ok)?.total).toBe(8.5);
  });

  it("满分 0 不收 —— 比例算不出来，条永远是空的", () => {
    expect(score({ ...ok, outOf: 0 })).toBeNull();
  });

  it("非有限数不收（1e999 会解析成 Infinity）", () => {
    expect(parseBlock("otto-score", '{"verdict":"v","total":1e999,"outOf":10,"criteria":[{"label":"a","score":1,"weight":1}]}')).toBeNull();
  });
});

describe("otto-flow", () => {
  const ok = {
    nodes: [
      { id: "a", label: "起", column: 0, row: 0, state: "done" },
      { id: "b", label: "终", column: 1, row: 0, state: "pending" },
    ],
    edges: [{ from: "a", to: "b" }],
  };

  it("认标准形状", () => {
    expect(flow(ok)?.edges).toEqual([{ from: "a", to: "b" }]);
  });

  it("一条边都没有也认 —— 单列的几个步骤本来就没有连线", () => {
    expect(flow({ nodes: ok.nodes })?.edges).toEqual([]);
  });

  it("边指向不存在的节点就不认 —— 元件会去查一个 undefined 的坐标", () => {
    expect(flow({ ...ok, edges: [{ from: "a", to: "z" }] })).toBeNull();
  });

  it("同名节点不收 —— 连线指向谁说不清", () => {
    expect(flow({ nodes: [ok.nodes[0], ok.nodes[0]] })).toBeNull();
  });

  it("坐标必须是非负整数 —— 小数/负数会把节点画到卡外面", () => {
    expect(flow({ nodes: [{ ...ok.nodes[0], column: 0.5 }] })).toBeNull();
    expect(flow({ nodes: [{ ...ok.nodes[0], row: -1 }] })).toBeNull();
  });

  it("state 只认三档", () => {
    expect(flow({ nodes: [{ ...ok.nodes[0], state: "running" }] })).toBeNull();
  });
});
