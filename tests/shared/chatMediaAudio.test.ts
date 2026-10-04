// 语音消息进媒体那一格（#1492，ADR-0351）：kind:"audio" 的严格解析、占位、一条一个、发送带时长与转写；云会话这一期不收。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUDIO_MAX_MS, TRANSCRIPT_MAX_CHARS, mediaBodyHidden, mediaPlaceholder, parseDmMedia, planMediaMessages, sendMediaMessage,
  type ChatMediaItem, type PreparedMedia,
} from "../../src/shared/chatMedia.js";
import { sendCloudMedia } from "../../src/shared/chatMediaCloud.js";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";
const aud = (over: Partial<ChatMediaItem> = {}): ChatMediaItem => ({
  kind: "audio", path: `${A}/${B}/${U}.m4a`, mediaType: "audio/mp4", bytes: 40_000, width: 0, height: 0, durationMs: 4_200, transcript: "在吗", ...over,
});

describe("parseDmMedia 的 audio", () => {
  it("合规的原样回来；转写缺席也行", () => {
    expect(parseDmMedia([aud()], A, B)).toEqual([aud()]);
    const noText = aud();
    delete noText.transcript;
    expect(parseDmMedia([noText], A, B)).toEqual([noText]);
  });
  it("格式 / 时长 / 大小 / 尺寸 / 封面 / 转写长度任一不对整份丢", () => {
    expect(parseDmMedia([aud({ mediaType: "audio/mpeg" })], A, B)).toBeNull();
    expect(parseDmMedia([aud({ durationMs: AUDIO_MAX_MS + 1 })], A, B)).toBeNull();
    expect(parseDmMedia([{ ...aud(), durationMs: undefined } as unknown as ChatMediaItem], A, B)).toBeNull();
    expect(parseDmMedia([aud({ bytes: 6 * 1024 * 1024 })], A, B)).toBeNull();
    expect(parseDmMedia([aud({ width: 1 })], A, B)).toBeNull();
    expect(parseDmMedia([aud({ poster: `${A}/${B}/${U}.poster.jpg` })], A, B)).toBeNull();
    expect(parseDmMedia([aud({ transcript: "x".repeat(TRANSCRIPT_MAX_CHARS + 1) })], A, B)).toBeNull();
    expect(parseDmMedia([{ ...aud(), transcript: 1 } as unknown as ChatMediaItem], A, B)).toBeNull();
  });
  it("占位正文 [语音]，正文就是占位时藏字", () => {
    expect(mediaPlaceholder([aud()])).toBe("[语音]");
    expect(mediaBodyHidden("[语音]", [aud()])).toBe(true);
    expect(mediaBodyHidden("听听", [aud()])).toBe(false);
  });
});

describe("planMediaMessages / sendMediaMessage 的 audio", () => {
  const prepared = (over: Partial<PreparedMedia> = {}): PreparedMedia => ({
    kind: "audio", uri: "file:///v.m4a", mediaType: "audio/mp4", bytes: 40_000, width: 0, height: 0, durationMs: 4_200, transcript: "在吗", ...over,
  });
  it("语音一条一个，不和图片攒（图片照旧攒进它们那一条，同视频的规矩）", () => {
    const img = { kind: "image" as const };
    expect(planMediaMessages([img, { kind: "audio" as const }, img])).toEqual([[img, img], [{ kind: "audio" }]]);
  });
  it("发出去的那一格带时长与转写；转写空的不带、超长截断", async () => {
    const seen: ChatMediaItem[][] = [];
    const deps = {
      newId: () => U,
      upload: async () => undefined,
      remove: async () => undefined,
      insert: async (_body: string, media: ChatMediaItem[]) => { seen.push(media); return { body: _body }; },
    };
    const r = await sendMediaMessage(deps, A, B, [prepared()]);
    expect(r).toEqual({ body: "[语音]" });
    expect(seen[0]).toEqual([{ kind: "audio", path: `${A}/${B}/${U}.m4a`, mediaType: "audio/mp4", bytes: 40_000, width: 0, height: 0, durationMs: 4_200, transcript: "在吗" }]);
    await sendMediaMessage(deps, A, B, [prepared({ transcript: "" })]);
    expect(seen[1]?.[0]?.transcript).toBeUndefined();
    await sendMediaMessage(deps, A, B, [prepared({ transcript: "x".repeat(TRANSCRIPT_MAX_CHARS + 5) })]);
    expect(seen[2]?.[0]?.transcript?.length).toBe(TRANSCRIPT_MAX_CHARS);
  });
  it("云会话这一期不收语音", async () => {
    await expect(sendCloudMedia(A, B, [prepared()], { hash: () => "a".repeat(64), fileSize: () => 1, upload: async () => undefined, send: async () => ({ ok: true }) })).rejects.toThrow(/语音/);
  });
});

describe("0055 迁移文本", () => {
  it("两个 bucket 都放行 audio/mp4，原来四种还在", () => {
    const sql = read("supabase/migrations/0055_media_audio.sql");
    expect(sql.match(/array\['image\/jpeg', 'image\/png', 'video\/mp4', 'video\/quicktime', 'audio\/mp4'\]/g)?.length).toBe(2);
    expect(read("supabase/checks/0055_media_audio.check.sql")).toMatch(/'audio\/mp4' = any\(allowed_mime_types\)/);
  });
});
