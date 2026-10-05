// 情绪括注 / 韵律 / 归一化 / 停顿档的纯逻辑（#1515）。数值来自 ai-podcast 的 delivery_recipe.json
// （32 期真人节目蒸馏）；记号词表是维护者定的六个。
import { describe, expect, it } from "vitest";
import {
  GAP_MS, SPEECH_EMOTIONS, emotionTagLiteral, normalizeSpoken, parseEmotionTag, prosodyFor, stripEmotionTag, stripEmotionTags,
} from "../../src/shared/voiceProsody.js";

describe("parseEmotionTag：只认段首、只认白名单", () => {
  it("六个记号各对一档；全角 / 半角括号都认；记号后的空白一起剥", () => {
    expect(parseEmotionTag("（笑）我弄好了。")).toEqual({ emotion: "happy", text: "我弄好了。" });
    expect(parseEmotionTag("(惊) 这么快？")).toEqual({ emotion: "surprised", text: "这么快？" });
    expect(parseEmotionTag("（叹）没赶上。")).toEqual({ emotion: "sad", text: "没赶上。" });
    expect(parseEmotionTag("（气）又挂了。")).toEqual({ emotion: "angry", text: "又挂了。" });
    expect(parseEmotionTag("（怕）别删库。")).toEqual({ emotion: "fearful", text: "别删库。" });
    expect(parseEmotionTag("（嫌）这代码。")).toEqual({ emotion: "disgusted", text: "这代码。" });
  });
  it("词表外的括注是正文：不剥、不传情绪", () => {
    expect(parseEmotionTag("（笑死）我弄好了。")).toEqual({ emotion: null, text: "（笑死）我弄好了。" });
    expect(parseEmotionTag("（好）我去改。")).toEqual({ emotion: null, text: "（好）我去改。" });
  });
  it("段中的括注不认；没有括注原样回", () => {
    expect(parseEmotionTag("他（笑）说行。")).toEqual({ emotion: null, text: "他（笑）说行。" });
    expect(parseEmotionTag("我弄好了。")).toEqual({ emotion: null, text: "我弄好了。" });
  });
  it("段首空白之后的括注也认", () => {
    expect(parseEmotionTag("  （笑）行。")).toEqual({ emotion: "happy", text: "行。" });
  });
  it("记号独占一行：连行尾换行一起吞，正文不以空行开头", () => {
    expect(parseEmotionTag("（笑）\n弄好了。")).toEqual({ emotion: "happy", text: "弄好了。" });
  });
});

describe("stripEmotionTag / stripEmotionTags", () => {
  it("一段：剥掉段首记号；整条：每个段首各剥一次，段间空行原样保留", () => {
    expect(stripEmotionTag("（笑）行。")).toBe("行。");
    expect(stripEmotionTags("（笑）第一段。\n\n（叹）第二段。\n\n第三段。")).toBe("第一段。\n\n第二段。\n\n第三段。");
    expect(stripEmotionTags("（笑死）不是记号。\n\n他（笑）说。")).toBe("（笑死）不是记号。\n\n他（笑）说。");
  });
  it("记号独占一行：整条剥完不留空行，段间空行照旧", () => {
    expect(stripEmotionTags("（笑）\n弄好了。\n\n（叹）\n就是慢。")).toBe("弄好了。\n\n就是慢。");
  });
});

describe("emotionTagLiteral：规范形是全角", () => {
  it("六档各回一个全角括注，parse 回去是同一档", () => {
    for (const e of SPEECH_EMOTIONS) expect(parseEmotionTag(emotionTagLiteral(e) + "x").emotion).toBe(e);
    expect(emotionTagLiteral("happy")).toBe("（笑）");
  });
});

describe("prosodyFor：播客 recipe 的三档", () => {
  it("高唤起快 + 响；低唤起慢 + 轻；其余基准；没有 pitch 这一格", () => {
    expect(prosodyFor("happy")).toEqual({ speed: 1.12, vol: 1.12 });
    expect(prosodyFor("surprised")).toEqual({ speed: 1.12, vol: 1.12 });
    expect(prosodyFor("angry")).toEqual({ speed: 1.12, vol: 1.12 });
    expect(prosodyFor("sad")).toEqual({ speed: 0.88, vol: 0.92 });
    expect(prosodyFor("fearful")).toEqual({ speed: 0.88, vol: 0.92 });
    expect(prosodyFor("disgusted")).toEqual({ speed: 1, vol: 1 });
    expect(prosodyFor(null)).toEqual({ speed: 1, vol: 1 });
  });
});

describe("normalizeSpoken：搬播客 normalize.ts", () => {
  it("独立的 AI / Ai 收口成大写 AI；词内 ai、SAID 不碰", () => {
    expect(normalizeSpoken("Ai 行业和 ai 不一样，SAID 不动")).toBe("AI 行业和 ai 不一样，SAID 不动");
    expect(normalizeSpoken("OpenAI 的 AI")).toBe("OpenAI 的 AI");
  });
  it("四位年份逐位读；五位数字、没跟「年」的不碰", () => {
    expect(normalizeSpoken("2026年发布，2026 年再见")).toBe("二零二六年发布，二零二六年再见");
    expect(normalizeSpoken("编号 20261 年")).toBe("编号 20261 年");
    expect(normalizeSpoken("2026 版")).toBe("2026 版");
  });
});

describe("GAP_MS", () => {
  it("句间 230、换说话人 460（真人停顿 p50 / p90）", () => {
    expect(GAP_MS).toEqual({ sentence: 230, speaker: 460 });
  });
});

describe("中性记号「（平）」（#1614，真机 2026-10-05）", () => {
  it("剥掉、不传情绪；整条里每段首的（平）也剥", () => {
    expect(parseEmotionTag("（平）行——「他」是哪个？")).toEqual({ emotion: null, text: "行——「他」是哪个？" });
    expect(stripEmotionTags("(平) 没听懂。\n\n（平）你说。")).toBe("没听懂。\n\n你说。");
  });
});
