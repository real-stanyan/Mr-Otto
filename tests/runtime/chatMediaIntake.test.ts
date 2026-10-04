// runtime 收云会话里发的图 / 视频（#1491，chatMediaIntake）：路径自己拼、下载后复算哈希、视频本体不下载。
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../../src/session/attachments.js";
import { CHAT_MEDIA_BUCKET, type ChatMediaRef } from "../../src/shared/chatMedia.js";
import { ChatMediaRejectedError, createChatMediaIntake } from "../../services/runtime/src/chatMediaIntake.js";
import { tempDir } from "../helpers/tempDir.js";

const jpeg = (tail: number[]): Uint8Array => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...tail]);
const hexOf = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

let dir: string;
beforeEach(() => { dir = tempDir("otto-chat-media-"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function harness(objects: Record<string, Uint8Array>) {
  const asked: string[] = [];
  const store = new AttachmentStore(dir);
  const intake = createChatMediaIntake({
    download: async (bucket, path) => {
      asked.push(`${bucket}:${path}`);
      const o = objects[path];
      if (o === undefined) throw new Error("Object not found");
      return o;
    },
    storeFor: () => store,
  });
  return { intake, asked, store };
}

const WS = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";

describe("图片", () => {
  it("按 <团队>/<会话>/<sha256>.jpg 去 chat-media 取，校验后落附件库，带上尺寸", async () => {
    const bytes = jpeg([1, 2, 3]);
    const sha = hexOf(bytes);
    const { intake, asked, store } = harness({ [`${WS}/${SID}/${sha}.jpg`]: bytes });
    const refs: ChatMediaRef[] = [{ kind: "image", sha256: sha, mediaType: "image/jpeg", bytes: bytes.byteLength, width: 640, height: 480 }];
    const got = await intake.intake(WS, SID, refs);
    expect(asked).toEqual([`${CHAT_MEDIA_BUCKET}:${WS}/${SID}/${sha}.jpg`]);
    expect(got.videos).toEqual([]);
    expect(got.attachments).toEqual([{ id: `sha256:${sha}`, mediaType: "image/jpeg", bytes: bytes.byteLength, width: 640, height: 480 }]);
    expect(Array.from(store.read(`sha256:${sha}`))).toEqual(Array.from(bytes));
  });

  it("对象不在：说给发言人的拒绝", async () => {
    const { intake } = harness({});
    const refs: ChatMediaRef[] = [{ kind: "image", sha256: "a".repeat(64), mediaType: "image/jpeg", bytes: 7, width: 0, height: 0 }];
    await expect(intake.intake(WS, SID, refs)).rejects.toBeInstanceOf(ChatMediaRejectedError);
    await expect(intake.intake(WS, SID, refs)).rejects.toThrow(/第 1 张图还没传完或已经不在了/);
  });

  it("名不副实：声称的哈希 / 大小与下载到的字节对不上，一个字节不进附件库", async () => {
    const bytes = jpeg([9, 9, 9]);
    const claimed = "a".repeat(64);
    const { intake, store } = harness({ [`${WS}/${SID}/${claimed}.jpg`]: bytes });
    const refs: ChatMediaRef[] = [{ kind: "image", sha256: claimed, mediaType: "image/jpeg", bytes: bytes.byteLength, width: 0, height: 0 }];
    await expect(intake.intake(WS, SID, refs)).rejects.toThrow(/对不上/);
    expect(() => store.read(`sha256:${hexOf(bytes)}`)).toThrow();
    const sha = hexOf(bytes);
    const { intake: intake2 } = harness({ [`${WS}/${SID}/${sha}.jpg`]: bytes });
    await expect(intake2.intake(WS, SID, [{ kind: "image", sha256: sha, mediaType: "image/jpeg", bytes: bytes.byteLength + 1, width: 0, height: 0 }])).rejects.toThrow(/对不上/);
  });

  it("不是图片的字节（哈希对得上也不行）：附件库的嗅探拒掉", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sha = hexOf(bytes);
    const { intake } = harness({ [`${WS}/${SID}/${sha}.png`]: bytes });
    await expect(intake.intake(WS, SID, [{ kind: "image", sha256: sha, mediaType: "image/png", bytes: 8, width: 0, height: 0 }])).rejects.toThrow(/收不了/);
  });
});

describe("视频", () => {
  it("本体不下载；封面按图片收，video.poster 指向它的附件 id", async () => {
    const poster = jpeg([4, 4]);
    const psha = hexOf(poster);
    const vsha = "b".repeat(64);
    const { intake, asked } = harness({ [`${WS}/${SID}/${psha}.jpg`]: poster });
    const got = await intake.intake(WS, SID, [
      { kind: "video", sha256: vsha, mediaType: "video/mp4", bytes: 5_000_000, width: 1280, height: 720, durationMs: 12_000, poster: { sha256: psha, bytes: poster.byteLength } },
    ]);
    expect(asked).toEqual([`${CHAT_MEDIA_BUCKET}:${WS}/${SID}/${psha}.jpg`]);
    expect(got.videos).toEqual([{ id: `sha256:${vsha}`, mediaType: "video/mp4", bytes: 5_000_000, width: 1280, height: 720, durationMs: 12_000, poster: `sha256:${psha}` }]);
    expect(got.attachments).toEqual([{ id: `sha256:${psha}`, mediaType: "image/jpeg", bytes: poster.byteLength, name: "视频封面", width: 1280, height: 720 }]);
  });

  it("没封面：什么都不下载，attachments 空", async () => {
    const { intake, asked } = harness({});
    const got = await intake.intake(WS, SID, [
      { kind: "video", sha256: "b".repeat(64), mediaType: "video/quicktime", bytes: 100, width: 0, height: 0, durationMs: 3_000 },
    ]);
    expect(asked).toEqual([]);
    expect(got.attachments).toEqual([]);
    expect(got.videos[0]?.poster).toBeUndefined();
  });
});
