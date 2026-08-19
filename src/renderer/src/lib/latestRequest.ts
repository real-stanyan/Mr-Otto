// "最后发起的那个才算数" —— 异步取数的作废闸。
//
// 为什么需要:右栏详情是同一块槽位。快速点 #1 再点 #2,两次请求在飞,
// 谁先回来不由发起顺序决定;#1 晚到就会把 #2 的内容盖掉,而用户点的是 #2。
// 原来的守卫只比 protocolRepo——同一个仓库内的连点它一概放行。

export interface RequestGate {
  /** 发起一次请求,拿到凭证 */
  begin(): number;
  /** 这张凭证还是最新的吗?不是就丢弃结果,别 set 进 store */
  isCurrent(token: number): boolean;
}

export function createRequestGate(): RequestGate {
  let latest = 0;
  return {
    begin: () => ++latest,
    isCurrent: (token) => token === latest,
  };
}
