// 导航的路由表（#1356）：一个原生栈。第一层只有一个主语——我有哪几只智能体——名册是栈底，
// 其余一律推进来。
export type RootStackParams = {
  Roster: undefined;
  Account: undefined;
};

// 让不带泛型的 useNavigation() 也认得这些屏
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParams {}
  }
}
