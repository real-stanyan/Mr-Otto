// 桌面 → 手机的 fleet 投影。**这是"什么东西离开这台机器"的唯一收口**:
// 岛和手机共用同一份 IslandFleet(ADR-0094:手机是第三个投影窗口),
// 但岛在本机进程间走管道,手机隔着公网走中继 —— 两者能看的东西不该是同一份。
//
// 这个函数存在的价值不在它今天剪掉了多少,而在于它是一处可以被测试钉住的闸门:
// 以后往 IslandFleet 上加字段的人,必须显式决定它该不该出机器。
//
// 纯文件:不许 import node builtin / electron(手机端 import 同一份)。

import type { IslandFleet } from "../shellBridge.js";

export function trimForMobile(fleet: IslandFleet): IslandFleet {
  return {
    // projectRoot / branch 不出机器:两者都是**桌面灵动岛的分组用料**——
    // projectRoot 是又一条本机绝对路径,branch 是本机 git 的状态,而手机端那一屏
    // 既不分组也不显示分支(mobile/ 里没有任何地方读它们)。没人读的东西不该
    // 持续过公网,哪怕中继解不开。要是哪天手机端也要按项目分组,把这里放开、
    // 并在那时重新回答"绝对路径能不能出机器"这个问题
    agents: fleet.agents.map(({ projectRoot: _p, branch: _b, ...agent }) => agent),
    focusedSessionId: fleet.focusedSessionId,
    // display / usage 一律不出机器:
    // - display 是灵动岛展开态的本机设置,手机没有那个 UI
    // - usage 是账单投影(近 14 天每天烧了多少 token)。手机端的职责是"看 + 审批"
    //   (ADR-0094 的范围),用量不在里面;而它每次推送都跟着走,等于把账单流水
    //   持续送过公网 —— 中继解不开,但这是"本来就不该发"而不是"发了也没事"
  };
}
