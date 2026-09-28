// 导航的根（#1386，微信式布局）：一个原生栈，栈底是页签屏（聊天 / 通讯录 / 我），其余一律推进来、盖住底栏（照 iOS 微信）。
// 推入 / 返回 / 左缘右划都是系统的（react-native-screens = UINavigationController），天然可打断（ADR-0293 决定 2 原样）。
// 推进来的页用原生导航条，样子照微信：只留返回箭头（前景色，不是点缀蓝）、标题居中、底下一道细线。
import { createBottomTabNavigator, type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useCallback } from "react";
import { usePalette } from "../theme.js";
import { SubscriptionScreen } from "../account/SubscriptionScreen.js";
import { SettingsScreen } from "../account/SettingsScreen.js";
import { AgentScreen } from "../agent/AgentScreen.js";
import { IncomingCall } from "../call/IncomingCall.js";
import { flushPendingNav } from "../call/ringStore.js";
import { ChatInfoScreen } from "../chat/ChatInfoScreen.js";
import { ChatScreen } from "../chat/ChatScreen.js";
import { FriendChatScreen } from "../friends/FriendChatScreen.js";
import { FriendScreen } from "../friends/FriendScreen.js";
import { GroupsScreen } from "../friends/GroupsScreen.js";
import { RequestsScreen } from "../friends/RequestsScreen.js";
import { useInbox } from "../inbox/useInbox.js";
import { AppsScreen } from "../machine/AppsScreen.js";
import { FilePreviewScreen } from "../machine/FilePreviewScreen.js";
import { FilesScreen } from "../machine/FilesScreen.js";
import { UsageScreen } from "../machine/UsageScreen.js";
import { WikiEditScreen } from "../machine/WikiEditScreen.js";
import { WikiPageScreen } from "../machine/WikiPageScreen.js";
import { WikiScreen } from "../machine/WikiScreen.js";
import { ProfileScreen } from "../me/ProfileScreen.js";
import { QuotaScreen } from "../me/QuotaScreen.js";
import { ChatsScreen } from "../tabs/ChatsScreen.js";
import { ContactsScreen } from "../tabs/ContactsScreen.js";
import { MeScreen } from "../tabs/MeScreen.js";
import { TabBar } from "../tabs/TabBar.js";
import { ToastHost } from "../wx/toast.js";
import { FaceGallery } from "../dev/FaceGallery.js";
import { navRef } from "./navRef.js";
import type { HomeTabParams, RootStackParams } from "./types.js";

const Root = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<HomeTabParams>();

/** 导航的配色从 theme.ts 取：导航栏底色就是地面 */
function useNavTheme(): Theme {
  const { c, isDark } = usePalette();
  const base = isDark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: c.brand, background: c.background, card: c.background,
      text: c.foreground, border: c.border, notification: c.brand,
    },
  };
}

function HomeTabs() {
  const inbox = useInbox();
  const badges = { Chats: inbox.unreadChats, Contacts: inbox.incoming };
  const tabBar = useCallback((props: BottomTabBarProps) => <TabBar {...props} badges={badges} />, [badges.Chats, badges.Contacts]);
  return (
    <Tabs.Navigator screenOptions={{ headerShown: false, animation: "none" }} tabBar={tabBar}>
      <Tabs.Screen name="Chats" component={ChatsScreen} />
      <Tabs.Screen name="Contacts" component={ContactsScreen} />
      <Tabs.Screen name="Me" component={MeScreen} />
    </Tabs.Navigator>
  );
}

export function RootNavigator() {
  const theme = useNavTheme();
  const { c } = usePalette();
  return (
    <NavigationContainer ref={navRef} theme={theme} onReady={flushPendingNav}>
      <Root.Navigator
        screenOptions={{
          headerBackButtonDisplayMode: "minimal",
          headerTintColor: c.foreground,
          headerTitleStyle: { fontSize: 17, fontWeight: "600" },
          headerStyle: { backgroundColor: c.background },
        }}
      >
        <Root.Screen name="Home" component={HomeTabs} options={{ headerShown: false }} />
        {/* 标题由聊天页自己 setOptions（名字 + 人数 + 第二行状态） */}
        <Root.Screen name="Chat" component={ChatScreen} options={{ title: "" }} />
        <Root.Screen name="FriendChat" component={FriendChatScreen} options={{ title: "" }} />
        <Root.Screen name="ChatInfo" component={ChatInfoScreen} options={{ title: "聊天信息" }} />
        <Root.Screen name="Agent" component={AgentScreen} options={{ title: "", headerShadowVisible: false }} />
        <Root.Screen name="Friend" component={FriendScreen} options={{ title: "", headerShadowVisible: false }} />
        <Root.Screen name="Requests" component={RequestsScreen} options={{ title: "新的朋友" }} />
        <Root.Screen name="Groups" component={GroupsScreen} options={{ title: "群聊" }} />
        <Root.Screen name="Profile" component={ProfileScreen} options={{ title: "个人信息" }} />
        <Root.Screen name="Quota" component={QuotaScreen} options={{ title: "订阅与额度" }} />
        <Root.Screen name="Subscription" component={SubscriptionScreen} options={{ title: "订阅" }} />
        {/* 标题由这两页自己按路径 setOptions（最外层写「文件」，其余写那一段的名字） */}
        <Root.Screen name="Files" component={FilesScreen} options={{ title: "文件" }} />
        <Root.Screen name="FilePreview" component={FilePreviewScreen} options={{ title: "" }} />
        <Root.Screen name="Wiki" component={WikiScreen} options={{ title: "记忆" }} />
        <Root.Screen name="WikiPage" component={WikiPageScreen} options={{ title: "", headerShadowVisible: false }} />
        <Root.Screen name="WikiEdit" component={WikiEditScreen} options={{ title: "改这一页", headerShadowVisible: false }} />
        <Root.Screen name="Usage" component={UsageScreen} options={{ title: "这周谁用得多" }} />
        <Root.Screen name="Apps" component={AppsScreen} options={{ title: "应用" }} />
        <Root.Screen name="Settings" component={SettingsScreen} options={{ title: "设置" }} />
        {/* 形象陈列馆：只在开发构建里有（#1356 A0，见 dev/FaceGallery.tsx 头注） */}
        {__DEV__ ? <Root.Screen name="FaceGallery" component={FaceGallery} options={{ title: "形象陈列馆" }} /> : null}
      </Root.Navigator>
      <IncomingCall />
      <ToastHost />
    </NavigationContainer>
  );
}
