// 全屏看图 / 播视频（#1443 P1）。整屏黑底（看图与播片的通行做法，同系统相册；CallOverlay 那一屏也是自己的定色），
// 一条消息里的几样左右翻。视频只在翻到它那一页时才建播放器、自动开播——
// 九宫格里混着两段视频时，翻过去的那段不该在背后接着响。
//
// 怎么关（#1518，维护者：「和微信交互逻辑一样」）：
// · 图片页点一下就关——看大图是个「瞥一眼」的动作，退出不该去找角上那颗 X；
// · 整屏往下拽：图跟手下移、略缩，黑底随之变淡露出底下的聊天；松手看落点（位置 + 动量投影，
//   同 BottomSheet 那一套 gestureMath）过屏高五分之一，或往下甩过 900pt/s 就关，不过弹回；
// · 左右翻页不受影响：Pan 只在竖向先动 12pt 时激活、横向先动就让位（failOffsetX），横向归 FlatList；
// · 右上角的 X 留着——视频页的原生控件要吃点击，没法「点一下就关」，下拽对它一样管用。
// Modal 透明、黑底自己画：拖到一半黑底要能变淡，不透明的 fullScreen 那种做不到。
import { VideoView, useVideoPlayer } from "expo-video";
import { useState } from "react";
import { FlatList, Image, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DM_MEDIA_BUCKET, type ChatMediaItem } from "../../../src/shared/chatMedia.js";
import { projectMomentum, rubberband } from "../../../src/shared/gestureMath.js";
import { spring } from "../theme.js";
import { Spinner, useReduceMotion } from "../ui.js";
import { Icon } from "../wx/Icon.js";
import { retryMediaUrl, useMediaUrl } from "./mediaUrls.js";

const FG = "#ffffff";
const FG2 = "rgba(255,255,255,0.6)";

/** 竖向先走这么多才算「在下拽」；横向先走这么多就是在翻页，Pan 让位 */
const DRAG_START = 12;
/** 落点超过屏高的这一比例就关 */
const DISMISS_DISTANCE = 0.2;
/** 或者松手时往下的速度（pt/s）超过这个——一甩就该关 */
const DISMISS_VELOCITY = 900;
/** 往上拽的阻尼：越拉越跟不动，永远到不了 24pt */
const RUBBER_MAX = 24;
const RUBBER_SLOPE = 0.2;
/** 没过阈值弹回原位 */
const SNAP_SPRING = spring(0.35);
/** 拽到底时缩到多小（微信手感：跟手缩一点，不是整张飞走） */
const MIN_SCALE = 0.6;

function Unavailable({ path, bucket }: { path: string; bucket: string }) {
  return (
    <Pressable accessibilityRole="button" onPress={() => retryMediaUrl(path, bucket)} style={{ alignItems: "center", gap: 8 }}>
      <Icon name="rotate-ccw" size={22} stroke={1.8} color={FG2} />
      <Text style={{ fontSize: 14, color: FG2 }}>加载不出来 · 点一下重试</Text>
    </Pressable>
  );
}

function ImagePage({ path, bucket, width, height, onTap }: { path: string; bucket: string; width: number; height: number; onTap: () => void }) {
  const url = useMediaUrl(path, bucket);
  const [broken, setBroken] = useState(false);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="点一下关闭" onPress={onTap} style={{ width, height, alignItems: "center", justifyContent: "center" }}>
      {url === null ? <Spinner /> : url === "failed" || broken ? <Unavailable path={path} bucket={bucket} /> : (
        <Image source={{ uri: url }} resizeMode="contain" onError={() => setBroken(true)} style={{ width, height }} />
      )}
    </Pressable>
  );
}

function VideoPlayerPage({ url, width, height }: { url: string; width: number; height: number }) {
  const player = useVideoPlayer(url, (p) => {
    p.play();
  });
  return <VideoView player={player} nativeControls contentFit="contain" style={{ width, height }} />;
}

function VideoPage({ item, bucket, active, width, height }: { item: ChatMediaItem; bucket: string; active: boolean; width: number; height: number }) {
  const url = useMediaUrl(item.path, bucket);
  const poster = useMediaUrl(item.poster, bucket);
  if (url === "failed") return <View style={{ width, height, alignItems: "center", justifyContent: "center" }}><Unavailable path={item.path} bucket={bucket} /></View>;
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

export function MediaViewer({ media, bucket = DM_MEDIA_BUCKET, index, onClose }: { media: ChatMediaItem[]; bucket?: string; index: number; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const [current, setCurrent] = useState(index);
  /** 下拽的位移；0 = 原位 */
  const y = useSharedValue(0);

  const pan = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetY([-DRAG_START, DRAG_START])
    .failOffsetX([-DRAG_START, DRAG_START])
    .onUpdate((e) => {
      y.value = e.translationY >= 0 ? e.translationY : rubberband(e.translationY, RUBBER_MAX, RUBBER_SLOPE);
    })
    .onEnd((e) => {
      // 关不关看落点不看松手那一刻：位置 + 速度衰减完还会走的那段
      const landing = e.translationY + projectMomentum(e.velocityY);
      if (e.velocityY > DISMISS_VELOCITY || landing > height * DISMISS_DISTANCE) {
        onClose();
        return;
      }
      y.value = reduce ? 0 : withSpring(0, { ...SNAP_SPRING, velocity: e.velocityY });
    });

  const pagesStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: y.value },
      { scale: interpolate(y.value, [0, height], [1, MIN_SCALE], Extrapolation.CLAMP) },
    ],
  }));
  const fadeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(y.value, [0, height * 0.5], [1, 0], Extrapolation.CLAMP),
  }));

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: "#000000" }, fadeStyle]} />
        <GestureDetector gesture={pan}>
          <Animated.View style={[{ flex: 1 }, pagesStyle]}>
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
                  ? <VideoPage item={item} bucket={bucket} active={i === current} width={width} height={height} />
                  : <ImagePage path={item.path} bucket={bucket} width={width} height={height} onTap={onClose} />
              }
            />
          </Animated.View>
        </GestureDetector>
        <Animated.View pointerEvents="box-none" style={[{ position: "absolute", top: insets.top + 8, left: 16, right: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, fadeStyle]}>
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
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}
