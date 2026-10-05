// 聊天里发文件（#1683）的纯判据：白名单格式、20MB、名字清洗、占位正文「[文件] 名字」、一份一条（和别的混不进一条）、
// 两条发送路径（朋友私聊 sendMediaMessage / 云会话 sendCloudMedia）、事件 → 气泡（chatMediaItemsOf / chatRows）、
// 手机上挑出来的那一份收不收（chatFilePick），以及名册第二行（sessionLast）。
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import {
  CHAT_MEDIA_BUCKET, DOCX_MIME, FILE_MAX_BYTES, FILE_NAME_MAX, PPTX_MIME, XLSX_MIME, chatMediaItemsOf, cleanFileName, docMimeForName,
  fileSizeLabel, mediaBodyHidden, mediaPlaceholder, parseChatMedia, parseChatMediaRefs, parseDmMedia, planMediaMessages,
  sendMediaMessage, type ChatMediaItem, type ChatMediaRef, type PreparedMedia,
} from "../../src/shared/chatMedia.js";
import { sendCloudMedia } from "../../src/shared/chatMediaCloud.js";
import { FILE_PROBLEM, fileBadgeOf, preparePickedDoc } from "../../src/shared/chatFilePick.js";
import { chatRows } from "../../src/shared/mobileChat.js";
import { lastOf } from "../../src/shared/sessionLast.js";
import { dmPreview } from "../../src/shared/wechatInbox.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";
const HEX = "f".repeat(64);

const doc = (over: Partial<ChatMediaItem> = {}): ChatMediaItem => ({
  kind: "file", path: `${A}/${B}/${U}.pdf`, mediaType: "application/pdf", bytes: 120_000, width: 0, height: 0, name: "季度报告.pdf", ...over,
});
const img = (over: Partial<ChatMediaItem> = {}): ChatMediaItem => ({
  kind: "image", path: `${A}/${B}/44444444-4444-4444-8444-444444444444.jpg`, mediaType: "image/jpeg", bytes: 1000, width: 800, height: 600, ...over,
});

describe("docMimeForName：按扩展名认格式", () => {
  it("七种都认，大小写不论；.markdown 也是 Markdown", () => {
    expect(docMimeForName("a.pdf")).toBe("application/pdf");
    expect(docMimeForName("报告.DOCX")).toBe(DOCX_MIME);
    expect(docMimeForName("表.xlsx")).toBe(XLSX_MIME);
    expect(docMimeForName("deck.Pptx")).toBe(PPTX_MIME);
    expect(docMimeForName("notes.txt")).toBe("text/plain");
    expect(docMimeForName("data.csv")).toBe("text/csv");
    expect(docMimeForName("README.md")).toBe("text/markdown");
    expect(docMimeForName("README.markdown")).toBe("text/markdown");
  });
  it("老格式（.doc / .xls）、压缩包、图片、没有扩展名：null", () => {
    for (const n of ["a.doc", "a.xls", "a.zip", "a.jpg", "README", "a.pdf.exe"]) expect(docMimeForName(n)).toBeNull();
  });
});

describe("cleanFileName", () => {
  it("剥路径（/ 与 \\ 都算）、去控制字符、收空白", () => {
    expect(cleanFileName("/var/mobile/tmp/季度 报告.pdf")).toBe("季度 报告.pdf");
    expect(cleanFileName("C:\\Users\\x\\a.docx")).toBe("a.docx");
    expect(cleanFileName("a\u0000b\u001f.txt")).toBe("ab.txt");
    expect(cleanFileName("  a    b.txt ")).toBe("a b.txt");
  });
  it("剥完是空的、只剩 . / ..：null", () => {
    for (const n of ["", "   ", "dir/", ".", "..", "x/.."]) expect(cleanFileName(n)).toBeNull();
  });
  it(`超过 ${FILE_NAME_MAX} 字截断，扩展名保住，中间一个省略号`, () => {
    const out = cleanFileName(`${"很".repeat(300)}.pptx`) ?? "";
    expect(out).toHaveLength(FILE_NAME_MAX);
    expect(out.endsWith("….pptx")).toBe(true);
  });
  it("清过的名字再清一遍不变（解析那头拿它判「名字是不是清过的」）", () => {
    for (const n of ["季度 报告.pdf", cleanFileName(`${"x".repeat(500)}.md`) ?? ""]) expect(cleanFileName(n)).toBe(n);
  });
});

