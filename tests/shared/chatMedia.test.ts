// chatMedia —— 聊天里发图片和视频的纯判据（#1443 P1，ADR-0343）：上限、jsonb 那一格的严格解析、占位正文、
// 路径、一次挑了好几样时怎么拆成几条消息、图片要不要重编码与阶梯、视频收不收。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHAT_MEDIA_BUCKET, DM_MEDIA_BUCKET, IMAGE_MAX_EDGE, MEDIA_MAX_PER_MESSAGE, MEDIA_PLACEHOLDER, VIDEO_MAX_BYTES,
  VIDEO_MAX_MS, chatMediaPath, dmMediaPath, dmPosterPath, extForMime, fitImageSteps, imageNeedsReencode,
  mediaBodyHidden, mediaBubbleBox, mediaPlaceholder, parseChatMedia, parseDmMedia, planMediaMessages,
  videoDurationLabel, videoProblem, sendMediaMessage, missingMediaColumn, type ChatMediaItem,
} from "../../src/shared/chatMedia.js";
import { IMAGE_FIT_LADDER, IMAGE_FIT_TARGET_BYTES } from "../../src/shared/imageFit.js";
import { dmPreview } from "../../src/shared/wechatInbox.js";
import { friendMessageOf, friendPushOf } from "../../services/runtime/src/friendPush.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";

const img = (over: Partial<ChatMediaItem> = {}): ChatMediaItem => ({
  kind: "image", path: `${A}/${B}/${U}.jpg`, mediaType: "image/jpeg", bytes: 1000, width: 800, height: 600, ...over,
});
const vid = (over: Partial<ChatMediaItem> = {}): ChatMediaItem => ({
  kind: "video", path: `${A}/${B}/${U}.mov`, mediaType: "video/quicktime", bytes: 5_000_000, width: 1080, height: 1920,
  durationMs: 7_000, poster: `${A}/${B}/${U}.poster.jpg`, ...over,
});

