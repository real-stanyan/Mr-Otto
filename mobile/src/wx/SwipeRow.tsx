// 左滑露出「删除」的一行（#1566，照微信）：右边一块红底白字，划过一半松手停住、点一下才删；
// 划到头（overshoot）不自动删——删的是这台手机上列表里的一行，手一滑就没了太轻。
// 用 gesture-handler 的 ReanimatedSwipeable（reanimated 4 已在依赖里）；一次只开一行由调用方不管——
// 微信也允许两行同时露着钮。
import { useRef, type ReactNode } from "react";
import { Pressable, Text } from "react-native";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { usePalette } from "../theme.js";

export const SWIPE_ACTION_WIDTH = 76;

export function SwipeRow({ children, onDelete, label = "删除" }: { children: ReactNode; onDelete: () => void; label?: string }) {
  const { c } = usePalette();
  const ref = useRef<SwipeableMethods>(null);
  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={2}
      rightThreshold={SWIPE_ACTION_WIDTH / 2}
      overshootRight={false}
      renderRightActions={() => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={() => {
            ref.current?.close();
            onDelete();
          }}
          style={({ pressed }) => ({
            width: SWIPE_ACTION_WIDTH,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.destructive,
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <Text style={{ fontSize: 16, fontWeight: "500", color: "#ffffff" }}>{label}</Text>
        </Pressable>
      )}
    >
      {children}
    </ReanimatedSwipeable>
  );
}
