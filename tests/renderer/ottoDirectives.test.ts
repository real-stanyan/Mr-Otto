import { describe, expect, it } from "vitest";
import { ottoDirectiveFormatter, ottoPathFormatter, ottoSlashFormatter } from "../../src/renderer/src/aui/ottoDirectives.js";

const f = ottoDirectiveFormatter(["review", "review-pr", "写代码"]);

describe("ottoDirectiveFormatter", () => {
  it("serialize 出的就是本仓的真语法(末尾带空格,光标直接接正文)", () => {
    expect(f.serialize({ id: "review", type: "skill", label: "review" })).toBe("$review ");
  });

  it("句中的 $skill 认成 chip,两边的普通文本原样留着", () => {
    expect(f.parse("参考 $review 的做法")).toEqual([
      { kind: "text", text: "参考 " },
      { kind: "mention", type: "skill", label: "$review", id: "review" },
      { kind: "text", text: " 的做法" },
    ]);
  });

  it("最长优先:$review-pr 不会只认成 $review", () => {
    expect(f.parse("$review-pr")).toEqual([
      { kind: "mention", type: "skill", label: "$review-pr", id: "review-pr" },
    ]);
  });

  it("不在名单里的 $ 只是普通字符 —— 价格、shell 变量、正则行尾都不该变 chip", () => {
    expect(f.parse("要 $100,还有 $PATH 和 /a$/")).toEqual([
      { kind: "text", text: "要 $100,还有 $PATH 和 /a$/" },
    ]);
  });

  it("名字里不吃中文/标点:$review。 的句号留在正文里", () => {
    expect(f.parse("$review。")).toEqual([
      { kind: "mention", type: "skill", label: "$review", id: "review" },
      { kind: "text", text: "。" },
    ]);
  });

  it("非 ASCII 的 skill 名认不出来 —— 名字只吃字母数字连字符下划线", () => {
    // 名单里有「写代码」,但 $ 后面第一个字符就不在允许集里,整条退回普通文本。
    // 这是刻意的取舍:允许中文的话「$写代码的时候」会把后面的字一路吃进名字
    expect(f.parse("$写代码")).toEqual([{ kind: "text", text: "$写代码" }]);
  });

  it("空文本也给一个 segment —— DirectiveText 的快路径判的是 segments.length === 1", () => {
    expect(f.parse("")).toEqual([{ kind: "text", text: "" }]);
  });

  it("相邻两个 chip 之间没有多余的空 text 段", () => {
    expect(f.parse("$review$review-pr")).toEqual([
      { kind: "mention", type: "skill", label: "$review", id: "review" },
      { kind: "mention", type: "skill", label: "$review-pr", id: "review-pr" },
    ]);
  });
});

describe("ottoSlashFormatter", () => {
  const f = ottoSlashFormatter(["compact", "rename"]);

  it("serialize 写成 `/名字 `,尾随空格留给参数", () => {
    expect(f.serialize({ id: "rename", type: "command", label: "/rename" })).toBe("/rename ");
  });

  it("parse 认回名单里的指令,路径里的斜杠不算", () => {
    expect(f.parse("/rename 新标题")).toEqual([
      { kind: "mention", type: "command", label: "/rename", id: "rename" },
      { kind: "text", text: " 新标题" },
    ]);
    expect(f.parse("看 /usr/bin")).toEqual([{ kind: "text", text: "看 /usr/bin" }]);
  });
});

describe("ottoPathFormatter(@路径)", () => {
  const f = ottoPathFormatter();

  it("@ 开头的路径整条高亮", () => {
    expect(f.parse("@src/App.tsx")).toEqual([
      { kind: "mention", type: "path", label: "@src/App.tsx", id: "src/App.tsx" },
    ]);
  });

  it("邮箱不算——@ 前面不是行首也不是空白", () => {
    expect(f.parse("写给 foo@bar.com")).toEqual([{ kind: "text", text: "写给 foo@bar.com" }]);
  });

  it("光秃秃一个 @ 不算(还没打路径,别闪一下)", () => {
    expect(f.parse("@")).toEqual([{ kind: "text", text: "@" }]);
    expect(f.parse("@ 后面是空格")).toEqual([{ kind: "text", text: "@ 后面是空格" }]);
  });

  it("句末标点不吃进路径里", () => {
    expect(f.parse("看 @a.md。")).toEqual([
      { kind: "text", text: "看 " },
      { kind: "mention", type: "path", label: "@a.md", id: "a.md" },
      { kind: "text", text: "。" },
    ]);
  });

  it("一句话里两条路径各自高亮", () => {
    const segs = f.parse("@a.ts 和 @b/c.ts 对比");
    expect(segs.filter((s) => s.kind === "mention").map((s) => "id" in s && s.id)).toEqual(["a.ts", "b/c.ts"]);
  });

  it("路径里带点、连字符、下划线、中文都留着", () => {
    expect(f.parse("@docs/adr/0091-files面板_v2.md")[0]).toMatchObject({
      id: "docs/adr/0091-files面板_v2.md",
    });
  });

  it("serialize = 面板那颗 @ 按钮塞进输入框的写法(带尾随空格)", () => {
    expect(f.serialize({ id: "src/a.ts", label: "src/a.ts", type: "path" })).toBe("@src/a.ts ");
  });
});
