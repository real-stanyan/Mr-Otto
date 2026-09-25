// 挑形象的两样：上面那张大脸（走一遍它干活的样子）+ 下面那面墙（#1356 A1 写在「换个形象」里，
// A2 抽出来）。「换个形象」与「新建智能体」两张抽屉共用这一份——抄第二份的那天，两处会在「哪几个
// 角色可选」「选中长什么样」上分家（demo 的 faceWall / facePreview 是同一副骨架，同一条注释）。
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Pressable, View } from "react-native";
import { FACE_TOUR, pickableFaces, type PickableFace } from "../../../src/shared/agentSettingsForm.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import { Face } from "../face/Face.js";
import { usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";

/** 大脸那一遍：排队 → 思考 → 检索 → 执行 → 作答 → 完成 → 活着，循环；**不写状态词**（spec §5.5）。
    关了动效就停在「活着」那一格（它自己也是静止一帧） */
function Tour({ slot, ring }: { slot: number; ring: string }) {
  const reduce = useReduceMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const step = FACE_TOUR[i % FACE_TOUR.length]!;
    const timer = setTimeout(() => setI((n) => n + 1), step.ms);
    return () => clearTimeout(timer);
  }, [i, reduce]);
  const state = reduce ? "alive" : FACE_TOUR[i % FACE_TOUR.length]!.state;
  return <Face slot={slot} state={state} tier="l" ringColor={ring} />;
}

/**
 * 上面那张大脸。换了一张就从头走一遍（`Tour` 按 key 重挂，i 的初值天然回到 0），并且**缩一下再
 * 回来**——同一个位置上同一张脸换了个人（demo 的 prevSwap：.88 / .35 → 1.04 / 1 → 1，300ms）；
 * 不是淡入淡出，两张脸在中间那几帧会同时出现。第一次挂载不放（那不是「换」）。关了动效只留一段
 * 从 .4 到 1 的透明度（demo 的 prevSwapReduced，200ms 线性）。
 */
export function FacePreview({ slot, ring }: { slot: number; ring: string }) {
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  /** 上一次画的是哪一格：在 effect 里推进（不在渲染里改 ref），第一次挂载时它等于 slot，不放 */
  const shown = useRef(slot);
  useEffect(() => {
    if (shown.current === slot) return;
    shown.current = slot;
    if (reduce) {
      opacity.setValue(0.4);
      Animated.timing(opacity, { toValue: 1, duration: 200, easing: Easing.linear, useNativeDriver: true }).start();
      return;
    }
    scale.setValue(0.88);
    opacity.setValue(0.35);
    Animated.parallel([
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.04, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]),
      Animated.timing(opacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
  }, [slot, reduce, scale, opacity]);
  return (
    <Animated.View style={{ opacity, transform: [{ scale }] }}>
      <Tour key={slot} slot={slot} ring={ring} />
    </Animated.View>
  );
}

/**
 * 下面那面墙：`pickableFaces()`（十张，cap 没有自己的坑位不进来，spec §5.4）。选中 = 一圈边 +
 * 一块底，**只有它是活的**（一墙都在眨眼时，人分不出哪张是「我的」）；按下去那一下弹一次（demo 的
 * pickPop：1 → 1.12 → .98 → 1，340ms）——那是对动作的回应，不是状态，所以停下来之后不常驻放大
 * （一格常驻放大会把整行的基线顶歪）。关了动效不弹，只剩按下时的变暗。
 */
export function FaceWall({ current, onPick }: { current: string; onPick: (face: PickableFace) => void }) {
  const faces = useMemo(pickableFaces, []);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 12, paddingHorizontal: 16 }}>
      {faces.map((f) => (
        <FaceTile key={f.id} face={f} on={f.id === current} onPick={onPick} />
      ))}
    </View>
  );
}

function FaceTile({ face, on, onPick }: { face: PickableFace; on: boolean; onPick: (face: PickableFace) => void }) {
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
          width: 76, height: 70, borderRadius: 16, alignItems: "center", justifyContent: "center",
          borderWidth: 2, borderColor: on ? c.brand : "transparent",
          backgroundColor: on ? withAlpha(c.brand, 0.1) : "transparent",
          transform: [{ scale }],
        }}
      >
        <Face slot={face.slot} state={on ? "alive" : "plain"} tier="m" phase={facePhase(face.id)} />
      </Animated.View>
    </Pressable>
  );
}
