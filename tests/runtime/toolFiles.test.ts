// 文件进出云会话（#1683）：人发来的（chatMediaIntake 收：下载、复算哈希、原件存进 inbox/、转文字）、
// 工具交出去的（toolFiles 中间件：传进 chat-media、换成 ref，传不上去的跳过并在 output 里补一句实话）。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHAT_MEDIA_BUCKET, type ChatMediaRef } from "../../src/shared/chatMedia.js";
import { ChatMediaRejectedError, FILE_TEXT_MAX_CHARS, createChatMediaIntake } from "../../services/runtime/src/chatMediaIntake.js";
import { createRecentFiles, createToolFileIntakeMiddleware } from "../../services/runtime/src/toolFiles.js";
import type { ToolOutcome } from "../../src/loop/middleware.js";
import type { AttachmentStore } from "../../src/session/attachments.js";

const hexOf = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const WS = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";
const PDF = "application/pdf";

function harness(objects: Record<string, Uint8Array>, o: { toText?: (d: Uint8Array) => Promise<string>; saveFails?: boolean } = {}) {
  const saved = new Map<string, Uint8Array>();
  const intake = createChatMediaIntake({
    download: async (_b, path) => {
      const d = objects[path];
      if (d === undefined) throw new Error("Object not found");
      return d;
    },
    storeFor: () => ({}) as AttachmentStore,
    saveFile: async (ws, path, data) => {
      if (o.saveFails) throw new Error("沙箱没起来");
      saved.set(`${ws}:${path}`, data);
    },
    ...(o.toText !== undefined ? { toText: o.toText } : {}),
  });
  return { intake, saved };
}

const fileRef = (data: Uint8Array, name: string, mediaType = PDF): ChatMediaRef =>
  ({ kind: "file", sha256: hexOf(data), mediaType: mediaType as typeof PDF, bytes: data.byteLength, width: 0, height: 0, name });

describe("人发来的文件（chatMediaIntake）", () => {
  it("下载、存进 inbox/、转文字给模型", async () => {
    const data = new TextEncoder().encode("%PDF-1.4 lease");
    const { intake, saved } = harness({ [`${WS}/${SID}/${hexOf(data)}.pdf`]: data }, { toText: async () => "Rent is due on the 1st." });
    const got = await intake.intake(WS, SID, [fileRef(data, "lease.pdf")]);
    expect(got.files).toEqual([{ id: `sha256:${hexOf(data)}`, name: "lease.pdf", mediaType: PDF, bytes: data.byteLength, path: "inbox/lease.pdf", text: "Rent is due on the 1st." }]);
    expect(saved.get(`${WS}:inbox/lease.pdf`)).toEqual(data);
  });

  it("文本类直接解码（去 BOM），不走转换器", async () => {
    const data = new TextEncoder().encode("﻿name,amount\nrent,2400");
    const { intake } = harness({ [`${WS}/${SID}/${hexOf(data)}.csv`]: data });
    const got = await intake.intake(WS, SID, [fileRef(data, "bills.csv", "text/csv")]);
    expect(got.files[0]!.text).toBe("name,amount\nrent,2400");
  });

  it("扫描件 PDF（转换器说 unsupported）：照收，写清读不出的原因", async () => {
    const data = new TextEncoder().encode("%PDF-1.4 scan");
    const { intake } = harness({ [`${WS}/${SID}/${hexOf(data)}.pdf`]: data }, { toText: async () => { throw Object.assign(new Error("x"), { code: "unsupported" }); } });
    const got = await intake.intake(WS, SID, [fileRef(data, "scan.pdf")]);
    expect(got.files[0]).toMatchObject({ path: "inbox/scan.pdf", textError: "这个 PDF 没有文字层（扫描件 / 图片）" });
    expect(got.files[0]!.text).toBeUndefined();
  });

  it("太长只给开头，说清往下读用 read_document", async () => {
    const data = new TextEncoder().encode("x".repeat(FILE_TEXT_MAX_CHARS + 10));
    const { intake } = harness({ [`${WS}/${SID}/${hexOf(data)}.txt`]: data });
    const got = await intake.intake(WS, SID, [fileRef(data, "long.txt", "text/plain")]);
    expect(got.files[0]!.text).toContain("read_document");
  });

  it("工作区存不进：文字照转，只是没有 path", async () => {
    const data = new TextEncoder().encode("hello");
    const { intake } = harness({ [`${WS}/${SID}/${hexOf(data)}.txt`]: data }, { saveFails: true });
    const got = await intake.intake(WS, SID, [fileRef(data, "a.txt", "text/plain")]);
    expect(got.files[0]).toMatchObject({ text: "hello" });
    expect(got.files[0]!.path).toBeUndefined();
  });

  it("对象不在 / 内容对不上：说给发言人的拒绝", async () => {
    const data = new TextEncoder().encode("hello");
    await expect(harness({}).intake.intake(WS, SID, [fileRef(data, "a.txt", "text/plain")])).rejects.toThrow(ChatMediaRejectedError);
    const other = new TextEncoder().encode("hellO");
    const { intake } = harness({ [`${WS}/${SID}/${hexOf(data)}.txt`]: other });
    await expect(intake.intake(WS, SID, [fileRef(data, "a.txt", "text/plain")])).rejects.toThrow(/对不上/);
  });
});

