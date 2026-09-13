// 页签根导航栏右边那颗头像：点进账号。按下缩到 .93（demo 的 .navbtn:active）。
// 名字 / 头像先取 OAuth 带来的 user_metadata；profiles 那份（桌面 lib/identity.ts 的裁决）等 M5 账号页一起接。
import { useEffect, useRef, useState } from "react";
import { Animated, Pressable } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { supabase } from "../supabase.js";
import { PRESS_SPRING } from "../theme.js";
import { Avatar, useReduceMotion } from "../ui.js";

export function AvatarButton() {
  const navigation = useNavigation();
  const reduce = useReduceMotion();
  const [me, setMe] = useState<{ name: string; url?: string }>({ name: "" });
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user;
      const meta = (u?.user_metadata ?? {}) as { name?: string; full_name?: string; avatar_url?: string };
      setMe({
        name: meta.name ?? meta.full_name ?? u?.email ?? "",
        ...(meta.avatar_url ? { url: meta.avatar_url } : {}),
      });
    });
  }, []);
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number): void => {
    if (!reduce) Animated.spring(scale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel="账号" hitSlop={8}
      onPressIn={() => to(0.93)} onPressOut={() => to(1)}
      onPress={() => navigation.navigate("Account")}
      style={({ pressed }) => [
        // 关了动效时，按下的反馈退成变暗——反馈本身不能没有（同 ui.tsx 的 Button）
        reduce && pressed && { opacity: 0.7 },
      ]}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <Avatar name={me.name} url={me.url} size={31} />
      </Animated.View>
    </Pressable>
  );
}
