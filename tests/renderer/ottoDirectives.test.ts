import { describe, expect, it } from "vitest";
import {
  findSkillDirective,
  ottoDirectiveFormatter,
  ottoPathFormatter,
  ottoSlashFormatter,
} from "../../src/renderer/src/aui/ottoDirectives.js";

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

describe("findSkillDirective —— 发的那头和画的那头是同一件事(issue #438)", () => {
  const names = ["apple-design", "review", "review-pr"];
  const find = (t: string) => findSkillDirective(t, names);

  it("病根复现:句中的 $skill 也算指令头,不再只认行首", () => {
    expect(find("用$apple-design 重新设计一下右边白色区域里的布局")).toEqual({
      name: "apple-design",
      task: "用 重新设计一下右边白色区域里的布局",
    });
  });

  it("画的和发的用同一份名单:parse 画成 chip 的,find 一定认得出", () => {
    // 这条是 #438 的守卫本身 —— 两头一旦再分家,这里就红。
    // 「输入框亮着像认出来了、回车却按纯文本发走」比功能没生效更坏
    const f438 = ottoDirectiveFormatter(names);
    for (const text of [
      "用$apple-design 干活",
      "$review 这段",
      "先看看 $review-pr 再说",
      "$apple-design(lite) 干活",
      "`$apple-design` 是什么",
      "https://x.com/$review 看这个",
    ]) {
      const chipped = f438.parse(text).some((s) => s.kind === "mention" && s.type === "skill");
      expect([text, chipped]).toEqual([text, find(text) !== null]);
    }
  });

  it("行首那条老路逐字节不变:token 摘掉再 trim = 旧的 slice(space+1)", () => {
    expect(find("$review 这段代码")).toEqual({ name: "review", task: "这段代码" });
  });

  it("参数照旧从括号里取", () => {
    expect(find("$apple-design(lite) 干活")).toEqual({
      name: "apple-design",
      args: "lite",
      task: "干活",
    });
  });

  it("括号里带空格的参数也认 —— 旧写法在首个空白处就把 token 切断了", () => {
    expect(find("$apple-design(dark mode) 干活")).toEqual({
      name: "apple-design",
      args: "dark mode",
      task: "干活",
    });
  });

  it("括号没闭合就当没写参数,`(` 留在正文里", () => {
    expect(find("$review(未闭合 干活")).toEqual({ name: "review", task: "(未闭合 干活" });
  });

  it("正文里别的字一个不删 —— 只摘掉 token,接缝的连续空白折成一个", () => {
    expect(find("用 $review 看看")).toEqual({ name: "review", task: "用 看看" });
    // 别处的双空格不碰:折叠只发生在接缝
    expect(find("$review a  b")).toEqual({ name: "review", task: "a  b" });
  });

  it("最长优先跟 parse 一致:$review-pr 不会被认成 $review", () => {
    expect(find("$review-pr 这个 PR")).toEqual({ name: "review-pr", task: "这个 PR" });
  });

  it("一句里写两个:第一个当指令,后面那个留在正文里当字面量", () => {
    expect(find("$review 顺便看看 $apple-design")).toEqual({
      name: "review",
      task: "顺便看看 $apple-design",
    });
  });

  it("光一条指令没正文 -> task 为空串(由 submit 报「任务不能为空」)", () => {
    expect(find("$review")).toEqual({ name: "review", task: "" });
  });

  it("不在名单里的 $ 认不出来 —— 价格、shell 变量都不是指令", () => {
    expect(find("价格是 $50")).toBeNull();
    expect(find("echo $PATH")).toBeNull();
    expect(find("用$aple-design 干活")).toBeNull();
  });
});

describe("转义:反引号和斜杠打头的 $ 不是指令(issue #441)", () => {
  const names = ["apple-design", "review"];
  const find = (t: string) => findSkillDirective(t, names);
  const f441 = ottoDirectiveFormatter(names);

  it("反引号 = 正式的转义写法:提到 skill 名而不是调用它", () => {
    // #439 改出来的新伤:用户只是想问「这个 skill 是什么」,结果 skill 被注入、
    // 名字被摘走,正文只剩一对空反引号
    expect(find("`$apple-design` 是什么")).toBeNull();
  });

  it("斜杠打头 = URL / 路径,不是指令", () => {
    expect(find("https://x.com/$review 看这个")).toBeNull();
    expect(find("./$review 这个文件")).toBeNull();
  });

  it("转义的那一份在输入框里也不画 chip —— 两头一起不认", () => {
    expect(f441.parse("`$apple-design` 是什么")).toEqual([
      { kind: "text", text: "`$apple-design` 是什么" },
    ]);
  });

  it("#438 的正例不能因为转义而回退", () => {
    expect(find("用$apple-design 重新设计右边的布局")).toEqual({
      name: "apple-design",
      task: "用 重新设计右边的布局",
    });
  });

  it("只看贴身的前一个字符:代码块里顶行首的照旧算指令(已知代价)", () => {
    // 前一个字符是换行,不是反引号 —— 真解析 markdown 围栏是另一个量级的事
    expect(find("```\n$review foo\n```")).not.toBeNull();
  });

  it("斜杠指令那个 sigil 走同一个判定", () => {
    const cmd = ottoSlashFormatter(["compact"]);
    expect(cmd.parse("`/compact` 是什么")).toEqual([{ kind: "text", text: "`/compact` 是什么" }]);
  });
});
