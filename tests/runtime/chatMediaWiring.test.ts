// 云会话发图的 runtime 接线（#1491）。读源码钉住三件安静出错的事：
// ① frameHandler 把 say.media 递进 session.say——漏了这一格，图在协议里过了却永远到不了事件；
// ② daemon 给 sessionService 接了 media 入库、给 hosted adapter 接了 readAttachment——缺前者带图的 say 一律被拒，
//    缺后者模型看到的是占位文字；
// ③ hostedRoute 只在接了附件库时才按型号目录开 vision，目录认不出的型号不开。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("frameHandler", () => {
  it("say 帧的 media 递进 session.say", () => {
    expect(read("services/runtime/src/frameHandler.ts")).toMatch(/msg\.memberMentions, msg\.voice, msg\.media\s*\)/);
  });
});

describe("daemon", () => {
  const src = read("services/runtime/src/daemon.ts");
  it("会话房接了 media 入库", () => {
    expect(src).toMatch(/media: \(refs\) => chatMedia\.intake\(workspaceId, sessionId, refs\)/);
  });
  it("hosted adapter 接了这个团队的附件库", () => {
    expect(src).toMatch(/readAttachment: \(id\) => attachmentsFor\(workspaceId\)\.read\(id\)/);
  });
  it("下载走 service client 的 storage", () => {
    expect(src).toMatch(/supabase\.storage\.from\(bucket\)\.download\(path\)/);
  });
});

describe("hostedRoute", () => {
  const src = read("services/runtime/src/hostedRoute.ts");
  it("接了附件库才开 vision，按型号目录的 supportsVision", () => {
    expect(src).toMatch(/deps\.readAttachment !== undefined/);
    expect(src).toMatch(/vision: findModel\(route\.model\)\?\.supportsVision \?\? false, readAttachment: deps\.readAttachment/);
  });
});

describe("sessionService", () => {
  const src = read("services/runtime/src/sessionService.ts");
  it("没接媒体的会话房对带图的 say 明说收不了，不静默丢图", () => {
    expect(src).toMatch(/if \(opts\.media === undefined\) throw new SayRejectedError\("这台服务器还收不了图片和视频"\)/);
  });
  it("两条落盘路都带上那两格：chat_message（没 @ 谁）与 user_message（开场白）", () => {
    expect(src).toMatch(/logChat\(fromUid, label, text, mention, voice, mediaFields\)/);
    expect(src).toMatch(/\.\.\.mediaFields,\s*\}\) as UserMessageEvent/);
  });
  it("纯发图的正文写占位", () => {
    expect(src).toMatch(/if \(got !== null && text\.trim\(\) === ""\) text = mediaPlaceholder\(media \?\? \[\]\)/);
  });
});
