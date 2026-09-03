// 订阅/加购/Portal 那几条路上的报错说给人听（issue #910）。
//
// 起因：真机上点「订阅」，账号页底下铺开一整段 Stripe 的英文原文——
// "Invalid line_items[0]: the product tax code is missing… you can pass
// managed_payments[enabled]=false… configure at https://dashboard.stripe.com/acct_…"。
// 那段话**是说给我们听的**：它告诉维护者去改哪个后台开关。对用户，它既看不懂，
// 又什么都做不了，还顺手把我们的 Stripe 账号 id 印在了屏幕上。
//
// 同型的毛病 #843 第 3 条写过一遍（数据库原文直接怼用户）。规矩照
// lib/mcpInstalled.ts 的 humanizeMcpError：**只翻认得出的，认不出的原样保留**——
// 一句看不懂的英文，比一句自信的错误翻译有用得多。
//
// 与 humanizeMcpError 的一处不同：这里认出来的那几类，翻译之后**不再把原文带上屏**。
// 支付配置类的错对用户只有一个意思——「我们这边没配好，不是你的账号」——多给的每一个
// 字节都只是噪音；而原文并没有丢，主进程那侧照常整条打进日志（真机上就是这么发现的）。

/** Stripe 配置类：钱那一侧还没配好，用户做什么都没用。合并成一句话，
    因为对用户来说它们的区别为零——都是「先别试了，等我们修」。 */
const STRIPE_CONFIG =
  /product tax code|managed[_ ]payments|No such price|price.*not found|resource_missing|Invalid line_items/i;

/** 我们自己那侧的档位没配全（README 部署清单 ①c 没填 stripe_price_id 的症状）。
    这句本来就是中文，认出来只是为了不让它落进上面那条更笼统的翻译里 */
const PLAN_UNCONFIGURED = /这个档位还没配 Stripe price/;

export function humanizeBillingError(raw: string): string {
  const t = raw.trim();
  if (t === "") return t;

  if (PLAN_UNCONFIGURED.test(t)) return t;

  // 顺序要紧：already_subscribed 是一条**用户能懂也能行动**的错，
  // 别被下面那条笼统的配置类吃掉
  if (/already[_ ]subscribed|\b409\b/i.test(t)) {
    return "你已经有一份进行中的订阅了。换档去「管理订阅」，不要在这里重开一张——重开会变成两条订阅、两笔一起扣。";
  }
  if (/no[_ ]subscription|\b402\b/i.test(t)) {
    return "这一步需要订阅。先选一个档位订阅，或者在模型设置里填自己的 key。";
  }
  if (/quota[_ ]exhausted|\b429\b/i.test(t)) {
    return "这个时间窗的额度用完了。等窗口重置，或者加购额度。";
  }
  if (STRIPE_CONFIG.test(t)) {
    return "支付页开不起来：Mr Otto 这边的支付配置还没弄好，不是你的账号或银行卡的问题。这条已经记下了，先别反复点。";
  }
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|network/i.test(t)) {
    return "连不上支付服务 —— 网络不通，或者对面暂时没响应。";
  }
  if (/timed? ?out/i.test(t)) return "等太久没回应，超时了。稍后再试。";

  // 认不出：原样。别猜
  return t;
}
