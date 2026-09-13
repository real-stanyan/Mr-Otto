// 导航的根。根栈：Main（三栏）+ 推进来盖住页签栏的屏（账号、好友、配对）。
// 每一栏自己一个原生栈（react-native-screens = UINavigationController）：推入 / 返回 / 左缘右划
// 都是系统的，天然可打断——spec §3.2。
import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from "@react-navigation/native";
import { createNativeStackNavigator, type NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { usePalette } from "../theme.js";
import { TabChromeProvider } from "../chrome.js";
import { OttoTabBar } from "./TabBar.js";
import { AvatarButton } from "./AvatarButton.js";
import { TasksRoot } from "../tabs/TasksRoot.js";
import { ProjectsRoot } from "../tabs/ProjectsRoot.js";
import { TeamsRoot } from "../tabs/TeamsRoot.js";
import { AccountScreen } from "../account/AccountScreen.js";
import { FriendsScreen } from "../friends/FriendsScreen.js";
import { PairScreen } from "../pair/PairScreen.js";
import type {
  ProjectsStackParams, RootStackParams, TabParams, TasksStackParams, TeamsStackParams,
} from "./types.js";

const Root = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<TabParams>();
const TasksStack = createNativeStackNavigator<TasksStackParams>();
const ProjectsStack = createNativeStackNavigator<ProjectsStackParams>();
const TeamsStack = createNativeStackNavigator<TeamsStackParams>();

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

/**
 * 页签根的导航栏：iOS 原生大标题，往上滚时原地缩进导航条、材质出现（demo 的 .nav 就是在模仿它）。
 * 透明 + 模糊：内容从导航栏底下滚过去；滚动容器带 contentInsetAdjustmentBehavior="automatic"
 * （ui.tsx 的 Page 已经带了），大标题的收放才跟手。右边一颗头像进账号。
 */
function rootTab(title: string): NativeStackNavigationOptions {
  return {
    title,
    headerLargeTitle: true,
    headerTransparent: true,
    headerBlurEffect: "systemChromeMaterial",
    headerLargeStyle: { backgroundColor: "transparent" },
    headerShadowVisible: false,
    headerLargeTitleShadowVisible: false,
    headerRight: () => <AvatarButton />,
  };
}

function TasksTab() {
  return (
    <TasksStack.Navigator>
      <TasksStack.Screen name="TasksRoot" component={TasksRoot} options={rootTab("任务")} />
    </TasksStack.Navigator>
  );
}

function ProjectsTab() {
  return (
    <ProjectsStack.Navigator>
      <ProjectsStack.Screen name="ProjectsRoot" component={ProjectsRoot} options={rootTab("项目")} />
    </ProjectsStack.Navigator>
  );
}

function TeamsTab() {
  return (
    <TeamsStack.Navigator>
      <TeamsStack.Screen name="TeamsRoot" component={TeamsRoot} options={rootTab("团队")} />
    </TeamsStack.Navigator>
  );
}

function Main() {
  return (
    <TabChromeProvider>
      {/* lazy:false：三栏一开 app 就都挂上。项目栏里握着到电脑的连接（握手 + 密封流），
          不能等人第一次点过去才开始连（原来三个页签「常驻挂载、靠 display 切」是同一个理由）。
          先落在项目栏：M0 里任务 / 团队两栏还是空态，M2 接上任务栏后改回 TasksTab（demo 登录后落在任务） */}
      <Tabs.Navigator
        initialRouteName="ProjectsTab"
        screenOptions={{ headerShown: false, lazy: false }}
        tabBar={(p) => <OttoTabBar {...p} />}
      >
        <Tabs.Screen name="TasksTab" component={TasksTab} />
        <Tabs.Screen name="ProjectsTab" component={ProjectsTab} />
        <Tabs.Screen name="TeamsTab" component={TeamsTab} />
      </Tabs.Navigator>
    </TabChromeProvider>
  );
}

export function RootNavigator() {
  const theme = useNavTheme();
  return (
    <NavigationContainer theme={theme}>
      <Root.Navigator>
        <Root.Screen name="Main" component={Main} options={{ headerShown: false }} />
        <Root.Screen name="Account" component={AccountScreen} options={{ title: "账号", headerBackTitle: "返回" }} />
        <Root.Screen name="Friends" component={FriendsScreen} options={{ title: "好友" }} />
        <Root.Screen name="Pair" component={PairScreen} options={{ title: "配对电脑", headerBackTitle: "返回" }} />
      </Root.Navigator>
    </NavigationContainer>
  );
}
