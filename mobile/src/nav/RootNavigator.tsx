// 导航的根：一个原生栈（#1356，spec §4 / §5）。没有底栏、没有第二个根——一个只回答
// 「我有哪几只智能体」的 App 不需要第二个根。推入 / 返回 / 左缘右划都是系统的
// （react-native-screens = UINavigationController），天然可打断（ADR-0293 决定 2 原样成立）。
import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { usePalette } from "../theme.js";
import { RosterScreen } from "../roster/RosterScreen.js";
import { AccountScreen } from "../account/AccountScreen.js";
import { AgentSettingsScreen } from "../agent/AgentSettingsScreen.js";
import { FaceGallery } from "../dev/FaceGallery.js";
import type { RootStackParams } from "./types.js";

const Root = createNativeStackNavigator<RootStackParams>();

/** 导航的配色从 theme.ts 取：返回键是点缀色、导航栏底色就是地面 */
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

export function RootNavigator() {
  const theme = useNavTheme();
  return (
    <NavigationContainer theme={theme}>
      <Root.Navigator>
        {/* 名册自己画浮在内容上的圆钮（demo 的 .pillnav），不要原生导航条 */}
        <Root.Screen name="Roster" component={RosterScreen} options={{ headerShown: false }} />
        <Root.Screen name="Account" component={AccountScreen} options={{ title: "账号", headerBackTitle: "返回" }} />
        <Root.Screen
          name="AgentSettings"
          component={AgentSettingsScreen}
          options={{ title: "", headerBackTitle: "返回", headerShadowVisible: false }}
        />
        {/* 形象陈列馆：只在开发构建里有（#1356 A0，见 dev/FaceGallery.tsx 头注） */}
        {__DEV__ ? (
          <Root.Screen name="FaceGallery" component={FaceGallery} options={{ title: "形象陈列馆", headerBackTitle: "返回" }} />
        ) : null}
      </Root.Navigator>
    </NavigationContainer>
  );
}
