// 云会话发图的手机编排（#1491 P3，chatMediaCloud）：逐个算哈希、传进 chat-media、引用塞进 say；对象已存在算成功；
// 引用最后过 parseChatMediaRefs。
import { describe, expect, it } from "vitest";
import { CHAT_MEDIA_BUCKET, type ChatMediaRef, type PreparedMedia } from "../../src/shared/chatMedia.js";
import { alreadyThere, sendCloudMedia } from "../../src/shared/chatMediaCloud.js";
import { chatMediaItemsOf } from "../../src/shared/chatMedia.js";

const WS = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";
const hashes: Record<string, string> = { "file:///a.jpg": "a".repeat(64), "file:///b.mp4": "b".repeat(64), "file:///b.jpg": "c".repeat(64) };
const sizes: Record<string, number> = { "file:///a.jpg": 1234, "file:///b.mp4": 5_000_000, "file:///b.jpg": 20_000 };

function harness(opts: { failUpload?: (path: string) => Error | null } = {}) {
  const uploads: string[] = [];
  let sent: ChatMediaRef[] | null = null;
  const progress: number[] = [];
  const deps = {
    hash: (uri: string) => hashes[uri] ?? "0".repeat(64),
    fileSize: (uri: string) => sizes[uri] ?? 0,
    upload: async (bucket: string, path: string) => {
      uploads.push(`${bucket}:${path}`);
      const err = opts.failUpload?.(path) ?? null;
      if (err !== null) throw err;
    },
    send: async (refs: ChatMediaRef[]) => {
      sent = refs;
      return { ok: true as const };
    },
    onProgress: (f: number) => progress.push(f),
  };
  return { deps, uploads, progress, sent: () => sent };
}

describe("sendCloudMedia", () => {
  it("几张图：每张算哈希、传到 <团队>/<会话>/<sha>.jpg，引用带尺寸与大小，进度一张一步", async () => {
    const h = harness();
    const items: PreparedMedia[] = [{ kind: "image", uri: "file:///a.jpg", mediaType: "image/jpeg", bytes: 0, width: 640.4, height: 480 }];
    const r = await sendCloudMedia(WS, SID, items, h.deps);
    expect(r).toEqual({ ok: true });
    expect(h.uploads).toEqual([`${CHAT_MEDIA_BUCKET}:${WS}/${SID}/${"a".repeat(64)}.jpg`]);
    expect(h.sent()).toEqual([{ kind: "image", sha256: "a".repeat(64), mediaType: "image/jpeg", bytes: 1234, width: 640, height: 480 }]);
    expect(h.progress).toEqual([1]);
  });

  it("一段视频 + 封面：本体与封面各传一次，引用带时长与封面；没封面就只传本体", async () => {
    const h = harness();
    const items: PreparedMedia[] = [{ kind: "video", uri: "file:///b.mp4", mediaType: "video/mp4", bytes: 0, width: 1280, height: 720, durationMs: 12_000, posterUri: "file:///b.jpg" }];
    await sendCloudMedia(WS, SID, items, h.deps);
    expect(h.uploads).toEqual([
      `${CHAT_MEDIA_BUCKET}:${WS}/${SID}/${"b".repeat(64)}.mp4`,
      `${CHAT_MEDIA_BUCKET}:${WS}/${SID}/${"c".repeat(64)}.jpg`,
    ]);
    expect(h.sent()).toEqual([{
      kind: "video", sha256: "b".repeat(64), mediaType: "video/mp4", bytes: 5_000_000, width: 1280, height: 720, durationMs: 12_000,
      poster: { sha256: "c".repeat(64), bytes: 20_000 },
    }]);
    expect(h.progress).toEqual([0.5, 1]);
    const h2 = harness();
    await sendCloudMedia(WS, SID, [{ kind: "video", uri: "file:///b.mp4", mediaType: "video/mp4", bytes: 0, width: 0, height: 0, durationMs: 3_000 }], h2.deps);
    expect(h2.uploads).toHaveLength(1);
    expect(h2.sent()?.[0]?.poster).toBeUndefined();
  });

  it("对象已经在了（按内容寻址）：算传成功；别的上传错误原样抛、不发 say", async () => {
    const ok = harness({ failUpload: () => new Error("上传失败：The resource already exists") });
    await sendCloudMedia(WS, SID, [{ kind: "image", uri: "file:///a.jpg", mediaType: "image/jpeg", bytes: 0, width: 1, height: 1 }], ok.deps);
    expect(ok.sent()).not.toBeNull();
    const bad = harness({ failUpload: () => new Error("上传失败（413）") });
    await expect(sendCloudMedia(WS, SID, [{ kind: "image", uri: "file:///a.jpg", mediaType: "image/jpeg", bytes: 0, width: 1, height: 1 }], bad.deps)).rejects.toThrow(/413/);
    expect(bad.sent()).toBeNull();
    expect(alreadyThere(new Error("Duplicate"))).toBe(true);
    expect(alreadyThere(new Error("timeout"))).toBe(false);
  });

  it("格式不在白名单：拼路径那一步就拒，一个字节不传、不发", async () => {
    const h = harness();
    await expect(sendCloudMedia(WS, SID, [{ kind: "image", uri: "file:///a.jpg", mediaType: "image/heic", bytes: 0, width: 1, height: 1 }], h.deps)).rejects.toThrow(/发不了/);
    expect(h.uploads).toEqual([]);
    expect(h.sent()).toBeNull();
  });
});

describe("chatMediaItemsOf（事件里那两格 → 气泡）", () => {
  const id = (c: string): string => "sha256:" + c.repeat(64);
  it("图按对象名拼回路径；封面只跟着视频走", () => {
    const items = chatMediaItemsOf(WS, SID,
      [
        { id: id("a"), mediaType: "image/jpeg", bytes: 10, width: 640, height: 480 },
        { id: id("c"), mediaType: "image/jpeg", bytes: 20, name: "视频封面", width: 1280, height: 720 },
      ],
      [{ id: id("b"), mediaType: "video/mp4", bytes: 5_000_000, width: 1280, height: 720, durationMs: 12_000, poster: id("c") }],
    );
    expect(items).toEqual([
      { kind: "image", path: `${WS}/${SID}/${"a".repeat(64)}.jpg`, mediaType: "image/jpeg", bytes: 10, width: 640, height: 480 },
      { kind: "video", path: `${WS}/${SID}/${"b".repeat(64)}.mp4`, mediaType: "video/mp4", bytes: 5_000_000, width: 1280, height: 720, durationMs: 12_000, poster: `${WS}/${SID}/${"c".repeat(64)}.jpg` },
    ]);
  });
  it("认不出的跳过：不是 sha256 id、格式不在白名单（桌面的 webp）；两格都缺是空数组", () => {
    expect(chatMediaItemsOf(WS, SID, [{ id: "x", mediaType: "image/jpeg", bytes: 1 }, { id: id("a"), mediaType: "image/webp", bytes: 1 }], undefined)).toEqual([]);
    expect(chatMediaItemsOf(WS, SID, undefined, undefined)).toEqual([]);
    expect(chatMediaItemsOf(WS, SID, [{ id: id("a"), mediaType: "image/png", bytes: 1 }], undefined)[0]).toMatchObject({ kind: "image", width: 0, height: 0 });
  });
});
