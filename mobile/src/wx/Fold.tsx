// 通讯录里可折叠的一段（#1386，维护者 2026-09-27「智能体和好友各能折叠显示，看得清楚一点」）：
// 段头 = 箭头 + 名字 + 个数，右边可以挂一颗小钮（「新建」）；收起时箭头转 -90°。
// 折叠状态记在这台手机上（kv-store）；搜索时一律展开——搜到的那一行不该被折叠藏起来。
import AsyncStorage from "expo-sqlite/kv-store";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";
import { usePalette } from "../theme.js";
import { useReduceMotion } from "../ui.js";
import { Icon } from "./Icon.js";

const KEY = "otto.wx.fold";
let cache: Record<string, boolean> | null = null;
const listeners = new Set<() => void>();

async function load(): Promise<Record<string, boolean>> {
  if (cache !== null) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = raw === null ? {} : (JSON.parse(raw) as Record<string, boolean>);
  } catch {
    cache = {};
  }
  return cache;
}

function save(key: string, closed: boolean): void {
  cache = { ...(cache ?? {}), [key]: closed };
  for (const l of listeners) l();
  void AsyncStorage.setItem(KEY, JSON.stringify(cache)).catch(() => undefined);
}

export function Fold({ id, label, count, action, forceOpen = false, children }: {
  id: string;
  label: string;
  count: number;
  action?: ReactNode;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    let alive = true;
    const sync = (): void => {
      if (alive && cache !== null) setClosed(cache[id] === true);
    };
    listeners.add(sync);
    void load().then(sync);
    return () => {
      alive = false;
      listeners.delete(sync);
    };
  }, [id]);
  const open = forceOpen || !closed;
  const turn = useRef(new Animated.Value(open ? 1 : 0)).current;
  useEffect(() => {
    if (reduce) {
      turn.setValue(open ? 1 : 0);
      return;
    }
    Animated.timing(turn, { toValue: open ? 1 : 0, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [open, reduce, turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["-90deg", "0deg"] });
  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 8, paddingRight: 12, paddingTop: 14, paddingBottom: 6 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}，${count} 个`}
          accessibilityState={{ expanded: open }}
          onPress={() => {
            if (!forceOpen) save(id, open);
          }}
          style={({ pressed }) => [
            { flexDirection: "row", alignItems: "center", gap: 4, height: 32, paddingHorizontal: 8, borderRadius: 8 },
            pressed && { backgroundColor: c.press },
          ]}
        >
          <Animated.View style={{ transform: [{ rotate }] }}>
            <Icon name="chevron-down" size={14} stroke={2.2} color={c.mutedForeground} />
          </Animated.View>
          <Text style={{ fontSize: 14, fontWeight: "500", color: c.mutedForeground }}>{label}</Text>
          <Text style={{ fontSize: 13, color: c.faint, fontVariant: ["tabular-nums"] }}>{count}</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        {action}
      </View>
      {open ? children : null}
    </View>
  );
}
