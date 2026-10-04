// 时 / 分两列滚轮（#1283）：纯 JS（ScrollView + snapToInterval），不加原生依赖——原生改动走不了热更新（ADR-0340）。
// 滚轮是手上带着动量的东西：停靠、惯性都交给原生滚动，不再叠一层自己的动画（滚到哪儿、停在哪儿，手指说了算）。
// 点一格也能选（不想拖的人 / 读屏），点中那一格滚过去。
import { useRef } from "react";
import { Pressable, ScrollView, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { type as t, usePalette } from "../theme.js";

const ITEM = 36;
const VISIBLE = 5;

function Column({ count, value, onChange, label }: { count: number; value: number; onChange: (v: number) => void; label: string }) {
  const { c } = usePalette();
  const ref = useRef<ScrollView>(null);
  const settle = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    onChange(Math.max(0, Math.min(count - 1, Math.round(e.nativeEvent.contentOffset.y / ITEM))));
  };
  const step = (d: number): void => {
    const v = Math.max(0, Math.min(count - 1, value + d));
    ref.current?.scrollTo({ y: v * ITEM, animated: true });
    onChange(v);
  };
  return (
    <ScrollView
      ref={ref}
      // 初始位置走 contentOffset（首帧就在位）：挂载后 scrollTo 赶在布局之前会落空。之后的位置归手指管，value 变了不回写
      contentOffset={{ x: 0, y: value * ITEM }}
      style={{ height: ITEM * VISIBLE, width: 72 }}
      showsVerticalScrollIndicator={false}
      snapToInterval={ITEM}
      snapToAlignment="start"
      decelerationRate="fast"
      // 外面是弹窗那层竖向滚动：安卓上要明说「这一列自己滚」，否则手指被外层抢走
      nestedScrollEnabled
      contentContainerStyle={{ paddingVertical: ITEM * 2 }}
      onMomentumScrollEnd={settle}
      onScrollEndDrag={(e) => { if (Math.abs(e.nativeEvent.velocity?.y ?? 0) < 0.05) settle(e); }}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: String(value).padStart(2, "0") }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => step(e.nativeEvent.actionName === "increment" ? 1 : -1)}
    >
      {Array.from({ length: count }, (_, i) => (
        <Pressable key={i} onPress={() => step(i - value)} style={{ height: ITEM, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ ...t.body, fontSize: 20, fontWeight: i === value ? "600" : "400", color: i === value ? c.foreground : c.mutedForeground }}>
            {String(i).padStart(2, "0")}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** value / onChange 都是 "HH:mm" */
export function TimeWheel({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { c } = usePalette();
  const hh = Number(value.slice(0, 2)) || 0;
  const mm = Number(value.slice(3, 5)) || 0;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "center" }}>
      {/* 中间那条选中带：不接手指，让手指落在下面的列上 */}
      <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: ITEM * 2, height: ITEM, borderTopWidth: 0.5, borderBottomWidth: 0.5, borderColor: c.border }} />
      <Column count={24} value={hh} label="小时" onChange={(h) => onChange(`${pad(h)}:${pad(mm)}`)} />
      <Text style={{ ...t.body, fontSize: 20, fontWeight: "600", color: c.foreground, marginHorizontal: 4 }}>:</Text>
      <Column count={60} value={mm} label="分钟" onChange={(m) => onChange(`${pad(hh)}:${pad(m)}`)} />
    </View>
  );
}