describe("fileSizeLabel", () => {
  it("KB 起步、不足 1KB 算 1KB；MB 留一位小数", () => {
    expect(fileSizeLabel(0)).toBe("1 KB");
    expect(fileSizeLabel(300)).toBe("1 KB");
    expect(fileSizeLabel(120_000)).toBe("117 KB");
    expect(fileSizeLabel(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(fileSizeLabel(FILE_MAX_BYTES)).toBe("20.0 MB");
  });
});

describe("parseChatMedia / parseDmMedia：文件那一格", () => {
  it("一份文件照收（名字跟着走）", () => {
    expect(parseChatMedia([doc()])).toEqual([doc()]);
    expect(parseDmMedia([doc()], A, B)).toEqual([doc()]);
  });
  it("格式不在白名单、超过 20MB、带尺寸 / 时长 / 封面：整份丢", () => {
    expect(parseChatMedia([doc({ mediaType: "application/zip" })])).toBeNull();
    expect(parseChatMedia([doc({ mediaType: "application/msword" })])).toBeNull();
    expect(parseChatMedia([doc({ bytes: FILE_MAX_BYTES + 1 })])).toBeNull();
    expect(parseChatMedia([doc({ width: 10 })])).toBeNull();
    expect(parseChatMedia([doc({ durationMs: 1000 })])).toBeNull();
    expect(parseChatMedia([doc({ poster: `${A}/${B}/${U}.poster.jpg` })])).toBeNull();
  });
  it("名字缺席、不是清过的（带路径 / 控制字符 / 空）：整份丢", () => {
    const { name: _drop, ...noName } = doc();
    expect(parseChatMedia([noName])).toBeNull();
    expect(parseChatMedia([doc({ name: "../../etc/passwd.txt" })])).toBeNull();
    expect(parseChatMedia([doc({ name: "a\u0000.pdf" })])).toBeNull();
    expect(parseChatMedia([doc({ name: "" })])).toBeNull();
  });
  it("文件一条一个：和图片混、两份文件放一条都整份拒", () => {
    expect(parseChatMedia([doc(), img()])).toBeNull();
    expect(parseChatMedia([img(), doc()])).toBeNull();
    expect(parseChatMedia([doc(), doc({ path: `${A}/${B}/55555555-5555-4555-8555-555555555555.pdf` })])).toBeNull();
  });
  it("私聊：路径不在这一对人的目录下就丢", () => {
    expect(parseDmMedia([doc()], B, A)).toBeNull();
  });
});

describe("占位正文「[文件] 名字」", () => {
  it("mediaPlaceholder 带名字；没名字只写「[文件]」", () => {
    expect(mediaPlaceholder([doc()])).toBe("[文件] 季度报告.pdf");
    expect(mediaPlaceholder([{ kind: "file" }])).toBe("[文件]");
  });
  it("正文恰好是占位才藏字；人配了别的字照画", () => {
    expect(mediaBodyHidden("[文件] 季度报告.pdf", [doc()])).toBe(true);
    expect(mediaBodyHidden("  [文件] 季度报告.pdf\n", [doc()])).toBe(true);
    expect(mediaBodyHidden("[文件]", [doc()])).toBe(false);
    expect(mediaBodyHidden("看看这份", [doc()])).toBe(false);
    expect(mediaBodyHidden("[文件] 季度报告.pdf", null)).toBe(false);
  });
  it("会话列表第二行（dmPreview 读 body）就是「[文件] 名字」", () => {
    expect(dmPreview("[文件] 季度报告.pdf")).toBe("[文件] 季度报告.pdf");
  });
  it("planMediaMessages：文件一份一条，夹在图片中间也不并", () => {
    const f = { kind: "file" as const };
    const i = { kind: "image" as const };
    expect(planMediaMessages([i, f, i, f]).map((g) => g.map((x) => x.kind))).toEqual([["image", "image"], ["file"], ["file"]]);
  });
});

describe("sendMediaMessage（朋友私聊）发一份文件", () => {
  const file: PreparedMedia = { kind: "file", uri: "file:///cache/q.pdf", mediaType: "application/pdf", bytes: 2048, width: 0, height: 0, name: "季度报告.pdf" };
  const deps = () => {
    const log: string[] = [];
    return {
      log,
      d: {
        newId: () => U,
        upload: async (path: string, uri: string, mime: string) => {
          log.push(`up ${path} ${uri} ${mime}`);
        },
        remove: async () => undefined,
        insert: async (body: string, media: ChatMediaItem[]) => ({ body, media }),
      },
    };
  };
  it("路径扩展名跟格式走、Content-Type 是文档的格式；media 带名字没尺寸；正文是「[文件] 名字」", async () => {
    const { d, log } = deps();
    const r = await sendMediaMessage(d, A, B, [file]);
    expect(log).toEqual([`up ${A}/${B}/${U}.pdf file:///cache/q.pdf application/pdf`]);
    expect(r.body).toBe("[文件] 季度报告.pdf");
    expect(r.media).toEqual([{ kind: "file", path: `${A}/${B}/${U}.pdf`, mediaType: "application/pdf", bytes: 2048, width: 0, height: 0, name: "季度报告.pdf" }]);
    // 写进去的那一格，收的那头（parseDmMedia）认得
    expect(parseDmMedia(r.media, A, B)).toEqual(r.media);
  });
  it("名字清不出来：按格式起一个（file.docx），不发一份没名字的", async () => {
    const { d } = deps();
    const r = await sendMediaMessage(d, A, B, [{ ...file, mediaType: DOCX_MIME, name: "  " }]);
    expect(r.media[0]?.name).toBe("file.docx");
    expect(r.media[0]?.path).toBe(`${A}/${B}/${U}.docx`);
  });
});

describe("sendCloudMedia（云会话）发一份文件", () => {
  it("传进 chat-media 的 <团队>/<会话>/<sha>.xlsx，Content-Type 是 xlsx；引用带名字、宽高为 0、过得了 parseChatMediaRefs", async () => {
    const uploads: string[] = [];
    let sent: ChatMediaRef[] | null = null;
    await sendCloudMedia("ws1", "s1", [{ kind: "file", uri: "file:///b.xlsx", mediaType: XLSX_MIME, bytes: 0, width: 0, height: 0, name: "dir/预算.xlsx" }], {
      hash: () => HEX,
      fileSize: () => 4096,
      upload: async (bucket, path, _uri, mime) => {
        uploads.push(`${bucket}:${path}:${mime}`);
      },
      send: async (refs) => {
        sent = refs;
        return { ok: true };
      },
    });
    expect(uploads).toEqual([`${CHAT_MEDIA_BUCKET}:ws1/s1/${HEX}.xlsx:${XLSX_MIME}`]);
    expect(sent).toEqual([{ kind: "file", sha256: HEX, mediaType: XLSX_MIME, bytes: 4096, width: 0, height: 0, name: "预算.xlsx" }]);
  });
});

describe("parseChatMediaRefs：文件引用", () => {
  const ref = { kind: "file", sha256: HEX, mediaType: "application/pdf", bytes: 100, width: 0, height: 0, name: "a.pdf" };
  it("一份照收", () => {
    expect(parseChatMediaRefs([ref])).toEqual([ref]);
  });
  it("没名字 / 名字没清过 / 有尺寸 / 超 20MB / 格式不对 / 和图混：拒", () => {
    const { name: _n, ...noName } = ref;
    expect(parseChatMediaRefs([noName])).toBeNull();
    expect(parseChatMediaRefs([{ ...ref, name: "x/a.pdf" }])).toBeNull();
    expect(parseChatMediaRefs([{ ...ref, width: 1 }])).toBeNull();
    expect(parseChatMediaRefs([{ ...ref, bytes: FILE_MAX_BYTES + 1 }])).toBeNull();
    expect(parseChatMediaRefs([{ ...ref, mediaType: "application/zip" }])).toBeNull();
    const image = { kind: "image", sha256: "e".repeat(64), mediaType: "image/jpeg", bytes: 10, width: 1, height: 1 };
    expect(parseChatMediaRefs([image, ref])).toBeNull();
  });
});

describe("chatMediaItemsOf：事件里的 files → 文件卡", () => {
  it("按对象名拼回 chat-media 的路径，名字清一遍；格式不在白名单 / id 不是 sha256 的跳过", () => {
    const out = chatMediaItemsOf("ws1", "s1", undefined, undefined, [
      { id: `sha256:${HEX}`, name: "out/方案.pptx", mediaType: PPTX_MIME, bytes: 9000 },
      { id: `sha256:${"e".repeat(64)}`, name: "a.zip", mediaType: "application/zip", bytes: 1 },
      { id: "local-1", name: "a.pdf", mediaType: "application/pdf", bytes: 1 },
    ]);
    expect(out).toEqual([{ kind: "file", path: `ws1/s1/${HEX}.pptx`, mediaType: PPTX_MIME, bytes: 9000, width: 0, height: 0, name: "方案.pptx" }]);
  });
  it("图和文件一起（工具同时交了图和文件）：图在前、文件在后", () => {
    const out = chatMediaItemsOf("ws1", "s1", [{ id: `sha256:${"a".repeat(64)}`, mediaType: "image/png", bytes: 1, width: 1, height: 1 }], undefined, [
      { id: `sha256:${HEX}`, name: "a.md", mediaType: "text/markdown", bytes: 10 },
    ]);
    expect(out.map((m) => m.kind)).toEqual(["image", "file"]);
  });
});

describe("chatRows：文件画在哪一行", () => {
  const WS = {
    id: "home1", name: "我的智能体", ownerUid: "me", kind: "home", sandboxApproval: "ask",
    members: [{ uid: "me", role: "owner", label: "Stan", avatarUrl: "" }], connectors: [], sessions: [], agents: [],
  } as unknown as WorkspaceSnapshot;
  let seq = 0;
  const e = (o: Record<string, unknown>): SessionEvent => ({ seq: seq++, sessionId: "s1", ts: 1000, ...o }) as unknown as SessionEvent;
  const f = { id: `sha256:${HEX}`, name: "周报.docx", mediaType: DOCX_MIME, bytes: 3000 };

  it("我发的文件（user_message.files）→ mine 行带文件卡，正文是占位", () => {
    seq = 0;
    const rows = chatRows({ events: [e({ type: "user_message", content: "[Stan]: [文件] 周报.docx", fromUid: "me", mentions: ["admin"], files: [f] })], ws: WS, selfUid: "me", now: 1000 });
    const mine = rows.find((r) => r.kind === "mine") as { text: string; media: ChatMediaItem[] };
    expect(mine.media).toEqual([{ kind: "file", path: `home1/s1/${HEX}.docx`, mediaType: DOCX_MIME, bytes: 3000, width: 0, height: 0, name: "周报.docx" }]);
    expect(mediaBodyHidden(mine.text, mine.media)).toBe(true);
  });
  it("工具交出来的文件（tool_result.files）→ 它那一侧单独一行；失败的调用不画", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "tool_result", toolCallId: "t1", status: "ok", output: "已生成", agentId: "admin", files: [f] }),
        e({ type: "tool_result", toolCallId: "t2", status: "error", output: "失败", agentId: "admin", files: [f] }),
      ],
      ws: WS, selfUid: "me", now: 1000,
    });
    const items = rows.filter((r) => r.kind !== "time");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "agent", key: "img-0", paragraphs: [], media: [{ kind: "file", name: "周报.docx" }] });
  });
  it("回话带文件（assistant_message.files）：有字照画字 + 文件卡；一个字没说、只交文件的也画（不当中间步骤藏掉）", () => {
    seq = 0;
    const rows = chatRows({
      events: [
        e({ type: "assistant_message", content: "周报做好了", model: "m", agentId: "admin", files: [f] }),
        e({ type: "assistant_message", content: "", model: "m", agentId: "admin", files: [f] }),
        // 要了工具的那条照旧是步骤：不画
        e({ type: "assistant_message", content: "", model: "m", agentId: "admin", files: [f], toolCalls: [{ id: "t", name: "x", args: {} }] }),
      ],
      ws: WS, selfUid: "me", now: 1000,
    });
    const agents = rows.filter((r) => r.kind === "agent");
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({ paragraphs: ["周报做好了"], media: [{ kind: "file" }] });
    expect(agents[1]).toMatchObject({ paragraphs: [], media: [{ kind: "file" }] });
  });
});

