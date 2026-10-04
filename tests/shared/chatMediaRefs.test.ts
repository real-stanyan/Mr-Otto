// say 帧里的媒体引用（#1491，协议 24）：parseChatMediaRefs 的严格解析与 videoNoteForModel 那一行。
// 一处不对整份回 null——调用方据此拒帧，不降级成「没带媒体」。
import { describe, expect, it } from "vitest";
import {
  IMAGE_MAX_BYTES, MEDIA_MAX_PER_MESSAGE, VIDEO_MAX_BYTES, VIDEO_MAX_MS, parseChatMediaRefs, videoNoteForModel,
} from "../../src/shared/chatMedia.js";
import { CS_PROTOCOL_VERSION, decodeCsUp, encodeCs } from "../../src/shared/remote/cloudSession.js";

const hex = (c: string): string => c.repeat(64);
const img = (c = "a") => ({ kind: "image" as const, sha256: hex(c), mediaType: "image/jpeg" as const, bytes: 1234, width: 640, height: 480 });
const vid = (c = "b") => ({ kind: "video" as const, sha256: hex(c), mediaType: "video/mp4" as const, bytes: 5_000_000, width: 1280, height: 720, durationMs: 12_000 });

describe("parseChatMediaRefs", () => {
  it("几张图：原样回来，顺序不变", () => {
    expect(parseChatMediaRefs([img("a"), img("c"), img("d")])).toEqual([img("a"), img("c"), img("d")]);
  });
  it("一段视频，带封面或不带", () => {
    expect(parseChatMediaRefs([vid()])).toEqual([vid()]);
    const withPoster = { ...vid(), poster: { sha256: hex("c"), bytes: 20_000 } };
    expect(parseChatMediaRefs([withPoster])).toEqual([withPoster]);
  });
  it("空数组 / 超过 9 个 / 不是数组：null", () => {
    expect(parseChatMediaRefs([])).toBeNull();
    expect(parseChatMediaRefs(Array.from({ length: MEDIA_MAX_PER_MESSAGE + 1 }, (_, i) => img(String.fromCharCode(97 + i))))).toBeNull();
    expect(parseChatMediaRefs("x")).toBeNull();
    expect(parseChatMediaRefs(undefined)).toBeNull();
  });
  it("要么全图片、要么恰好一段视频（同 planMediaMessages 的拆法）", () => {
    expect(parseChatMediaRefs([img("a"), vid("b")])).toBeNull();
    expect(parseChatMediaRefs([vid("a"), vid("b")])).toBeNull();
  });
  it("同一个哈希出现两次：null（按内容寻址的列表里重复只能是客户端的 bug）", () => {
    expect(parseChatMediaRefs([img("a"), img("a")])).toBeNull();
  });
  it("哈希要 64 位小写十六进制；格式要在白名单里；kind 与格式要配", () => {
    expect(parseChatMediaRefs([{ ...img(), sha256: "A".repeat(64) }])).toBeNull();
    expect(parseChatMediaRefs([{ ...img(), sha256: "a".repeat(63) }])).toBeNull();
    expect(parseChatMediaRefs([{ ...img(), mediaType: "image/heic" }])).toBeNull();
    expect(parseChatMediaRefs([{ ...img(), mediaType: "video/mp4" }])).toBeNull();
    expect(parseChatMediaRefs([{ ...vid(), mediaType: "image/jpeg" }])).toBeNull();
    expect(parseChatMediaRefs([{ ...img(), kind: "audio" }])).toBeNull();
  });
  it("大小 / 时长 / 尺寸的上限", () => {
    expect(parseChatMediaRefs([{ ...img(), bytes: IMAGE_MAX_BYTES + 1 }])).toBeNull();
    expect(parseChatMediaRefs([{ ...img(), bytes: 0 }])).toBeNull();
    expect(parseChatMediaRefs([{ ...vid(), bytes: VIDEO_MAX_BYTES + 1 }])).toBeNull();
    expect(parseChatMediaRefs([{ ...vid(), durationMs: VIDEO_MAX_MS + 1 }])).toBeNull();
    expect(parseChatMediaRefs([{ ...vid(), durationMs: undefined }])).toBeNull();
    expect(parseChatMediaRefs([{ ...img(), width: -1 }])).toBeNull();
    expect(parseChatMediaRefs([{ ...img(), width: 1.5 }])).toBeNull();
    expect(parseChatMediaRefs([{ ...img(), width: 0, height: 0 }])).toEqual([{ ...img(), width: 0, height: 0 }]);
  });
  it("图片不许带 durationMs / poster；封面的哈希与大小同样严格", () => {
    expect(parseChatMediaRefs([{ ...img(), durationMs: 1 }])).toBeNull();
    expect(parseChatMediaRefs([{ ...img(), poster: { sha256: hex("c"), bytes: 1 } }])).toBeNull();
    expect(parseChatMediaRefs([{ ...vid(), poster: { sha256: "zz", bytes: 1 } }])).toBeNull();
    expect(parseChatMediaRefs([{ ...vid(), poster: { sha256: hex("c"), bytes: IMAGE_MAX_BYTES + 1 } }])).toBeNull();
    expect(parseChatMediaRefs([{ ...vid(), poster: "c".repeat(64) }])).toBeNull();
  });
});

describe("videoNoteForModel", () => {
  it("没视频：null", () => {
    expect(videoNoteForModel([])).toBeNull();
  });
  it("有封面说封面在上面；没封面说没有封面可看；时长用 videoDurationLabel 的写法", () => {
    expect(videoNoteForModel([{ durationMs: 12_000, hasPoster: true }])).toBe("[发了一段 0:12 的视频，上面那张图是它的封面]");
    expect(videoNoteForModel([{ durationMs: 65_000, hasPoster: false }])).toBe("[发了一段 1:05 的视频，没有封面可看]");
  });
});

describe("say 帧的 media 一格（协议 24）", () => {
  it("协议号 27（#1534 之后）", () => {
    expect(CS_PROTOCOL_VERSION).toBe(27);
  });
  it("带着往返；缺席不进帧", () => {
    const frame = encodeCs({ t: "say", text: "看这张", mention: false, media: [img()] });
    expect(decodeCsUp(frame)).toEqual({ t: "say", text: "看这张", mention: false, media: [img()] });
    expect(decodeCsUp(encodeCs({ t: "say", text: "在吗", mention: true }))).toEqual({ t: "say", text: "在吗", mention: true });
  });
  it("形状不对整帧拒掉，不降级成没带媒体", () => {
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
    expect(decodeCsUp(b64({ t: "say", text: "x", mention: false, media: [] }))).toBeNull();
    expect(decodeCsUp(b64({ t: "say", text: "x", mention: false, media: [{ ...img(), sha256: "nope" }] }))).toBeNull();
    expect(decodeCsUp(b64({ t: "say", text: "x", mention: false, media: "x" }))).toBeNull();
  });
  it("正文可以为空（纯发图）", () => {
    expect(decodeCsUp(encodeCs({ t: "say", text: "", mention: false, media: [img()] }))).toEqual({ t: "say", text: "", mention: false, media: [img()] });
  });
});
