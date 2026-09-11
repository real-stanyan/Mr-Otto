// 导航的路由表。根栈放「推进一层、盖住页签栏」的屏（账号、好友、配对）；
// 每个页签自己一个栈，M2 起各栏的会话页推在各自的栈里。
export type RootStackParams = {
  Main: undefined;
  Account: undefined;
  Friends: undefined;
  Pair: undefined;
};

export type TabParams = {
  TasksTab: undefined;
  ProjectsTab: undefined;
  TeamsTab: undefined;
};

export type TasksStackParams = { TasksRoot: undefined };
export type ProjectsStackParams = { ProjectsRoot: undefined };
export type TeamsStackParams = { TeamsRoot: undefined };

// 让不带泛型的 useNavigation() 也认得根栈里的屏：页签里的屏要跳到根栈（账号、配对），
// navigate 会沿着嵌套往上冒泡到认得这个名字的那一层
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParams {}
  }
}
