// 「我」页签（#1386，spec §5.8，demo 的 meRoot）：顶上一大块（头像 64、名字 + 档位、邮箱）点进去是个人信息；
// 「订阅与额度」（右边写本周还剩百分之几）；「它们共用的一台电脑」一段：文件 / 应用 / 记忆 / 这周谁用得多（A5 那几页）；设置。
// 退出登录挪进了「设置」（demo 同款）。后面四行只在有主场时画（没有它们就没有可看的）。
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { accountBadge, accountName, weekQuota } from "../../../src/shared/mobileAccount.js";
import { PlanPill } from "../account/PlanPill.js";
import { refreshBilling, useBilling } from "../account/billingStore.js";
import { useHome } from "../home/homeStore.js";
import { ensureProfile, refreshProfile, useProfile } from "../me/profileStore.js";
import { supabase } from "../supabase.js";
import { usePalette } from "../theme.js";
import { Group, Row, useNow } from "../ui.js";
import { PersonTile } from "../wx/Avatar.js";
import { Icon, type IconName } from "../wx/Icon.js";
import { useSafeAreaInsets } from "react-native-safe-area-context";

function Lead({ name }: { name: IconName }) {
  const { c } = usePalette();
  return <Icon name={name} size={21} stroke={1.7} color={c.mutedForeground} />;
}

/** 我叫什么：profiles 里那一格（朋友和群里的人看到的）优先，没有就用登录带来的名字 / 邮箱 */
export function useMyName(): { name: string; email: string; avatar: string } {
  const { me, loaded } = useProfile();
  const [auth, setAuth] = useState<{ name: string; email: string }>({ name: "", email: "" });
  // 只在「我」页聚焦时拉的话，冷启动直接进聊天，自己的头像要等去过「我」页才出来（#1519）；换号清仓后 loaded 回 false，再拉一次
  useEffect(() => {
    if (!loaded) void ensureProfile();
  }, [loaded]);
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user;
      setAuth({ name: accountName(u), email: u?.email ?? "" });
    });
  }, []);
  const name = me !== null && me.name.trim() !== "" ? me.name : auth.name;
  return { name, email: me?.email || auth.email, avatar: me?.avatarUrl ?? "" };
}

export function MeScreen() {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const ws = useHome().home;
  const { billing } = useBilling();
  const now = useNow(60_000);
  const me = useMyName();
  useFocusEffect(
    useCallback(() => {
      void refreshProfile();
      void refreshBilling();
    }, []),
  );
  const badge = accountBadge(billing);
  const q = weekQuota(billing, now);
  const quotaValue = q.kind === "week" ? `还剩 ${q.week.remaining}` : undefined;
  const subscribed = billing?.me?.windows != null;
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top, paddingBottom: 32, gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${me.name}，${me.email}，个人信息`}
          onPress={() => navigation.navigate("Profile")}
          style={({ pressed }) => [
            { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 20, paddingTop: 22, paddingBottom: 26, backgroundColor: c.card },
            pressed && { backgroundColor: c.press },
          ]}
        >
          <PersonTile name={me.name} url={me.avatar} size={64} me radius={12} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 22, fontWeight: "600", letterSpacing: -0.3, color: c.foreground }}>
                {me.name === "" ? " " : me.name}
              </Text>
              {badge !== null ? <PlanPill id={badge.id} label={badge.label} /> : null}
            </View>
            {me.email !== "" ? <Text numberOfLines={1} style={{ fontSize: 14, color: c.mutedForeground, marginTop: 4 }}>{me.email}</Text> : null}
          </View>
          <Icon name="chevron-right" size={18} color={c.faint} />
        </Pressable>

        <Group inset={52}>
          <Row
            leading={<Lead name="gauge" />}
            label={subscribed ? "订阅与额度" : "订阅"}
            {...(quotaValue === undefined ? {} : { value: quotaValue })}
            chevron
            onPress={() => navigation.navigate(subscribed ? "Quota" : "Subscription")}
          />
        </Group>

        {ws !== null ? (
          <Group header="它们共用的一台电脑" inset={52}>
            <Row leading={<Lead name="folder" />} label="文件" chevron onPress={() => navigation.navigate("Files", { path: "" })} />
            <Row leading={<Lead name="blocks" />} label="应用" {...(ws.connectors.length > 0 ? { value: `${ws.connectors.length} 个` } : {})} chevron onPress={() => navigation.navigate("Apps")} />
            <Row leading={<Lead name="book-open" />} label="记忆" chevron onPress={() => navigation.navigate("Wiki")} />
            <Row leading={<Lead name="chart-column" />} label="这周谁用得多" chevron onPress={() => navigation.navigate("Usage")} />
          </Group>
        ) : null}

        <Group inset={52}>
          <Row leading={<Lead name="settings" />} label="设置" chevron onPress={() => navigation.navigate("Settings")} />
        </Group>
      </ScrollView>
    </View>
  );
}
