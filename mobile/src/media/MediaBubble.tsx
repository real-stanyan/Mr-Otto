// 私聊气泡里的图片与视频（#1443 P1）。一张：按原图比例画（长边 200、短边至少 80，mediaBubbleBox）；
// 两张以上：九宫格（2、4 张排两列，其余三列），每格 80 的方块。视频：封面 + 正中一枚播放钮 + 右下角时长。
// 点一下打开全屏的 MediaViewer（图片可左右翻，视频在那里播）。
//
// 「发送中」的本地气泡（PendingMediaBubble）画本机文件，压一层半透明、底下一行进度；失败那条一行原因 +「重试」「删除」。
// 不画新的颜色：底色取 c.card / c.muted，字取 c.mutedForeground / c.destructive / c.brand（同私聊里「重试」那一行）。
import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { DM_MEDIA_BUCKET, mediaBubbleBox, videoDurationLabel, type ChatMediaItem, type PreparedMedia } from "../../../src/shared/chatMedia.js";
import { usePalette } from "../theme.js";
import { Spinner } from "../ui.js";
import { Icon } from "../wx/Icon.js";
import { retryMediaUrl, useMediaUrl } from "./mediaUrls.js";
import { MediaViewer } from "./MediaViewer.js";

const CELL = 80;
const GAP = 4;
const RADIUS = 8;

/** 九宫格几列：2、4 张两列（排成方的），其余三列 */
function columnsFor(n: number): number {
  return n === 2 || n === 4 ? 2 : 3;
}

function PlayBadge({ size = 40 }: { size?: number }) {
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" }}>
        <Icon name="play" size={size * 0.5} stroke={2} color="#ffffff" />
      </View>
    </View>
  );
}

function DurationTag({ ms }: { ms: number }) {
  return (
    <View pointerEvents="none" style={{ position: "absolute", right: 6, bottom: 5, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: "rgba(0,0,0,0.45)" }}>
      <Text style={{ fontSize: 11, color: "#ffffff", fontVariant: ["tabular-nums"] }}>{videoDurationLabel(ms)}</Text>
    </View>
  );
}

/** 一格：签名地址到手才画图；签不出来画一句话、点一下重签 */
function RemoteTile({ path, bucket, width, height }: { path: string | undefined; bucket: string; width: number; height: number }) {
  const { c } = usePalette();
  const url = useMediaUrl(path, bucket);
  const [broken, setBroken] = useState(false);
  if (path === undefined) return <View style={{ width, height, borderRadius: RADIUS, backgroundColor: c.muted }} />;
  if (url === "failed" || broken) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="加载不出来，点一下重试"
        onPress={() => {
          setBroken(false);
          retryMediaUrl(path, bucket);
        }}
        style={{ width, height, borderRadius: RADIUS, backgroundColor: c.muted, alignItems: "center", justifyContent: "center", padding: 6 }}
      >
        <Icon name="rotate-ccw" size={18} stroke={1.8} color={c.mutedForeground} />
        <Text style={{ fontSize: 11, color: c.mutedForeground, marginTop: 4, textAlign: "center" }}>加载不出来</Text>
      </Pressable>
    );
  }
  if (url === null) {
    return (
      <View style={{ width, height, borderRadius: RADIUS, backgroundColor: c.muted, alignItems: "center", justifyContent: "center" }}>
        <Spinner />
      </View>
    );
  }
  return <Image source={{ uri: url }} onError={() => setBroken(true)} resizeMode="cover" style={{ width, height, borderRadius: RADIUS, backgroundColor: c.muted }} />;
}

/** 已经发出去的那几样（真消息里的 media） */
/** `bucket`：私聊是 dm-media（默认），云会话是 chat-media（#1491） */
export function MediaBubble({ media, bucket = DM_MEDIA_BUCKET }: { media: ChatMediaItem[]; bucket?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const single = media.length === 1 ? media[0] : undefined;
  const body = single !== undefined ? (
    (() => {
      const box = mediaBubbleBox(single.width, single.height);
      return (
        <Pressable accessibilityRole="button" accessibilityLabel={single.kind === "video" ? "视频，点开播放" : "图片，点开看大图"} onPress={() => setOpen(0)} style={({ pressed }) => [pressed && { opacity: 0.85 }]}>
          <View>
            <RemoteTile bucket={bucket} path={single.kind === "video" ? single.poster : single.path} width={box.width} height={box.height} />
            {single.kind === "video" ? <><PlayBadge /><DurationTag ms={single.durationMs ?? 0} /></> : null}
          </View>
        </Pressable>
      );
    })()
  ) : (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GAP, width: columnsFor(media.length) * CELL + (columnsFor(media.length) - 1) * GAP }}>
      {media.map((m, i) => (
        <Pressable key={m.path} accessibilityRole="button" accessibilityLabel={`第 ${i + 1} 张，点开看大图`} onPress={() => setOpen(i)} style={({ pressed }) => [pressed && { opacity: 0.85 }]}>
          <View>
            <RemoteTile bucket={bucket} path={m.kind === "video" ? m.poster : m.path} width={CELL} height={CELL} />
            {m.kind === "video" ? <PlayBadge size={28} /> : null}
          </View>
        </Pressable>
      ))}
    </View>
  );
  return (
    <>
      {body}
      {open !== null ? <MediaViewer media={media} bucket={bucket} index={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** 还没发出去的那条：画本机文件 */
export function PendingMediaBubble({ items, state, progress, error, onRetry, onDrop }: {
  items: PreparedMedia[];
  state: "sending" | "failed";
  progress: number;
  error: string | null;
  onRetry: () => void;
  onDrop: () => void;
}) {
  const { c } = usePalette();
  const single = items.length === 1 ? items[0] : undefined;
  const tile = (p: PreparedMedia, w: number, h: number, key?: string) => {
    const uri = p.kind === "image" ? p.uri : p.posterUri;
    return (
      <View key={key} style={{ opacity: state === "sending" ? 0.6 : 1 }}>
        {uri !== undefined
          ? <Image source={{ uri }} resizeMode="cover" style={{ width: w, height: h, borderRadius: RADIUS, backgroundColor: c.muted }} />
          : <View style={{ width: w, height: h, borderRadius: RADIUS, backgroundColor: c.muted }} />}
        {p.kind === "video" ? <PlayBadge size={Math.min(40, w / 2)} /> : null}
      </View>
    );
  };
  const cols = columnsFor(items.length);
  return (
    <View style={{ alignItems: "flex-end", gap: 6 }}>
      {single !== undefined
        ? (() => {
          const box = mediaBubbleBox(single.width, single.height);
          return tile(single, box.width, box.height);
        })()
        : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GAP, width: cols * CELL + (cols - 1) * GAP }}>
            {items.map((p, i) => tile(p, CELL, CELL, `${i}`))}
          </View>
        )}
      {state === "sending" ? (
        <Text style={{ fontSize: 12, color: c.mutedForeground, fontVariant: ["tabular-nums"] }}>{`发送中 ${Math.floor(progress * 100)}%`}</Text>
      ) : (
        <Text style={{ fontSize: 12, color: c.destructive, textAlign: "right" }}>
          {`没发出去${error !== null ? `（${error}）` : ""} · `}
          <Text accessibilityRole="button" onPress={onRetry} style={{ color: c.brand }}>重试</Text>
          <Text style={{ color: c.mutedForeground }}> · </Text>
          <Text accessibilityRole="button" onPress={onDrop} style={{ color: c.mutedForeground }}>删除</Text>
        </Text>
      )}
    </View>
  );
}