describe("工具交出去的文件（toolFiles 中间件）", () => {
  const ok = (files: ToolOutcome["files"]): (() => Promise<ToolOutcome>) => async () => ({ status: "ok", output: "做好了", ...(files !== undefined ? { files } : {}) });
  const ctx = { call: { id: "c1", name: "create_document", args: {} } } as Parameters<ReturnType<typeof createToolFileIntakeMiddleware>>[0];

  it("传进 chat-media/<团队>/<会话>/<sha256>.<ext>，回 ref；留一份字节给座位桥", async () => {
    const uploads: string[] = [];
    const recent = createRecentFiles();
    const mw = createToolFileIntakeMiddleware({ upload: async (b, p) => void uploads.push(`${b}:${p}`) }, { workspaceId: WS, sessionId: SID }, recent);
    const data = new TextEncoder().encode("%PDF-1.4 x");
    const out = await mw(ctx, ok([{ data, mimeType: PDF, name: "../x/报价单.pdf" }]));
    const hex = hexOf(data);
    expect(uploads).toEqual([`${CHAT_MEDIA_BUCKET}:${WS}/${SID}/${hex}.pdf`]);
    expect(out.fileRefs).toEqual([{ id: `sha256:${hex}`, name: "报价单.pdf", mediaType: PDF, bytes: data.byteLength }]);
    expect(out.output).toBe("做好了");
    expect(recent.get(`sha256:${hex}`)?.name).toBe("../x/报价单.pdf");
  });

  it("这条对话里已经交出过同一份（同一个 sha256）：不再传、不再出卡，回执说「上面那份就是」", async () => {
    const uploads: string[] = [];
    const data = new TextEncoder().encode("%PDF-1.4 same");
    const seen = new Set([`sha256:${hexOf(data)}`]);
    const mw = createToolFileIntakeMiddleware({ upload: async (b, p) => void uploads.push(`${b}:${p}`) }, { workspaceId: WS, sessionId: SID }, undefined, (id) => seen.has(id));
    const out = await mw(ctx, ok([{ data, mimeType: PDF, name: "deck.pdf" }]));
    expect(uploads).toEqual([]);
    expect(out.fileRefs).toBeUndefined();
    expect(out.output).toContain("上面那份就是");
  });

  it("传不上去 / 格式不收：跳过，output 末尾补一句实话", async () => {
    const mw = createToolFileIntakeMiddleware({ upload: async () => { throw new Error("网断了"); } }, { workspaceId: WS, sessionId: SID });
    const out = await mw(ctx, ok([{ data: new Uint8Array([1]), mimeType: PDF, name: "a.pdf" }, { data: new Uint8Array([1]), mimeType: "application/zip", name: "a.zip" }]));
    expect(out.fileRefs).toBeUndefined();
    expect(out.output).toContain("有 2 份文件没能发到聊天里");
  });
});
