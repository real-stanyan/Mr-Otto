// 「分享会话」那条私信在**手机上**画成什么（#1271）。
//
// 信封本身（`sessionPackageCodec.ts` 的 `decodeEnvelope`）两端早就共用了，缺的是手机端没人调它：
// 于是桌面发过来的分享在手机上是一整坨原始 JSON，连邀请码一起明文摊在气泡里。
//
// 判据全在这一份纯函数里，理由有两条：
//   1. `mobile/` 没有测试运行器，纯逻辑不挪进来就只有手跑模拟器这一种保障（总纲 §7）；
//   2. **「邀请码不上屏」这件事得有人钉住**。它是一次性 secret（ADR-0151 的带外信道），
//      放进 DM 是有意的——但那是给「接上服务」那颗钮读的，不是给人读的。
//      这里返回的每一格都不含它，`tests/shared/shareCard.test.ts` 有一条断言盯着。
//
// 手机上**不画动作钮**：导入要有工作区、接服务要能配对，手机两样都没有（ADR-0114 划的范围）。
// 画一颗点了必然失败的钮就是 #722 那个撒谎的勾，所以只写一句「去哪儿做」。
import type { ShareEnvelope } from "./sessionPackageCodec.js";

export interface ShareCardView {
  /** 抬头：谁分享的 */
  heading: string;
  /** 《源会话标题》。没有就不画那一行 */
  title: string | null;
  /** 发送方那句留言。没有就不画 */
  message: string | null;
  /** 「130 条事件」。数字不像数就说不详，不编一个 */
  meta: string;
  /** 连带借出的服务。没借就不画 */
  grant: string | null;
  /** 手机上能做什么 —— 这一格永远有，因为手机上做不了，得说清去哪儿做 */
  hint: string;
}

function clean(s: string | null | undefined): string | null {
  const v = (s ?? "").trim();
  return v === "" ? null : v;
}

export function shareCardView(
  env: ShareEnvelope,
  opts: { mine: boolean; fromName: string },
): ShareCardView {
  const who = clean(opts.fromName) ?? "对方";
  const servers = (env.grantServers ?? []).map((s) => clean(s)).filter((s): s is string => s !== null);
  return {
    heading: opts.mine ? "你分享了一个会话" : `${who} 分享了一个会话`,
    title: clean(env.title),
    message: clean(env.message),
    // eventCount 是对面写进信封的数，不是我们算的：不像数就别替它编一个
    meta:
      typeof env.eventCount === "number" && Number.isFinite(env.eventCount) && env.eventCount >= 0
        ? `${env.eventCount} 条事件`
        : "条数不详",
    grant:
      servers.length === 0
        ? null
        : opts.mine
          ? `连带借出了：${servers.join("、")}`
          : `${who} 连带把这些服务借给你用：${servers.join("、")}`,
    hint: opts.mine
      ? "对方在电脑上的 Mr Otto 里导入。"
      : "在电脑上的 Mr Otto 里导入 —— 手机上还打不开会话包。",
  };
}
