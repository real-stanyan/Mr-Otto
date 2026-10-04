// 全屏看图 / 播视频（#1443 P1）。整屏黑底（看图与播片的通行做法，同系统相册；CallOverlay 那一屏也是自己的定色），
// 一条消息里的几样左右翻，右上角一颗「关闭」。视频只在翻到它那一页时才建播放器、自动开播——
// 九宫格里混着两段视频时，翻过去的那段不该在背后接着响。
import { VideoView, useVideoPlayer } from "expo-video";
import { useState } from "react";
import { FlatList, Image, Modal, Pressable, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ChatMediaItem } from "../../../src/shared/chatMedia.js";
import { Spinner } from "../ui.js";
import { Icon } from "../wx/Icon.js";
import { retryMediaUrl, useMediaUrl } from "./mediaUrls.js";

const FG = "#ffffff";
const FG2 = "rgba(255,255,255,0.6)";

function Unavailable({ path }: { path: string }) {
  return (
    <Pressable accessibilityRole="button" onPress={() => retryMediaUrl(path)} style={{ alignItems: "center", gap: 8 }}>
      <Icon name="rotate-ccw" size={22} stroke={1.8} color={FG2} />
      <Text style={{ fontSize: 14, color: FG2 }}>加载不出来 · 点一下重试</Text>
    </Pressable>
  );
}

function ImagePage({ path, width, height }: { path: string; width: number; height: number }) {
  const url = useMediaUrl(path);
  const [broken, setBroken] = useState(false);
  return (
    <View style={{ width, height, alignItems: "center", justifyContent: "center" }}>
      {url === null ? <Spinner /> : url === "failed" || broken ? <Unavailable path={path} /> : (
        <Image source={{ uri: url }} resizeMode="contain" onError={() => setBroken(true)} style={{ width, height }} />
      )}
    </View>
  );
}

function VideoPlayerPage({ url, width, height }: { url: string; width: number; height: number }) {
  const player = useVideoPlayer(url, (p) => {
    p.play();
  });
  return <VideoView player={player} nativeControls contentFit="contain" style={{ width, height }} />;
}

function VideoPage({ item, active, width, height }: { item: ChatMediaItem; active: boolean; width: number; height: number }) {
  const url = useMediaUrl(item.path);
  const poster = useMediaUrl(item.poster);
  if (url === "failed") return <View style={{ width, height, alignItems: "center", justifyContent: "center" }}><Unavailable path={item.path} /></View>;
  if (active && url !== null) return <VideoPlayerPage url={url} width={width} height={height} />;
  return (
    <View style={{ width, height, alignItems: "center", justifyContent: "center" }}>
      {typeof poster === "string" && poster !== "failed"
        ? <Image source={{ uri: poster }} resizeMode="contain" style={{ width, height, position: "absolute" }} />
        : null}
      <Spinner />
    </View>
  );
}

export function MediaViewer({ media, index, onClose }: { media: ChatMediaItem[]; index: number; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState(index);
  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000000" }}>
        <FlatList
          horizontal
          pagingEnabled
          data={media}
          keyExtractor={(m) => m.path}
          initialScrollIndex={index}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(e) => setCurrent(Math.round(e.nativeEvent.contentOffset.x / width))}
          renderItem={({ item, index: i }) =>
            item.kind === "video"
              ? <VideoPage item={item} active={i === current} width={width} height={height} />
              : <ImagePage path={item.path} width={width} height={height} />
          }
        />
        <View pointerEvents="box-none" style={{ position: "absolute", top: insets.top + 8, left: 16, right: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 14, color: FG2, fontVariant: ["tabular-nums"] }}>{media.length > 1 ? `${current + 1} / ${media.length}` : ""}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
            hitSlop={10}
            onPress={onClose}
            style={({ pressed }) => [{ width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" }, pressed && { opacity: 0.5 }]}
          >
            <Icon name="x" size={22} stroke={2} color={FG} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
