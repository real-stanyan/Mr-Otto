// 云会话发图的手机接线（#1491 P3）。手机代码依赖 react-native 进不了 vitest，这里读源码钉住：
// ① 群聊页 ＋ 里有「相册」「拍摄」，发送走 sendCloudMedia（哈希 / 上传 / 发送都注入）、say 带 media；
// ② 气泡那一行把 media 画成 MediaBubble，bucket 是 chat-media（默认的 dm-media 会签不出来）；
// ③ 签名地址缓存按 bucket 分键（两个 bucket 的路径段数一样，光看路径分不出来）；上传 / 签名把 bucket 当参数；
// ④ 这一期仍只走热更新：没有新的原生模块。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("ChatScreen", () => {
  const src = read("mobile/src/chat/ChatScreen.tsx");
  it("＋ 里有「相册」「拍摄」，只在会话建好、不是外联时", () => {
    expect(src).toMatch(/label: "相册", onPress: \(\) => void sendPicked\(pickFromLibrary\)/);
    expect(src).toMatch(/label: "拍摄", onPress: \(\) => void sendPicked\(pickFromCamera\)/);
    expect(src).toMatch(/if \(ready && session !== null && !isOutreach && ws !== null\)/);
  });
  it("发送走 sendCloudMedia，哈希 / 大小 / 上传 / 发送都注入，say 带 media", () => {
    expect(src).toMatch(/sendCloudMedia\(wsId, sid, p\.items, \{/);
    expect(src).toMatch(/hash: sha256OfFile/);
    expect(src).toMatch(/fileSize: fileSizeOf/);
    expect(src).toMatch(/uploadMediaFile\(bucket, path, uri, mime/);
    expect(src).toMatch(/send: \(refs\) => sendText\("", mentions, \[\], refs\)/);
  });
  it("正在传的那几样画 PendingMediaBubble，失败能重试能删", () => {
    expect(src).toMatch(/onRetry=\{\(\) => runMediaSend\(item\.p\)\}/);
    expect(src).toMatch(/planMediaMessages\(ready\)/);
  });
});

describe("Bubbles", () => {
  const src = read("mobile/src/chat/Bubbles.tsx");
  it("mine / human 行的 media 画成 MediaBubble，bucket 是 chat-media，正文是占位时不画字", () => {
    expect(src).toMatch(/<MediaBubble media=\{media\} bucket=\{CHAT_MEDIA_BUCKET\} \/>/);
    expect(src).toMatch(/mediaBodyHidden\(paragraphs\[0\] \?\? "", media\)/);
    expect(src.match(/\{\.\.\.\(row\.media !== undefined \? \{ media: row\.media \} : \{\}\)\}/g)?.length).toBe(2);
  });
});

describe("chatStore", () => {
  const src = read("mobile/src/cloud/chatStore.ts");
  it("sendText / say 多一格 media，递到 cloudClient.say 的第六个参数", () => {
    expect(src).toMatch(/export async function sendText\(text: string, mentions: string\[\] \| undefined, memberMentions: string\[\] = \[\], media\?: ChatMediaRef\[\]\)/);
    expect(src).toMatch(/cloudClient\.say\(text, mention, mentions, memberMentions, undefined, media\)/);
  });
});

describe("mediaUrls / friendsApi / MediaBubble", () => {
  it("签名缓存按 bucket 分键，按 bucket 各签一趟", () => {
    const src = read("mobile/src/media/mediaUrls.ts");
    expect(src).toMatch(/const keyOf = \(bucket: string, path: string\): string => bucket \+ SEP \+ path/);
    expect(src).toMatch(/signMedia\(bucket, paths, TTL_SEC\)/);
    expect(src).toMatch(/export function useMediaUrl\(path: string \| undefined, bucket: string = DM_MEDIA_BUCKET\)/);
  });
  it("上传与签名把 bucket 当参数；私聊那两个老名字还在（包一层）", () => {
    const src = read("mobile/src/friends/friendsApi.ts");
    expect(src).toMatch(/export async function uploadMediaFile\(bucket: string, path: string, uri: string, mime: string/);
    expect(src).toMatch(/metadata: \{ bucketName: bucket, objectName: path/);
    expect(src).toMatch(/export async function signMedia\(bucket: string, paths: string\[\], ttlSec: number\)/);
    expect(src).toMatch(/return uploadMediaFile\(DM_MEDIA_BUCKET, path, uri, mime, onProgress\)/);
    expect(src).toMatch(/return signMedia\(DM_MEDIA_BUCKET, paths, ttlSec\)/);
  });
  it("MediaBubble / MediaViewer 的 bucket 一路传到 useMediaUrl 与重试", () => {
    const bubble = read("mobile/src/media/MediaBubble.tsx");
    expect(bubble).toMatch(/export function MediaBubble\(\{ media, bucket = DM_MEDIA_BUCKET, mine = false \}/);
    expect(bubble).toMatch(/useMediaUrl\(path, bucket\)/);
    expect(bubble).toMatch(/retryMediaUrl\(path, bucket\)/);
    const viewer = read("mobile/src/media/MediaViewer.tsx");
    expect(viewer).toMatch(/useMediaUrl\(item\.path, bucket\)/);
    expect(viewer).toMatch(/useMediaUrl\(item\.poster, bucket\)/);
    expect(viewer).not.toMatch(/useMediaUrl\([a-z.]+\)/);
  });
});

describe("只走热更新：没有新的原生模块", () => {
  it("hash.ts 只用已有的 @noble/hashes 与 expo-file-system", () => {
    const src = read("mobile/src/media/hash.ts");
    expect(src).toMatch(/from "@noble\/hashes\/sha2\.js"/);
    expect(src).toMatch(/from "expo-file-system"/);
    const pkg = JSON.parse(read("mobile/package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@noble/hashes"]).toBeDefined();
    expect(pkg.dependencies["expo-file-system"]).toBeDefined();
  });
});
