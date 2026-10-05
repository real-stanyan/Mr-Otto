// 聊天里的文件卡（#1683，照微信）：左边文件名（两行，超了尾部省略——扩展名角标上写着，省掉的不是格式）+ 底下大小，
// 右边一枚按格式上色的角标（PDF 红、Word 蓝、Excel 绿、PPT 橙、文本灰）。人发的、智能体做出来交给人的，都画这一张。
//
// 点一下打开：**点的那一刻才签名**（签十分钟，一个对象一趟），不走 mediaUrls 那份渲染时就签的缓存——
// 图片要马上画所以先签，文件卡只画名字，一页历史里十几份文件不该每次进页面都签十几趟。签好交给 App 内浏览器
// （expo-web-browser 的 openBrowserAsync：iOS 是 SFSafariViewController，PDF / Office / 文本都能直接预览，右上角能分享、存到「文件」）。
// 签的时候角标那里转圈；签不出来 / 打不开说一句人话（toast，同语音条放不了那条）。
//
// 角标的四种颜色是各家格式自己的颜色（人认文件靠它），不是界面的颜色，所以不进 palette；字一律白。
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { fileSizeLabel, type ChatMediaItem, type PreparedMedia } from "../../../src/shared/chatMedia.js";
import { fileBadgeOf, type FileFamily } from "../../../src/shared/chatFilePick.js";
import { signMedia } from "../friends/friendsApi.js";
import { usePalette } from "../theme.js";
import { toast } from "../wx/toast.js";

const CARD_W = 232;
const RADIUS = 10;
const BADGE_W = 40;
const BADGE_H = 48;
/** 点开用的签名地址活多久：只够这一次打开（浏览器拿到就开始下），不攒 */
const OPEN_TTL_SEC = 600;

const FAMILY_COLOR: Record<Exclude<FileFamily, "text">, string> = {
  pdf: "#d93025",
  word: "#2b579a",
  excel: "#217346",
  ppt: "#d24726",
};

function Badge({ mediaType, busy }: { mediaType: string; busy: boolean }) {
  const { c } = usePalette();
  const b = fileBadgeOf(mediaType);
  const bg = b.family === "text" ? c.mutedForeground : FAMILY_COLOR[b.family];
  return (
    <View style={{ width: BADGE_W, height: BADGE_H, borderRadius: 6, borderTopRightRadius: 14, backgroundColor: bg, alignItems: "center", justifyContent: "flex-end", paddingBottom: 7 }}>
      {busy ? (
        <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="small" color="#ffffff" />
        </View>
      ) : (
        <Text numberOfLines={1} style={{ fontSize: b.label.length > 3 ? 10 : 11, fontWeight: "700", color: "#ffffff", letterSpacing: 0.3 }}>{b.label}</Text>
      )}
    </View>
  );
}

/** 卡的样子（发出去的、还在传的共用）。onPress 缺席 = 不能点（还在传） */
function FileCard({ name, mediaType, bytes, busy, dim, onPress }: {
  name: string;
  mediaType: string;
  bytes: number;
  busy: boolean;
  dim: boolean;
  onPress?: () => void;
}) {
  const { c } = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`文件 ${name}，${fileSizeLabel(bytes)}${onPress !== undefined ? "，点一下打开" : ""}`}
      disabled={onPress === undefined || busy}
      onPress={onPress}
      style={({ pressed }) => [
        { width: CARD_W, flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: RADIUS, backgroundColor: c.card, borderWidth: 0.5, borderColor: c.border, opacity: dim ? 0.6 : 1 },
        pressed && { opacity: 0.8 },
      ]}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <Text numberOfLines={2} ellipsizeMode="tail" style={{ fontSize: 15, lineHeight: 20, color: c.foreground }}>{name}</Text>
        <Text style={{ fontSize: 12, color: c.mutedForeground, fontVariant: ["tabular-nums"] }}>{fileSizeLabel(bytes)}</Text>
      </View>
      <Badge mediaType={mediaType} busy={busy} />
    </Pressable>
  );
}

/** 已经发出去的一份（真消息里的 media，kind = file）。`bucket` 同 MediaBubble：私聊 dm-media、云会话 chat-media */
export function FileBubble({ item, bucket }: { item: ChatMediaItem; bucket: string }) {
  const [busy, setBusy] = useState(false);
  const name = item.name ?? "文件";
  const open = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const url = (await signMedia(bucket, [item.path], OPEN_TTL_SEC)).get(item.path);
      // 签不出来多半是对象不在了（发送方传了一半、或者被收掉了）；同一句话给人，原因细节不重要
      if (url === undefined) throw new Error("文件不在了");
      await WebBrowser.openBrowserAsync(url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
        dismissButtonStyle: "done",
        readerMode: false,
      });
    } catch (e) {
      toast(`打不开这个文件：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return <FileCard name={name} mediaType={item.mediaType} bytes={item.bytes} busy={busy} dim={false} onPress={() => void open()} />;
}

/** 还没发出去的那一份：本机文件，不能点；发送中压淡（进度那一行由 PendingMediaBubble 画在底下） */
export function PendingFileCard({ item, sending }: { item: PreparedMedia; sending: boolean }) {
  return <FileCard name={item.name ?? "文件"} mediaType={item.mediaType} bytes={item.bytes} busy={false} dim={sending} />;
}
