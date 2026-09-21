# ADR-0308：plans 那把 60s 缓存只给展示路径，不给开单路径

- 状态：已接受
- 日期：2026-09-21
- 关联：#1322（承接 #1304 / ADR-0305 的打点结果）、ADR-0203（价目服务端下发）

## 背景

`billingPort.me` 里这一行：

```ts
const [routes, plans] = await Promise.all([routesOf(env), db.get(plansQuery()).then(parsePlanRows)]);
```

`routesOf(env)` 有 isolate 级 60s 缓存（`routesCache`），**同一行里的 `plansQuery()` 没有**。
于是每一发 `/billing/v1/me` 都真打一次 Supabase。

ADR-0305 那把尺子（`x-otto-quota-timing` 的 `me:db` 格）第一次用就量出来（2026-09-21，dev 账号）：

| | Mac（SYD） | VPS（HEL） |
|---|---|---|
| `me:db` 稳态 | 115–353ms | 290–326ms |
| 同一发的 `view`（一整趟 DO 往返） | 8–10ms | 323–367ms |

在 HEL 上它与一趟跨洲 DO 往返同价；**在 SYD 上它比 DO 往返贵一个数量级**。而 `/me` 由
`hostedProbe` 每 60 秒刷一次、账号页与额度那两扇窗全靠它，是条高频路径。冷 isolate 上更贵
（观测到连续四发 830–912ms 然后掉到 ~295ms）。

## 决策

### 1. 加 `plansOf(env)`，与 `routesCache` 同款

isolate 级模块变量、60s、best-effort。边缘上有很多 isolate，所以这不是「全局一份」，
只是「同一个 isolate 里一分钟内不重复查」——`routesCache` 上方那段注释已经把这件事说清楚，
照抄。

依据是**两张表的陈旧风险同级**：`plan` 与 `model_route` 的内容都是维护者手动改一次的配置，
而后者已经接受了这个代价。

### 2. **只给 `/me`。`checkout` 那处故意不改**

这是本条唯一不显然的判断，也是加缓存时最容易顺手做错的那一步（「既然有了 `plansOf`，
这里也换掉吧」）。

判据是**这个调用点拿价目去做什么**：

- **展示路径**（`/me`）：客户端那侧本来就 60 秒刷一次，多陈旧一分钟**没有任何人能据此
  做出不同的动作**。
- **开单路径**（`checkout`）：拿一份最多陈旧 60 秒的价目去开一张 Stripe checkout，
  等于**按旧价收一次钱**。维护者改价那一分钟里点下订阅按钮的人，付的是上一个价。

`webhookHandler` 走自己的 `deps.db`，本来就够不到这一格——但它属于同一侧（开单），
所以即使将来有人把它接进来也该一并拒绝。

`tests/edge/billingQueries.test.ts` 有一条断言钉住 `checkout` 函数体里**仍然是直查、
且不含 `plansOf(`**。

### 3. 不碰 DO 里那份 `planCache`

`Quota.plan()` 有自己的 60s 缓存（实例内存）。它与这一份**在不同的机器上**，命中率与
失效时机都不一样，合成一个缓存只会让两边的陈旧窗口互相污染。

那一份自己的问题（实例被回收后每 60s 一次 139–1163ms 的尖峰）是 #1304 留下的另一个候选
（把它落到 DO storage），两件事分开做。

### 4. 判据落在源码断言上

`worker.ts` 进不了 vitest（一 import 就要 `cloudflare:workers` 的运行时），所以三条断言读
源码：缓存的形状（含 `exp > Date.now()` 那一格——**写反了会让缓存从不命中，而线上唯一的
症状就是这条 issue 本身：一切照常，只是每一发都慢 300ms**）、`/me` 真的换成了 `plansOf`、
`checkout` 没有被顺手改掉。手法同 `tests/edge/quotaTiming.test.ts` 那组、
`tests/runtime/sandbox.test.ts` 的 `freeKib` 接线断言。

## 已知代价

1. **没做 in-flight 去重**：两发并发的 `/me` 落在同一个冷 isolate 上，两边都会 miss 然后
   各打一次 Supabase（`routesOf` 今天也是这样）。观测到的「冷 isolate 连续四发 830–912ms」
   可能正是这个形状。做它要回答「失败的 promise 要不要缓存」，是另一个判断；这条 issue
   说的是「同款缓存」，同款就是同款。
2. **维护者改价后最多一分钟内，`/me` 报的还是旧价**。账号页那几张价目卡因此可能比
   Stripe 那边晚一分钟——但点下去走的是 `checkout`，那条仍然现查，所以**收的钱永远是新价**。
3. 冷 isolate 的第一发仍然是两次真查（缓存治的是稳态，不是冷启动）。
4. ~~**没在线上量过**~~ —— 已部署并复量，见下一节。

## 部署后量到的（2026-09-21，edge 指纹 `5402c6f8920e`）

Mac（SYD）打 `/billing/v1/me`，读 `x-otto-quota-timing` 的 `me:db outer=` 那一格，
同一台机器、同一个 dev 账号、前后相隔十分钟：

| | 部署前（12 发） | 部署后（15 发） |
|---|---|---|
| `me:db` | 113–361ms，中位 **231ms**，**一个 0 都没有** | **11 发是 0**，4 发非零（473 / 338 / 151 / 141） |
| 整发 `total` | 0.156–0.769s | 稳态 **0.044–0.125s** |
| 同一发的 `view`（一整趟 DO 往返） | 7–13ms | 5–11ms（没动，作为对照组） |

非零那 4 发是**不同 isolate 的第一次填充**：第 1–3 发紧接着部署（所有 isolate 刚重建），
第 11 发又碰上一个新的。与已知代价第 3 条一致——**缓存治的是稳态，不是冷启动**。

顺带把 issue 的前提当场印证了一次：部署前 `me:db` 的中位（231ms）比**同一发**里那趟
DO 往返（8–13ms）贵一个数量级，而它挂在一条每 60 秒打一次的路径上。
