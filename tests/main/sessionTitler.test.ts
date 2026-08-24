// sessionTitler（issue #335）：会话自动命名的判定 + 解析纯函数。
// 调用本体（合并进 turnAnnotator 的任务三）的覆盖在 turnAnnotator.test.ts。
import { describe, expect, it } from "vitest";
import {
  AUTO_TITLE_THRESHOLD,
  autoTitleSource,
  parseSessionTitle,
  titleBlock,
} from "../../src/main/sessionTitler.js";

describe("autoTitleSource —— 首行超阈值才值得一次浓缩", () => {
  it("没有第一条消息 / 首行短 → null（现状已是合格标题）", () => {
    expect(autoTitleSource(null)).toBeNull();
    expect(autoTitleSource("修登录")).toBeNull();
    expect(autoTitleSource("a".repeat(AUTO_TITLE_THRESHOLD))).toBeNull(); // 正好在阈值上：不浪费
  });

  it("首行超阈值 → 返回素材", () => {
    const msg = "搜一下 vite 官网，把找到的链接写进 sources-test.md";
    expect(msg.length).toBeGreaterThan(AUTO_TITLE_THRESHOLD); // 用例自证前提
    expect(autoTitleSource(msg)).toBe(msg);
  });

  it("判定只看首行：首行短 + 正文很长 → 仍然 null（投影取的就是首行）", () => {
    expect(autoTitleSource("修登录\n" + "长正文".repeat(500))).toBeNull();
  });

  it("超长消息截到上限再喂模型（标题只需要开头的意图）", () => {
    const msg = "很".repeat(5000);
    expect(autoTitleSource(msg)?.length).toBe(2000);
  });

  it("首行前后空白不算长度（投影侧也是 trim 后取的）", () => {
    expect(autoTitleSource("   修登录   \n后面")).toBeNull();
  });
});

describe("parseSessionTitle —— 模型产出的 JSON 不可信", () => {
  it("正常形状 → 取 sessionTitle，trim + 截 40", () => {
    expect(parseSessionTitle('{"sessionTitle":" 搜 vite 官网写文档 "}')).toBe("搜 vite 官网写文档");
    expect(parseSessionTitle(`{"sessionTitle":"${"长".repeat(80)}"}`)).toHaveLength(40);
  });

  it("剥 ```json 围栏（便宜模型爱套）", () => {
    expect(parseSessionTitle('```json\n{"sessionTitle":"修登录"}\n```')).toBe("修登录");
  });

  it("合并回复里只认 sessionTitle 键，不吃任务一的 title", () => {
    expect(parseSessionTitle('{"newSection":true,"title":"分区标题"}')).toBeNull();
  });

  it("形状烂 → null：非 JSON / 非对象 / 键缺失 / 空串 / 非字符串", () => {
    expect(parseSessionTitle("随便说说")).toBeNull();
    expect(parseSessionTitle('"就一个串"')).toBeNull();
    expect(parseSessionTitle("{}")).toBeNull();
    expect(parseSessionTitle('{"sessionTitle":"   "}')).toBeNull();
    expect(parseSessionTitle('{"sessionTitle":42}')).toBeNull();
  });
});

describe("titleBlock —— 素材夹在围栏里，不是指令", () => {
  it("素材进围栏，要求名词短语", () => {
    const block = titleBlock("很长的第一条消息", "abcd1234");
    expect(block).toContain("<abcd1234>\n很长的第一条消息\n</abcd1234>");
    expect(block).toContain("素材");
    expect(block).toContain("名词短语");
  });
});
