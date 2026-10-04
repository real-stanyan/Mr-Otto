// 人与人的通话页（#1534，ADR-0357）：整屏深色，同 CallOverlay 的样子——对方头像、状态一行（正在呼叫 / 连接中 / 通话中 + 计时 /
// 结局）、底下两颗钮（静音、挂断）。路由参数只说「哪一通、和谁、是不是来电」；状态从 call/humanCall.ts 的 store 读，
// 打与接都在那边接好线了（打：进这一页之前 FriendChatScreen 已经 startHumanCall；接：callKit.ts 在 answer 事件里 answerHumanCall）。
// 结局出来之后再停两秒自己退出（人要看一眼「对方没接」）。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { humanCallStatusText } from "../../../src/shared/humanCall.js";
import { friendName } from "../../../src/shared/wechatInbox.js";
import { useFriends } from "../friends/friendsStore.js";
import type { RootStackParams } from "../nav/types.js";
import { PersonTile } from "../wx/Avatar.js";
import { Icon } from "../wx/Icon.js";
import { dismissHumanCall, hangUpHumanCall, setHumanMic, useHumanCall } from "./humanCall.js";

type Props = NativeStackScreenProps<RootStackParams, "HumanCall">;

const SHELL = "#101114";
const FG = "#ffffff";
const FG2 = "rgba(255,255,255,0.6)";

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function Timer({ sinceTs }: { sinceTs: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - sinceTs) / 1000));
  return <Text style={{ fontSize: 15, color: FG2, fontVariant: ["tabular-nums"] }}>{`${pad(Math.floor(s / 60))}:${pad(s % 60)}`}</Text>;
}

export function HumanCallScreen({ route, navigation }: Props) {
  const { friendUid } = route.params;
  const insets = useSafeAreaInsets();
  const friends = useFriends();
  const call = useHumanCall();
  const row = friends.rows?.find((r) => r.profile.id === friendUid) ?? null;
  const name = row !== null ? friendName(row.profile) : "朋友";
  const avatar = row?.profile.avatarUrl ?? "";
  const mine = call !== null && call.callId === route.params.callId ? call : null;
  const ended = mine === null || mine.phase === "ended";

  // 结局出来停两秒再退：人要看一眼为什么没接通
  useEffect(() => {
    if (!ended) return;
    const t = setTimeout(() => {
      dismissHumanCall();
      if (navigation.canGoBack()) navigation.goBack();
    }, 2000);
    return () => clearTimeout(t);
  }, [ended, navigation]);

  const status = mine === null ? "通话结束" : humanCallStatusText(mine, mine.incoming);
  return (
    <View style={{ flex: 1, backgroundColor: SHELL, paddingTop: insets.top + 48, paddingBottom: insets.bottom + 40, paddingHorizontal: 24, alignItems: "center", justifyContent: "space-between" }}>
      <View style={{ alignItems: "center", gap: 16 }}>
        <PersonTile name={name} url={avatar} size={96} />
        <Text style={{ fontSize: 24, fontWeight: "600", color: FG }}>{name}</Text>
        {mine !== null && mine.phase === "live" && mine.liveSinceTs !== null ? <Timer sinceTs={mine.liveSinceTs} /> : <Text style={{ fontSize: 15, color: FG2 }}>{status}</Text>}
        {mine?.note ? <Text style={{ fontSize: 13, color: FG2, textAlign: "center" }}>{mine.note}</Text> : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 48 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={mine?.micOn === false ? "开麦" : "静音"}
          disabled={ended}
          onPress={() => setHumanMic(!(mine?.micOn ?? true))}
          style={({ pressed }) => [{ width: 64, height: 64, borderRadius: 32, backgroundColor: mine?.micOn === false ? FG : "rgba(255,255,255,0.14)", alignItems: "center", justifyContent: "center" }, (pressed || ended) && { opacity: 0.5 }]}
        >
          <Icon name="mic" size={26} stroke={2} color={mine?.micOn === false ? SHELL : FG} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="挂断"
          disabled={ended}
          onPress={() => hangUpHumanCall(mine?.incoming === true && mine.phase === "ringing" ? "declined" : "user")}
          style={({ pressed }) => [{ width: 64, height: 64, borderRadius: 32, backgroundColor: "#e5484d", alignItems: "center", justifyContent: "center" }, (pressed || ended) && { opacity: 0.5 }]}
        >
          <Icon name="phone" size={26} stroke={2} color={FG} />
        </Pressable>
      </View>
    </View>
  );
}
