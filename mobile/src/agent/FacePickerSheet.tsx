// 「换个形象」（#1356 A1，spec §5.4）：上面一张 l 档大脸走一遍它干活的样子（排队 → 思考 →
// 检索 → 执行 → 作答 → 完成 → 活着，循环；换一张脸从头走），下面那面墙只有选中那张是活的。
// 墙上是 pickableFaces()：十张，cap 没有自己的坑位不进来（spec §5.4，维护者 2026-09-24 确认）。
// 点一张只改表单里的那一格；真正写库在设置页按「存」的时候（没换就不写）。
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { FACE_TOUR, pickableFaces } from "../../../src/shared/agentSettingsForm.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import { faceCharacterAt } from "../../../src/shared/ottoFace/index.js";
import { Face } from "../face/Face.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";

/** 大脸那一遍。关了动效就停在「活着」那一格（它自己也是静止一帧） */
function FaceTour({ slot, ring }: { slot: number; ring: string }) {
  const reduce = useReduceMotion();
  const [i, setI] = useState(0);
  // 换一张脸从头走
  useEffect(() => {
    setI(0);
  }, [slot]);
  useEffect(() => {
    if (reduce) return;
    const step = FACE_TOUR[i % FACE_TOUR.length]!;
    const t = setTimeout(() => setI((n) => n + 1), step.ms);
    return () => clearTimeout(t);
  }, [i, reduce, slot]);
  const state = reduce ? "alive" : FACE_TOUR[i % FACE_TOUR.length]!.state;
  return <Face slot={slot} state={state} tier="l" ringColor={ring} />;
}

export function FacePickerSheet({ visible, current, onPick, onClose, onExited }: {
  visible: boolean;
  /** 此刻画的那一格（表单里的选择，没挑过就是派生出来的那张） */
  current: number;
  onPick: (slot: number) => void;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  const faces = useMemo(pickableFaces, []);
  const currentId = faceCharacterAt(current).id;
  return (
    <BottomSheet visible={visible} title="换个形象" onClose={onClose} {...(onExited === undefined ? {} : { onExited })}>
      <ScrollView contentContainerStyle={{ alignItems: "center", paddingTop: 8, paddingBottom: 24 }}>
        <FaceTour slot={current} ring={c.card} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 12, paddingHorizontal: 16, marginTop: 20 }}>
          {faces.map((f) => {
            const on = f.id === currentId;
            return (
              <Pressable
                key={f.id}
                accessibilityRole="button"
                accessibilityLabel={f.name}
                accessibilityState={{ selected: on }}
                onPress={() => onPick(f.slot)}
                style={({ pressed }) => [
                  {
                    width: 76, height: 70, borderRadius: 16, alignItems: "center", justifyContent: "center",
                    borderWidth: 2, borderColor: on ? c.brand : "transparent",
                    backgroundColor: on ? withAlpha(c.brand, 0.1) : "transparent",
                  },
                  pressed && { opacity: 0.7 },
                ]}
              >
                {/* 只有选中那张是活的：一墙都在眨眼时，人分不出哪张是「我的」 */}
                <Face slot={f.slot} state={on ? "alive" : "plain"} tier="m" phase={facePhase(f.id)} />
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </BottomSheet>
  );
}
