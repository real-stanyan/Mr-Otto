// 挑一张脸（#1386，demo 的 .face-wall）：十张（pickableFaces，cap 没有自己的坑位），五列圆角方块。
// 选中 = 一圈点缀色的边 + 一块淡底，**只有它是活的**（一墙都在眨眼时，人分不出哪张是「我的」）；
// 按下那一下弹一次（1 → 1.12 → .98 → 1，那是对动作的回应，不常驻放大）。关了动效不弹。
// 新建智能体的弹窗与「换个形象」的抽屉共用这一份：抄两份的那天，两处会在「哪几张可选」上分家。
import { useMemo, useRef } from "react";
import { Animated, Easing, Pressable, View } from "react-native";
import { pickableFaces, type PickableFace } from "../../../src/shared/agentSettingsForm.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import { usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";
import { FaceTile } from "./Avatar.js";

export function FacePicker({ current, onPick, size = 46 }: { current: string; onPick: (face: PickableFace) => void; size?: number }) {
  const faces = useMemo(pickableFaces, []);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
      {faces.map((f) => (
        <Pick key={f.id} face={f} on={f.id === current} size={size} onPick={onPick} />
      ))}
    </View>
  );
}

function Pick({ face, on, size, onPick }: { face: PickableFace; on: boolean; size: number; onPick: (f: PickableFace) => void }) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const pop = (): void => {
    if (reduce) return;
    scale.setValue(1);
    Animated.sequence([
      Animated.timing(scale, { toValue: 1.12, duration: 130, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(scale, { toValue: 0.98, duration: 115, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 95, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={face.name}
      accessibilityState={{ selected: on }}
      onPress={() => {
        pop();
        onPick(face);
      }}
      style={({ pressed }) => [pressed && { opacity: 0.7 }]}
    >
      <Animated.View
        style={{
          padding: 3, borderRadius: 12, borderWidth: 2, borderColor: on ? c.brand : "transparent",
          backgroundColor: on ? withAlpha(c.brand, 0.1) : "transparent", transform: [{ scale }],
        }}
      >
        <FaceTile slot={face.slot} size={size} state={on ? "alive" : "plain"} phase={facePhase(face.id)} />
      </Animated.View>
    </Pressable>
  );
}
