// 手机到自己那台电脑的加密连接（ADR-0094 那条中继路），此刻用一句话怎么说。
//
// 原来挂在手机顶部的品牌栏上；三栏之后品牌栏没了，这句话挪到项目栏大标题底下
// （项目栏就是这条连接的消费方），账号页也读它。两处说的是同一件事，判据只能有一份。
//
// tone 只承担「哪一类」，话由 text 说全——不靠颜色单独传信息。
export type LinkTone = "ok" | "warn";

export interface LinkStatus {
  tone: LinkTone;
  text: string;
}

/**
 * @param ready 握手完成、密封流通着
 * @param settled 断开已经超过宽限期（6 秒）——在那之前一律当抖动看，不说「断开了」
 * @param hasSnapshot 手里还留着断线前那份舰队：要说清楚下面看到的是旧的
 */
export function linkStatus(ready: boolean, settled: boolean, hasSnapshot: boolean): LinkStatus {
  if (ready) return { tone: "ok", text: "已连上你的 Mac" };
  if (!settled) return { tone: "warn", text: "重连中…" };
  return { tone: "warn", text: hasSnapshot ? "断开了 —— 下面是断线前的" : "断开了" };
}