describe("上限", () => {
  it("一条最多 9 张；图片长边 2048、≤4MB 与 imageFit 同一份；视频 60 秒 50MB", () => {
    expect(MEDIA_MAX_PER_MESSAGE).toBe(9);
    expect(IMAGE_MAX_EDGE).toBe(IMAGE_FIT_LADDER[0]?.edge);
    expect(VIDEO_MAX_MS).toBe(60_000);
    expect(VIDEO_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(DM_MEDIA_BUCKET).toBe("dm-media");
    expect(CHAT_MEDIA_BUCKET).toBe("chat-media");
  });
});

describe("parseChatMedia：形状不对整份丢掉", () => {
  it("缺席 / null：null", () => {
    expect(parseChatMedia(undefined)).toBeNull();
    expect(parseChatMedia(null)).toBeNull();
  });
  it("合法的图片与视频原样回来（多余的字段剥掉）", () => {
    expect(parseChatMedia([{ ...img(), extra: 1 }, vid()])).toEqual([img(), vid()]);
  });
  it("视频没有封面也收", () => {
    const { poster: _p, ...noPoster } = vid();
    expect(parseChatMedia([noPoster])).toEqual([noPoster]);
  });
  it("不是数组 / 空数组 / 超过 9 个：null", () => {
    expect(parseChatMedia({})).toBeNull();
    expect(parseChatMedia([])).toBeNull();
    expect(parseChatMedia(Array.from({ length: 10 }, () => img()))).toBeNull();
  });
  it("一格不对整份 null（不留半份：九宫格少一张比整条说「[图片]」更难懂）", () => {
    expect(parseChatMedia([img(), { ...img(), kind: "gif" }])).toBeNull();
    expect(parseChatMedia([img({ mediaType: "image/heic" })])).toBeNull();
    expect(parseChatMedia([img({ mediaType: "video/mp4" })])).toBeNull();
    expect(parseChatMedia([img({ bytes: 0 })])).toBeNull();
    expect(parseChatMedia([img({ bytes: 1.5 })])).toBeNull();
    expect(parseChatMedia([img({ width: -1 })])).toBeNull();
    expect(parseChatMedia([img({ path: "" })])).toBeNull();
    expect(parseChatMedia([img({ path: `${A}/../x.jpg` })])).toBeNull();
    expect(parseChatMedia([img({ path: `/${A}/x.jpg` })])).toBeNull();
    expect(parseChatMedia([vid({ durationMs: -5 })])).toBeNull();
    expect(parseChatMedia([vid({ poster: 3 as unknown as string })])).toBeNull();
    expect(parseChatMedia([{ ...img(), durationMs: 5 }])).toBeNull();
  });
  it("宽高读不出（0）照收：系统没给就是没给，界面按方块画", () => {
    expect(parseChatMedia([img({ width: 0, height: 0 })])).toEqual([img({ width: 0, height: 0 })]);
  });
});

describe("parseDmMedia：路径必须落在这一对人的目录下", () => {
  it("发送方 / 接收方对得上：收", () => {
    expect(parseDmMedia([img(), vid()], A, B)).toEqual([img(), vid()]);
  });
  it("引用了别的对话里的对象（读的人恰好读得到）：整份丢", () => {
    expect(parseDmMedia([img({ path: `${A}/${U}/${U}.jpg` })], A, B)).toBeNull();
    expect(parseDmMedia([vid({ poster: `${B}/${A}/${U}.poster.jpg` })], A, B)).toBeNull();
  });
});

describe("占位正文", () => {
  it("全是图片 [图片]、全是视频 [视频]、混着两样都写", () => {
    expect(mediaPlaceholder([img(), img()])).toBe(MEDIA_PLACEHOLDER.image);
    expect(mediaPlaceholder([vid()])).toBe(MEDIA_PLACEHOLDER.video);
    expect(mediaPlaceholder([img(), vid()])).toBe("[图片][视频]");
    expect(MEDIA_PLACEHOLDER).toEqual({ image: "[图片]", video: "[视频]" });
  });
  it("占位过得了 messages.body 的 1..4000 那条 check", () => {
    for (const p of [mediaPlaceholder([img()]), mediaPlaceholder([vid()]), mediaPlaceholder([img(), vid()])]) {
      expect(p.length).toBeGreaterThanOrEqual(1);
      expect(p.length).toBeLessThanOrEqual(4000);
    }
  });
  it("新客户端：带着媒体且正文就是占位才藏；没媒体（老客户端 / 解析失败）照画字", () => {
    expect(mediaBodyHidden("[图片]", [img()])).toBe(true);
    expect(mediaBodyHidden("[视频]", [vid()])).toBe(true);
    expect(mediaBodyHidden("[图片]", null)).toBe(false);
    expect(mediaBodyHidden("看这个", [img()])).toBe(false);
    expect(mediaBodyHidden("[视频]", [img()])).toBe(false);
  });
  it("老路径照常降级：会话列表第二行与推送正文就是占位", () => {
    expect(dmPreview("[图片]")).toBe("[图片]");
    expect(dmPreview("[视频]")).toBe("[视频]");
    // runtime 订到的那一行多了一格 media：照样认得出来，推的正文就是占位
    const row = friendMessageOf({ id: 7, sender: A, recipient: B, body: "[视频]", media: [vid()] });
    expect(row).not.toBeNull();
    if (row !== null) expect(friendPushOf(row, "小红").body).toBe("[视频]");
  });
});

describe("路径", () => {
  it("朋友私聊：<发送方>/<接收方>/<uuid>.<扩展名>，封面同目录", () => {
    expect(dmMediaPath(A, B, U, "image/jpeg")).toBe(`${A}/${B}/${U}.jpg`);
    expect(dmMediaPath(A, B, U, "video/quicktime")).toBe(`${A}/${B}/${U}.mov`);
    expect(dmPosterPath(A, B, U)).toBe(`${A}/${B}/${U}.poster.jpg`);
  });
  it("云会话：<团队>/<会话>/<sha256>", () => {
    const sha = "a".repeat(64);
    expect(chatMediaPath(A, B, sha, "image/png")).toBe(`${A}/${B}/${sha}.png`);
  });
  it("段里有斜杠、不是 uuid / sha、或格式不认：抛", () => {
    expect(() => dmMediaPath("x/y", B, U, "image/jpeg")).toThrow();
    expect(() => dmMediaPath(A, B, "not-a-uuid", "image/jpeg")).toThrow();
    expect(() => chatMediaPath(A, B, "abc", "image/jpeg")).toThrow();
    expect(() => dmMediaPath(A, B, U, "image/heic")).toThrow();
  });
  it("扩展名", () => {
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("video/mp4")).toBe("mp4");
    expect(extForMime("video/quicktime")).toBe("mov");
    expect(extForMime("image/gif")).toBeNull();
  });
});

