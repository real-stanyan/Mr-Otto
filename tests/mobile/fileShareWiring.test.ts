// 聊天里发文件 / 看文件的手机接线（#1683）。手机代码依赖 react-native 进不了 vitest，这里读源码钉住：
// ① 文件选择器是原生模块（expo-document-picker），老原生包热更新过来没有它：有没有先用 requireOptionalNativeModule 问，
//    模块本身动态 import——静态 import 在老包上一加载就抛，整个聊天页起不来；「文件」那一格按有没有它画；
// ② 群聊页 / 朋友私聊页 ＋ 里都有「文件」，挑好的走各自原来那条发送路径（sendCloudMedia / sendMediaToFriend），一份一条；
// ③ MediaBubble 把 kind file 画成 FileBubble，bucket 跟着走（私聊 dm-media、云会话 chat-media）；还在传的画 PendingFileCard；
// ④ 文件卡点开：点的那一刻签名、交给 App 内浏览器；打不开 toast 一句人话。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("pickDocuments：原生模块可缺席", () => {
  const src = read("mobile/src/media/pickDocuments.ts");
  it("有没有它用 requireOptionalNativeModule 问（不是 requireNativeModule）", () => {
    expect(src).toMatch(/export const documentPickerAvailable: boolean = requireOptionalNativeModule\("ExpoDocumentPicker"\) !== null;/);
    expect(src).not.toMatch(/requireNativeModule\(/);
  });
  it("expo-document-picker 只动态 import，没有静态 import", () => {
    expect(src).toMatch(/await import\("expo-document-picker"\)/);
    expect(src).not.toMatch(/from "expo-document-picker"/);
    for (const f of ["mobile/src/chat/ChatScreen.tsx", "mobile/src/friends/FriendChatScreen.tsx", "mobile/src/media/MediaBubble.tsx", "mobile/src/media/FileBubble.tsx"]) {
      expect(read(f), f).not.toMatch(/expo-document-picker/);
    }
  });
  it("原生模块名与装上的那一版一致；版本跟 Expo SDK 57", () => {
    const native = read("mobile/node_modules/expo-document-picker/build/ExpoDocumentPicker.js");
    expect(native).toMatch(/requireNativeModule\('ExpoDocumentPicker'\)/);
    const pkg = JSON.parse(read("mobile/package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["expo-document-picker"]).toMatch(/^~57\./);
  });
  it("多选、拷进缓存目录；每份过 preparePickedDoc（收不下的说「名字：原因」）", () => {
    expect(src).toMatch(/getDocumentAsync\(\{ type: PICK_TYPES, copyToCacheDirectory: true, multiple: true \}\)/);
    expect(src).toMatch(/preparePickedDoc\(\{ name: a\.name, uri: a\.uri, bytes: a\.size \?\? sizeOf\(a\.uri\), mimeType: a\.mimeType \}\)/);
  });
});

describe("两个聊天页的 ＋ 里有「文件」", () => {
  it("群聊页：按 documentPickerAvailable 画，挑好的一份一条走 runMediaSend（sendCloudMedia）", () => {
    const src = read("mobile/src/chat/ChatScreen.tsx");
    expect(src).toMatch(/if \(documentPickerAvailable\) plus\.push\(\{ key: "file", icon: "folder", label: "文件", onPress: \(\) => void sendFiles\(\) \}\);/);
    expect(src).toMatch(/picked = await pickDocuments\(\);/);
    expect(src).toMatch(/for \(const group of planMediaMessages\(picked\.ready\)\) \{/);
    expect(src).toMatch(/runMediaSend\(p\);/);
  });
  it("朋友私聊页：按 documentPickerAvailable 画，挑好的一份一条走 sendMediaToFriend", () => {
    const src = read("mobile/src/friends/FriendChatScreen.tsx");
    expect(src).toMatch(/\.\.\.\(documentPickerAvailable \? \[\{ key: "file", icon: "folder" as const, label: "文件", onPress: \(\) => void sendFiles\(\) \}\] : \[\]\)/);
    expect(src).toMatch(/for \(const group of planMediaMessages\(picked\.ready\)\) sendMediaToFriend\(uid, group\);/);
  });
});

describe("文件卡", () => {
  it("MediaBubble：kind file 画 FileBubble（bucket 跟着走），图片照旧；还在传的画 PendingFileCard", () => {
    const src = read("mobile/src/media/MediaBubble.tsx");
    expect(src).toMatch(/files\.map\(\(f\) => <FileBubble key=\{f\.path\} item=\{f\} bucket=\{bucket\} \/>\)/);
    expect(src).toMatch(/<MediaBubble media=\{visual\} bucket=\{bucket\} mine=\{mine\} \/>/);
    expect(src).toMatch(/if \(p\.kind === "file"\) return <PendingFileCard/);
  });
  it("FileBubble：点的那一刻签名（带 bucket），交给 openBrowserAsync；打不开 toast", () => {
    const src = read("mobile/src/media/FileBubble.tsx");
    expect(src).toMatch(/await signMedia\(bucket, \[item\.path\], OPEN_TTL_SEC\)/);
    expect(src).toMatch(/await WebBrowser\.openBrowserAsync\(url,/);
    expect(src).toMatch(/toast\(`打不开这个文件：/);
    expect(src).toMatch(/fileSizeLabel\(bytes\)/);
    expect(src).toMatch(/numberOfLines=\{2\}/);
  });
  it("两个聊天页都经 MediaBubble 画：云会话那边 bucket 是 chat-media，私聊默认 dm-media", () => {
    expect(read("mobile/src/chat/Bubbles.tsx")).toMatch(/<MediaBubble media=\{media\} bucket=\{CHAT_MEDIA_BUCKET\} \/>/);
    expect(read("mobile/src/friends/FriendChatScreen.tsx")).toMatch(/<MediaBubble media=\{m\.media\} mine=\{mine\} \/>/);
  });
});