describe("sessionLast：只交文件的那句回话，名册第二行写「[文件] 名字」", () => {
  const reply = (o: Record<string, unknown>): SessionEvent => ({ seq: 1, sessionId: "s1", ts: 5, type: "assistant_message", model: "m", ...o }) as unknown as SessionEvent;
  it("空正文 + 文件 → [文件] 名字；有字照旧写字；要了工具的照旧不算", () => {
    const f = { id: `sha256:${HEX}`, name: "周报.docx", mediaType: DOCX_MIME, bytes: 1 };
    expect(lastOf(reply({ content: "", agentId: "admin", files: [f] }))).toEqual({ ts: 5, excerpt: "[文件] 周报.docx", from: "agent:admin" });
    expect(lastOf(reply({ content: "做好了", agentId: "admin", files: [f] }))?.excerpt).toBe("做好了");
    expect(lastOf(reply({ content: "", agentId: "admin", files: [f], toolCalls: [{ id: "t", name: "x", args: {} }] }))).toBeNull();
    expect(lastOf(reply({ content: "", agentId: "admin" }))).toBeNull();
  });
});

describe("preparePickedDoc：文件选择器挑出来的一份收不收", () => {
  const pick = (o: Partial<{ name: string; bytes: number | undefined; mimeType: string }> = {}) =>
    preparePickedDoc({ name: "季度报告.pdf", uri: "file:///cache/x.pdf", bytes: 2048, mimeType: "application/pdf", ...o });

  it("收：kind file、格式、大小、清过的名字、宽高 0", () => {
    expect(pick()).toEqual({ ok: true, item: { kind: "file", uri: "file:///cache/x.pdf", mediaType: "application/pdf", bytes: 2048, width: 0, height: 0, name: "季度报告.pdf" } });
  });
  it("格式先按扩展名认：系统报 octet-stream 的 .md 照收成 Markdown", () => {
    expect(pick({ name: "notes.md", mimeType: "application/octet-stream" })).toMatchObject({ ok: true, item: { mediaType: "text/markdown" } });
  });
  it("扩展名认不出时看系统给的 mimeType（剥掉参数、不论大小写）", () => {
    expect(pick({ name: "server.log", mimeType: "Text/Plain; charset=utf-8" })).toMatchObject({ ok: true, item: { mediaType: "text/plain", name: "server.log" } });
  });
  it("格式发不了：一句「支持 PDF、Word、Excel、PPT、文本」", () => {
    expect(pick({ name: "a.zip", mimeType: "application/zip" })).toEqual({ ok: false, problem: FILE_PROBLEM.unsupported });
    expect(pick({ name: "老文档.doc", mimeType: "application/msword" })).toEqual({ ok: false, problem: FILE_PROBLEM.unsupported });
    expect(FILE_PROBLEM.unsupported).toBe("这种文件发不了（支持 PDF、Word、Excel、PPT、文本）");
  });
  it("超过 20MB：「文件超过 20MB，发不了」；正好 20MB 照收", () => {
    expect(pick({ bytes: FILE_MAX_BYTES + 1 })).toEqual({ ok: false, problem: "文件超过 20MB，发不了" });
    expect(pick({ bytes: FILE_MAX_BYTES })).toMatchObject({ ok: true });
  });
  it("格式先于大小判：30MB 的 zip 听到的是「发不了这种」", () => {
    expect(pick({ name: "a.zip", mimeType: "application/zip", bytes: 30 * 1024 * 1024 })).toEqual({ ok: false, problem: FILE_PROBLEM.unsupported });
  });
  it("大小读不出 / 空文件：读不出", () => {
    expect(pick({ bytes: undefined })).toEqual({ ok: false, problem: FILE_PROBLEM.unreadable });
    expect(pick({ bytes: 0 })).toEqual({ ok: false, problem: FILE_PROBLEM.unreadable });
  });
  it("名字清不出来但系统说是 PDF：按格式起名 file.pdf", () => {
    expect(pick({ name: "/" })).toMatchObject({ ok: true, item: { name: "file.pdf" } });
  });
  it("收下的那份交给 sendMediaMessage，写出来的 media 收的那头认得", async () => {
    const out = pick({ name: "/private/var/tmp/预算 2026.xlsx", mimeType: "" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = await sendMediaMessage({ newId: () => U, upload: async () => undefined, remove: async () => undefined, insert: async (body, media) => ({ body, media }) }, A, B, [out.item]);
    expect(r.body).toBe("[文件] 预算 2026.xlsx");
    expect(parseDmMedia(r.media, A, B)).not.toBeNull();
  });
});

describe("fileBadgeOf：文件卡角标", () => {
  it("四族各一种颜色，字是扩展名大写；文本一族（txt / csv / md）与认不出的都算 text", () => {
    expect(fileBadgeOf("application/pdf")).toEqual({ family: "pdf", label: "PDF" });
    expect(fileBadgeOf(DOCX_MIME)).toEqual({ family: "word", label: "DOCX" });
    expect(fileBadgeOf(XLSX_MIME)).toEqual({ family: "excel", label: "XLSX" });
    expect(fileBadgeOf(PPTX_MIME)).toEqual({ family: "ppt", label: "PPTX" });
    expect(fileBadgeOf("text/csv")).toEqual({ family: "text", label: "CSV" });
    expect(fileBadgeOf("text/markdown")).toEqual({ family: "text", label: "MD" });
    expect(fileBadgeOf("application/zip")).toEqual({ family: "text", label: "FILE" });
  });
});