describe("planMediaMessages：图片攒成一条（满 9 换下一条），视频一条一个", () => {
  it("顺序跟挑的顺序走", () => {
    const picks = ["i1", "v1", "i2", "i3", "v2"].map((id) => ({ id, kind: id.startsWith("i") ? "image" as const : "video" as const }));
    expect(planMediaMessages(picks).map((g) => g.map((p) => p.id))).toEqual([["i1", "i2", "i3"], ["v1"], ["v2"]]);
  });
  it("12 张图拆成 9 + 3", () => {
    const picks = Array.from({ length: 12 }, (_, i) => ({ id: i, kind: "image" as const }));
    expect(planMediaMessages(picks).map((g) => g.length)).toEqual([9, 3]);
  });
  it("空：空", () => {
    expect(planMediaMessages([])).toEqual([]);
  });
});

describe("imageNeedsReencode", () => {
  it("小的 JPEG / PNG 原样传（截图别白转一道把小字糊掉）", () => {
    expect(imageNeedsReencode({ mimeType: "image/png", bytes: 300_000, width: 1170, height: 2532 })).toBe(true);
    expect(imageNeedsReencode({ mimeType: "image/png", bytes: 300_000, width: 1000, height: 2000 })).toBe(false);
    expect(imageNeedsReencode({ mimeType: "image/jpeg", bytes: 300_000, width: 2048, height: 1536 })).toBe(false);
  });
  it("HEIC / 认不出格式 / 超长边 / 超字节：重编码成 JPEG", () => {
    expect(imageNeedsReencode({ mimeType: "image/heic", bytes: 10, width: 10, height: 10 })).toBe(true);
    expect(imageNeedsReencode({ mimeType: undefined, bytes: 10, width: 10, height: 10 })).toBe(true);
    expect(imageNeedsReencode({ mimeType: "image/jpeg", bytes: 10, width: 4032, height: 3024 })).toBe(true);
    expect(imageNeedsReencode({ mimeType: "image/jpeg", bytes: IMAGE_FIT_TARGET_BYTES + 1, width: 10, height: 10 })).toBe(true);
  });
  it("字节数读不出：重编码（宁可多转一次，也别把一张 12MB 的原图原样推上去）", () => {
    expect(imageNeedsReencode({ mimeType: "image/jpeg", bytes: undefined, width: 10, height: 10 })).toBe(true);
  });
});

describe("fitImageSteps：一级一级试，每级量真实字节", () => {
  it("第一级就够：停在第一级", async () => {
    const seen: number[] = [];
    const r = await fitImageSteps(async (edge) => {
      seen.push(edge);
      return { bytes: 100, out: edge };
    });
    expect(r).toEqual({ kind: "fit", out: 2048 });
    expect(seen).toEqual([2048]);
  });
  it("往下试到够为止", async () => {
    const r = await fitImageSteps(async (edge) => ({ bytes: edge >= 1600 ? IMAGE_FIT_TARGET_BYTES + 1 : 10, out: edge }));
    expect(r).toEqual({ kind: "fit", out: 1280 });
  });
  it("最底一级仍超：stillTooBig 带最小的字节数", async () => {
    const r = await fitImageSteps(async (edge) => ({ bytes: IMAGE_FIT_TARGET_BYTES + edge, out: edge }));
    expect(r).toEqual({ kind: "stillTooBig", bytes: IMAGE_FIT_TARGET_BYTES + 1024 });
  });
});

