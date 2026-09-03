# ADR-0216：Mr Otto 自己是 merchant of record，Managed Payments 显式关掉

- 状态：已采纳
- 日期：2026-09-03
- 关联：issue #910（真机上点订阅一律 400）、ADR-0174/0175/0176（订阅制定形）、ADR-0203（落地）、#906（部署收尾的手验清单）

## 背景

真机 dev 上点「订阅」，三个档位**全部 400**，一次都创建不出 checkout session：

```
stripe checkout/sessions 400: Invalid line_items[0]: the product tax code is missing.
Product tax code is required for Managed Payments, which is enabled by default on your account.
If you want to disable Managed Payments on this session, you can pass managed_payments[enabled]=false.
```

代码没错。`checkoutParams()` 是纯函数，`tests/edge/billing.test.ts` 里两条钉着它。是 Stripe
账号侧的两件事撞上了：**Managed Payments 在这个账号上默认开启**，而四个 Product 都没填
`tax_code`。

Managed Payments 是 Stripe 替商家当 **merchant of record** 的那套东西——它替你向各国收税、
报税，代价是它必须知道你卖的是什么品类（各国对 SaaS / 下载软件 / AI 服务的规则不一样），
所以 `tax_code` 从"可选元数据"变成"没有就不让你开单"。

这条闸是 #906 手验清单本来要抓的东西（`services/edge/README.md` 那九条里「买一笔真的走一遍」），
被一次随手试用提前抓到了——也顺带说明那份清单一条都还没跑过。

## 决定

`checkoutParams()` 里显式 `managed_payments[enabled]=false`。**Mr Otto 自己是 merchant of
record，各国 VAT/GST 由我们自己管。**

这不是新方向，是把一直以来的假设写出口：ADR-0174/0175/0176 到 0203 整套设计里，钱的事实是
我们自己的 `usage_event` 表、额度是我们自己的 Quota DO、退款与换档走我们自己接的 Portal——
从来没有一处假设过有第三方替我们承担税务身份。Stripe 把 Managed Payments 设成账号默认，
于是这个从没被选择过的形态悄悄成了现状，直到它把 checkout 打成 400 才现身。

**写在每次会话的参数上，而不是只去后台把默认值关掉。** 后台那一格是 Stripe 的开关：Stripe
可以改它的默认，而且 test / live 是两份、要分别改。参数里写死之后，行为不再取决于"后台那一格
此刻是什么"——同一份代码在任何账号、任何模式下都开得出单。

两种 mode 都带这个参数：加购走的是 `payment` 模式，它过的是同一道校验。

## 顺带修掉：错误别把 Stripe 原文怼给用户

出事时账号页底下铺开一整段英文，还带着后台链接和我们的 Stripe 账号 id。**那段话是说给维护者
听的**——它告诉我们去改哪个开关；对用户既看不懂又做不了任何事。同型的毛病 #843 第 3 条写过
一遍（数据库原文直接怼用户）。

`src/renderer/src/lib/billingError.ts` 的 `humanizeBillingError`，规矩照 `humanizeMcpError`：
**只翻认得出的，认不出的原样保留**——一句看不懂的英文比一句自信的错误翻译有用得多。

一处与 `humanizeMcpError` 不同：认出来的那几类翻译之后**不再把原文带上屏**。支付配置类的错
对用户只有一个意思（「我们这边没配好，不是你的账号」），多给的每个字节都只是噪音；而原文没有
丢，主进程那侧照常整条打进日志——真机上就是这么发现的。

分类的边界有一条值得记：**卡被拒（`card_declined`）不算配置类**。那是用户能处理的事，把它
翻成「我们这边没配好」会让一个换张卡就能解决的人干等着。测试里单钉了这一条。

## 代价

- **各国 VAT/GST 的注册与申报落在我们头上。** 欧盟的数字服务 VAT、澳洲 GST、各州销售税——
  规模小的时候多数有门槛豁免，长大了就不是。这是这个决定真正的账单，不在代码里。
- 关掉 Managed Payments 也就关掉了 Stripe 那套现成的税率表与代收代缴。

## 什么前提失效会推翻它

**「我们愿意自己承担税务身份」。** 哪天营收过了某国的登记门槛、或者不想再管这摊事，
翻回去的路很短：删掉 `checkoutParams` 里那一行，在 Stripe 后台给四个 Product 填上
`tax_code`（test 与 live 各一次）。候选码在 #910 的讨论里查过真实清单：
`txcd_10105001/2`（AI as a Service - Cloud Based，personal / business use）比通用的
`txcd_10103000/1`（SaaS）更贴——订阅卖的不是那个 app（app 免费下载、自带 key 也全功能），
卖的是「模型调用走 Mr Otto 的 key」这项云端 AI 服务。**personal / business 分的是买家类型
不是我们的公司类型**，这一格选错会收错税，要以会计的判断为准。

## 天花板

这条只解决"开得出单"。手验九条剩下的八条（webhook 写库、额度用尽、冷启动重建、中断照样记账、
重投只加一笔、并发各拿一份 hold）仍然一条没跑过——`usage_event` / `subscription` /
`credit_grant` 三张表此刻都是 0 行。清单在 #906。