describe("videoProblem", () => {
  it("合规：null", () => {
    expect(videoProblem({ durationMs: 59_000, bytes: 10_000_000, mimeType: "video/mp4" })).toBeNull();
    expect(videoProblem({ durationMs: 60_000, bytes: VIDEO_MAX_BYTES, mimeType: "video/quicktime" })).toBeNull();
  });
  it("超时长 / 超大小 / 格式不认 / 时长读不出：各说各的", () => {
    expect(videoProblem({ durationMs: 61_000, bytes: 10, mimeType: "video/mp4" })).toMatch(/60 秒/);
    expect(videoProblem({ durationMs: 1000, bytes: VIDEO_MAX_BYTES + 1, mimeType: "video/mp4" })).toMatch(/50MB/);
    expect(videoProblem({ durationMs: 1000, bytes: 10, mimeType: "video/x-matroska" })).toMatch(/格式/);
    expect(videoProblem({ durationMs: null, bytes: 10, mimeType: "video/mp4" })).toMatch(/时长/);
  });
  it("大小读不出：放行（上传那一刻 bucket 的上限会挡，那时再说）", () => {
    expect(videoProblem({ durationMs: 1000, bytes: undefined, mimeType: "video/mp4" })).toBeNull();
  });
});

describe("界面小函数", () => {
  it("时长写成 m:ss，不足一秒算一秒", () => {
    expect(videoDurationLabel(7_000)).toBe("0:07");
    expect(videoDurationLabel(59_400)).toBe("0:59");
    expect(videoDurationLabel(300)).toBe("0:01");
    expect(videoDurationLabel(61_000)).toBe("1:01");
  });
  it("气泡里单张的尺寸：长边封顶、短边有底、宽高读不出画方块", () => {
    expect(mediaBubbleBox(4000, 3000)).toEqual({ width: 200, height: 150 });
    expect(mediaBubbleBox(1080, 1920)).toEqual({ width: 113, height: 200 });
    expect(mediaBubbleBox(4000, 400)).toEqual({ width: 200, height: 80 });
    expect(mediaBubbleBox(0, 0)).toEqual({ width: 160, height: 160 });
  });
});

describe("0052：两个私有 bucket + messages.media", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/0052_chat_media.sql", import.meta.url), "utf8");
  it("两个 bucket 都私有、有大小与格式上限（重跑会把上限改回这一份）", () => {
    expect(sql).toMatch(/'dm-media', 'dm-media', false/);
    expect(sql).toMatch(/'chat-media', 'chat-media', false/);
    expect(sql).toMatch(/file_size_limit = excluded\.file_size_limit/);
    expect(sql).toMatch(/52428800/);
    for (const m of ["image/jpeg", "image/png", "video/mp4", "video/quicktime"]) expect(sql).toContain(`'${m}'`);
    expect(sql).not.toContain("image/heic");
  });
  it("私聊：只能往自己开头、对方是已接受好友的目录写；收发双方读", () => {
    expect(sql).toMatch(/create policy "dm_media_insert"[\s\S]*?\(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text[\s\S]*?status = 'accepted'/);
    expect(sql).toMatch(/create policy "dm_media_select"[\s\S]*?\(storage\.foldername\(name\)\)\[2\] = auth\.uid\(\)::text/);
  });
  it("没有 update 策略（路径带随机 id、对象不可改）；云会话的对象客户端删不掉（P6 由 runtime 收）", () => {
    expect(sql).not.toMatch(/for update to authenticated/);
    expect(sql).not.toMatch(/"chat_media_delete/);
  });
  it("云会话：在籍成员或这条会话的客人，且会话真的属于那个团队", () => {
    expect(sql).toMatch(/is_ws_member\(s\.workspace_id, auth\.uid\(\)\)/);
    expect(sql).toMatch(/is_session_guest\(s\.id::text, auth\.uid\(\)\)/);
    expect(sql).toMatch(/s\.workspace_id::text = \(storage\.foldername\(name\)\)\[1\]/);
  });
  it("messages.media：可空、1..9 个的数组，body 那条 check 不动", () => {
    expect(sql).toMatch(/alter table public\.messages add column if not exists media jsonb/);
    expect(sql).toMatch(/between 1 and 9/);
    expect(sql).not.toMatch(/drop constraint[\s\S]*body/);
  });
});

describe("sendMediaMessage：先传文件、再写消息；半路失败把传上去的收掉", () => {
  const ids = [U, "44444444-4444-4444-8444-444444444444"];
  function deps(o: { failUpload?: string; failInsert?: boolean } = {}) {
    const log: string[] = [];
    let n = 0;
    return {
      log,
      d: {
        newId: () => ids[n++] ?? "55555555-5555-4555-8555-555555555555",
        upload: async (path: string, uri: string, mime: string, onProgress: (sent: number) => void) => {
          if (o.failUpload !== undefined && path.endsWith(o.failUpload)) throw new Error("网断了");
          onProgress(50);
          log.push(`up ${path} ${uri} ${mime}`);
        },
        remove: async (paths: string[]) => {
          log.push(`rm ${paths.join(",")}`);
        },
        insert: async (body: string, media: ChatMediaItem[]) => {
          if (o.failInsert === true) throw new Error("不是好友了");
          log.push(`insert ${body} ${media.length}`);
          return { id: 1, body, media };
        },
      },
    };
  }
  const photo = { kind: "image" as const, uri: "file:///a.jpg", mediaType: "image/jpeg", bytes: 100, width: 10, height: 20 };
  const clip = { kind: "video" as const, uri: "file:///b.mov", mediaType: "video/quicktime", bytes: 300, width: 9, height: 16, durationMs: 3000, posterUri: "file:///b.jpg" };

  it("图片：路径按 <我>/<对方>/<uuid>，写进去的 media 与路径一致", async () => {
    const { d, log } = deps();
    const r = await sendMediaMessage(d, A, B, [photo]);
    expect(log).toEqual([`up ${A}/${B}/${U}.jpg file:///a.jpg image/jpeg`, "insert [图片] 1"]);
    expect(r.media).toEqual([{ kind: "image", path: `${A}/${B}/${U}.jpg`, mediaType: "image/jpeg", bytes: 100, width: 10, height: 20 }]);
  });
  it("视频：先传视频再传封面，封面与视频同 id", async () => {
    const { d, log } = deps();
    const r = await sendMediaMessage(d, A, B, [clip]);
    expect(log.slice(0, 2)).toEqual([`up ${A}/${B}/${U}.mov file:///b.mov video/quicktime`, `up ${A}/${B}/${U}.poster.jpg file:///b.jpg image/jpeg`]);
    expect(r.media[0]).toMatchObject({ kind: "video", durationMs: 3000, poster: `${A}/${B}/${U}.poster.jpg` });
    expect(r.body).toBe("[视频]");
  });
  it("封面传不上去：不带封面照发（封面是锦上添花）", async () => {
    const { d } = deps({ failUpload: ".poster.jpg" });
    const r = await sendMediaMessage(d, A, B, [clip]);
    expect(r.media[0]?.poster).toBeUndefined();
  });
  it("第二张传失败：已传的那张收掉、不写消息、错误抛给调用方", async () => {
    const { d, log } = deps({ failUpload: `${ids[1]}.jpg` });
    await expect(sendMediaMessage(d, A, B, [photo, photo])).rejects.toThrow("网断了");
    expect(log).toEqual([`up ${A}/${B}/${U}.jpg file:///a.jpg image/jpeg`, `rm ${A}/${B}/${U}.jpg`]);
  });
  it("写消息失败：文件全收掉", async () => {
    const { d, log } = deps({ failInsert: true });
    await expect(sendMediaMessage(d, A, B, [clip])).rejects.toThrow("不是好友了");
    expect(log.at(-1)).toBe(`rm ${A}/${B}/${U}.mov,${A}/${B}/${U}.poster.jpg`);
  });
  it("进度按字节算、只增不减、最后是 1；超过 9 样当场拒", async () => {
    const seen: number[] = [];
    const { d } = deps();
    await sendMediaMessage(d, A, B, [photo, photo], (f) => seen.push(f));
    expect(seen.at(-1)).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    await expect(sendMediaMessage(d, A, B, Array.from({ length: 10 }, () => photo))).rejects.toThrow();
  });
});

describe("missingMediaColumn：0052 还没跑时退回不带 media 的查询", () => {
  it("认 42703 / PGRST204 且话里提到 media", () => {
    expect(missingMediaColumn({ code: "42703", message: "column messages.media does not exist" })).toBe(true);
    expect(missingMediaColumn({ code: "PGRST204", message: "Could not find the 'media' column of 'messages' in the schema cache" })).toBe(true);
  });
  it("别的错不认（不把真故障吞成「没这一列」）", () => {
    expect(missingMediaColumn({ code: "42501", message: "permission denied" })).toBe(false);
    expect(missingMediaColumn({ code: "42703", message: "column messages.foo does not exist" })).toBe(false);
    expect(missingMediaColumn(new Error("boom"))).toBe(false);
  });
});
