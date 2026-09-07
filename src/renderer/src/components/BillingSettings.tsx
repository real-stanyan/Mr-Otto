// 账号页的订阅区（ADR-0176/issue #696 Task 11；issue #909 从「模型配置」页搬来；
// 版式由 #1022 定稿）：托管额度是一种可选的付费方式,不是必需项 —— 没订阅时这里是
// 一张 Free 卡 + 三张价目卡。
//
// 为什么住在账号页而不是模型配置页:订阅是**账号**的属性,不是某个厂商 key 的属性。
// 摆在 keys 页会让人以为它是某一家 key 的开关,而它恰恰是"不用自己配 key"的那条路;
// 额度也是全账号的,和账号页其余东西(名字/邮箱/会话热力图)同类。
//
// **两扇窗报百分比不报 credit**（#1022）：大字是「还剩百分之几」，条按**剩余**填充。
// 三条判据都不是审美：
//   · 报剩余 —— 用户问这个数就是想知道「我还能干多久」，`0.1 / 311.5` 要人做减法；
//   · 条按剩余填 —— 原来那条填了 0.03%，在屏幕上和「组件坏了」长得一模一样，
//     反过来画之后闲着的时候它是满的；
//   · 充足时**保持中性灰**不上品牌蓝 —— 一根横贯整卡的蓝条会把「一切正常」画得比
//     「快没了」还响。颜色留给 quotaTone 那两档（阈值与上下文浮层共用，ADR-0209）。
// 精确的 credit 进 `title`：百分比是给人扫一眼的，对账的人还得看得到数。
//
// 版式跟 ModelProviderSettings 同一套语言:圆角 14px 卡片、发丝线分组、
// 13.5px 行标题/11.5px 灰字副文案——这一节看起来该像它的邻居,不是另一个组件库。
// 没有入场动画:这是设置页里偶尔看一眼的区块,不是天天盯着的仪表盘,
// 唯一值得过渡的是进度条宽度变化(状态指示,不是装饰)。

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils.js";
import {
  addonLine, countdown, fmtRemainingPercent, liveWindow, periodLine, planBadge, planCards,
  planCardsOrNull, quotaTone, remainingPercent, upgradeCards, usageTitle, windowPercent,
} from "../lib/billingView.js";
import { PlanBadge } from "./PlanBadge.js";
import { useNow } from "../lib/useNow.js";
import { useChat } from "../store.js";

/** 条的颜色。**充足时是中性灰**，不是品牌蓝：颜色在这张卡里只用来说「出事了」 */
const TONE_BAR = {
  brand: "bg-foreground/40",
  warn: "bg-warn",
  deny: "bg-deny",
} as const;

/** 一张价目卡：档名 + 价格 + 一句话 + 订阅按钮。
    `current` = 这是用户此刻所在的档（今天只有 Free 用得上）——它不是一个可买的东西，
    所以虚线边框、底色沉一档、**不给主行动按钮**：画成第四张可买的卡会让人去点它 */
function PlanCard({ id, name, priceUsd, blurb, tag, caps, current, action, pending, disabled, onSubscribe }: {
  id: string;
  name: string;
  priceUsd: number;
  blurb: string;
  /** 档名后面那枚小标（「当前」/「多数人选这个」）。没有就不画 */
  tag?: string;
  /** 能力行。空数组 = 整行不画（服务端没下发能力时不猜） */
  caps: string[];
  current?: boolean;
  /** 当前档那颗次要按钮的文案。current 为真时代替「订阅」 */
  action?: { label: string; onClick: () => void };
  /** 这张卡自己的下单在飞——按钮换文案 */
  pending: boolean;
  /** 有任意一张卡（或加购/管理）在飞——全部按钮跟着禁掉,防重复下单开出两个 Stripe session */
  disabled: boolean;
  onSubscribe: () => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-[12px] border p-3",
        current ? "border-dashed border-border bg-transparent" : "border-border bg-card",
        tag && !current && "border-primary/55",
      )}
    >
      <div className="flex items-center gap-[6px] text-[13.5px] font-[550]">
        {name}
        {tag && (
          <span
            className={cn(
              "rounded-[5px] px-[6px] py-[2px] text-[10.5px] font-[600]",
              current ? "bg-accent text-muted-foreground" : "bg-primary/16 text-primary",
            )}
          >
            {tag}
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-[17px] font-[550] tabular-nums">${priceUsd}</span>
        <span className="text-[11px] text-muted-foreground">/月</span>
      </div>
      <p className="text-[11.5px] leading-[1.5] text-muted-foreground">{blurb}</p>
      {caps.length > 0 && (
        <div className="flex flex-wrap gap-[5px]">
          {caps.map((c) => (
            <span key={c} className="rounded-[5px] bg-accent px-[6px] py-[2px] text-[10.5px] text-foreground/80">
              {c}
            </span>
          ))}
        </div>
      )}
      {/* 能力行与按钮靠 mt-auto 压到底：四张卡的一句话长短不一，不压的话下半截错位 */}
      <div className="mt-auto pt-1">
        {current && action ? (
          <Button size="sm" variant="ghost" className="w-full text-muted-foreground" onClick={action.onClick}>
            {action.label}
          </Button>
        ) : (
          <Button size="sm" className="w-full" disabled={disabled} onClick={onSubscribe} data-testid={`plan-subscribe-${id}`}>
            {pending ? "打开中…" : "订阅"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** 一扇额度窗：标签 + 倒计时 / 大字剩余百分比 / 一根按剩余填充的条。
    过了 resetAt 的窗按清零画（liveWindow）——快照来自上一次网关响应，而窗口到点会
    自己清零；开着这一页坐过一扇窗的人会看着一个早就不成立的占用。与浮层里那段
    （components/PlanQuotaSection.tsx）共用同一个换算，两处报同一个窗不能给出两个数 */
function WindowRow({ label, w: raw, now }: {
  label: string;
  w: { usedMicro: number; limitMicro: number; resetAt: number };
  now: number;
}) {
  const w = liveWindow(raw, now);
  // 色档按**已用**判（与浮层、上下文环共用的那组阈值），画出来的却是剩余：
  // 同一件事的两个说法，判据只能有一份
  const tone = TONE_BAR[quotaTone(windowPercent(w))];
  return (
    <div className="space-y-[6px]" title={usageTitle(w)}>
      <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
        <span className="text-foreground/80">{label}</span>
        <span className="text-muted-foreground tabular-nums">{countdown(w.resetAt, now)}</span>
      </div>
      <div className="flex items-baseline gap-[5px]">
        <span className="text-[28px] font-[600] leading-[1.1] tracking-[-0.02em] tabular-nums">
          {fmtRemainingPercent(w)}
        </span>
        <span className="text-[11.5px] text-muted-foreground">可用</span>
      </div>
      <div className="h-[6px] overflow-hidden rounded-full bg-foreground/10">
        <div
          className={cn("h-full rounded-full transition-[width] duration-300 ease-[var(--ease-strong)]", tone)}
          style={{ width: `${remainingPercent(w)}%` }}
        />
      </div>
    </div>
  );
}

/** 出事时那条横幅：一句话 + 一个能点的出口。
    原来这两件事各是一句灰字（「· 扣款失败」缀在 11px 小标题后面、额度用完是一行小字），
    一个会让人停止付费的事故写得比「加购 $10」还轻，而且没有任何一条可走的路 */
function Strip({ tone, title, note, action }: {
  tone: "warn" | "deny";
  title: string;
  note: string;
  action?: { label: string; onClick: () => void; disabled?: boolean };
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-[10px] rounded-[10px] px-[11px] py-[9px] text-[12px] leading-[1.5]",
        tone === "warn" ? "bg-warn/12 text-warn" : "bg-deny/12 text-deny",
      )}
    >
      <b className="font-[650]">{title}</b>
      <span className="text-muted-foreground">{note}</span>
      {action && (
        <Button
          size="xs"
          variant="outline"
          className="ml-auto border-current bg-transparent text-current hover:bg-current/10"
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}

export function BillingSettings() {
  const billing = useChat((s) => s.billing);
  const loadBilling = useChat((s) => s.loadBilling);
  const checkout = useChat((s) => s.billingCheckout);
  const portal = useChat((s) => s.billingPortal);
  const openSettings = useChat((s) => s.openSettings);

  // 开页取一次最新的(refresh:true 先打 /me)——同 ModelProviderSettings 开页
  // 拉 refreshProviderStats 一致:这一页是"改配置"的地方,不做轮询
  useEffect(() => {
    void loadBilling(true);
  }, [loadBilling]);

  // 倒计时要真的走:60s 跳一次就够(分钟粒度的文案),同 Timeline.tsx 用同一颗表
  // (lib/useNow.ts)——裸 Date.now() 只在挂载那一刻取一次,数字会钉死不动
  const now = useNow(60_000);
  const me = billing?.me ?? null;

  // 同一时刻只放一个下单在飞:按钮防连点(fix round 1)——双击/手滑两下会打开
  // 两个 Stripe checkout session。key 记的是"哪一个"在飞,不只用来判断要不要
  // 禁用,也用来只给那颗按钮换文案，其它按钮照样显示原文案（只是也被禁用）
  const [pending, setPending] = useState<string | null>(null);
  const run = (key: string, fn: () => Promise<void>) => {
    if (pending) return;
    setPending(key);
    void fn().finally(() => setPending(null));
  };

  // #865：canceled 也算「没有订阅」——退订过的人落在有订阅分支会看不到任何订阅卡片
  // （升档按钮都走 Portal 了，而他没有可管理的活跃订阅）。网关那侧 canceled→checkout
  // 是放行的（ADR-0203 决定 18：「退订过又想回来」本来就该重开一张），所以这里
  // 直接给他三张价目卡，等于应用内的重新订阅入口
  // 判据与侧栏那枚徽章**共用一份** planBadge()：null = 还没查到，"free" = 确实没订阅。
  // 这一页两者都画价目卡（骨架 vs 真价目），侧栏那边则必须分开——不知道时一格都不画
  // `me.plan === null` 这一条对 planBadge 是多余的（它已经算进 "free" 里了），
  // 留着是给 tsc 看的：下面 upgradeCards 要的是 PlanId 不是 PlanId | null
  if (me === null || planBadge(me) === "free" || me.plan === null) {
    // 价目是服务端下发的（plan 表是事实，改价不发版）。me 还没回来/里面没有价目时
    // 先画骨架：名字照给、价格留空、按钮禁用——不拿一个猜的数贴订阅按钮（ADR-0203
    // 偏差 (a)：以前价格抄死在前端，改价那天卡片和 Stripe 结账页对不上）
    const cards = planCardsOrNull(me) ?? [];
    const capsOf = (id: string) =>
      me?.plans.find((p) => p.id === id)?.capabilities.image ? ["图像"] : [];
    return (
      <section className="flex flex-col gap-[6px]">
        <h2 className="px-1 text-[11px] tracking-[0.06em] text-muted-foreground uppercase">订阅</h2>
        <p className="px-1 text-[11.5px] leading-[1.5] text-muted-foreground">
          订阅后模型调用走 Mr Otto 的 key，不用自己配。
        </p>
        <div className="grid grid-cols-4 gap-2">
          {/* Free 不是服务端 plan 表里的一行，是「没有订阅」这个状态本身的名字。
              价格 $0 由定义得出，不是抄来的数，所以它不受「价目由服务端下发」那条约束 */}
          <PlanCard
            id="free"
            name="Free"
            tag="当前"
            priceUsd={0}
            blurb="自己配模型 key，账单在厂商那边"
            caps={[]}
            current
            action={{ label: "去配 key", onClick: () => void openSettings("keys") }}
            pending={false}
            disabled={pending !== null}
            onSubscribe={() => undefined}
          />
          {cards.map((c) => (
            <PlanCard
              key={c.id}
              {...c}
              caps={capsOf(c.id)}
              pending={pending === `plan:${c.id}`}
              disabled={pending !== null}
              onSubscribe={() => run(`plan:${c.id}`, () => checkout({ planId: c.id }))}
            />
          ))}
        </div>
        <p className="px-1 text-[11px] leading-[1.5] text-muted-foreground">
          价目由服务端下发，改价不用发版；查不到价的档位整张不画。
        </p>
      </section>
    );
  }

  const cards = planCards(me.plans);
  const current = cards.find((c) => c.id === me.plan);
  const upgrades = upgradeCards(me.plans, me.plan);
  const addonText = addonLine(me.addon, now);
  const period = periodLine(me);

  return (
    <section className="flex flex-col gap-[10px]">
      <h2 className="px-1 text-[11px] tracking-[0.06em] text-muted-foreground uppercase">订阅</h2>

      <div className="flex flex-col gap-[14px] rounded-[14px] border border-border bg-card p-4">
        {/* 档位那一行：档名 + 价格 + 下次扣款。periodEnd 一直在 BillingMe 里，
            这一页从来没画过它——而「下一次什么时候扣钱」是账号页的前三个问题之一 */}
        <div className="flex flex-wrap items-center gap-[10px]">
          {/* 每档一个颜色（与侧栏那枚同一张色表）。原来这里是「past_due 橙 / 其余蓝」，
              而 Max 本身就是橙的——两套含义压在同一个颜色上就都说不清了。
              「扣款失败」由紧接着的那条 warn 横幅说，它带得动一颗按钮，一枚徽章带不动 */}
          <PlanBadge id={me.plan} size="md" />
          <span className="text-[12px] text-muted-foreground tabular-nums">
            {current ? `$${current.priceUsd} / 月` : null}
            {current && period ? " · " : null}
            {period}
          </span>
          <Button
            size="xs"
            variant="outline"
            className="ml-auto"
            disabled={pending !== null}
            onClick={() => run("portal", () => portal())}
          >
            {pending === "portal" ? "打开中…" : "管理订阅"}
          </Button>
        </div>

        {me.status === "past_due" && (
          <Strip
            tone="warn"
            title="扣款失败"
            note="补上之前额度照常用，Stripe 重试失败后订阅会暂停。"
            action={{
              label: pending === "portal" ? "打开中…" : "更新支付方式",
              disabled: pending !== null,
              onClick: () => run("portal", () => portal()),
            }}
          />
        )}

        {billing?.exhausted && (
          <Strip
            tone="deny"
            title="额度已用完"
            note={`${countdown(billing.exhausted.resetAt, now)}；配了自己的 key 会自动切过去。`}
            action={{ label: "去配 key", onClick: () => void openSettings("keys") }}
          />
        )}

        {me.windows && (
          <div className="grid grid-cols-2 gap-[22px]">
            <WindowRow label="5 小时窗" w={me.windows.h5} now={now} />
            <div className="border-l border-border pl-[22px]">
              <WindowRow label="本周" w={me.windows.week} now={now} />
            </div>
          </div>
        )}

        <div className="h-px bg-border" />

        {/* 「没有加购余额」那句否定式换成一行有值的账：这张卡上其余全是数，
            只有这一格在讲「没有」 */}
        <div className="flex items-center gap-2 text-[12px]">
          <span className="text-muted-foreground">加购余额</span>
          <span className="tabular-nums">{addonText ?? "0 credit"}</span>
          <Button
            size="xs"
            variant="outline"
            className="ml-auto"
            disabled={pending !== null}
            onClick={() => run("addon", () => checkout({ addon: true, quantity: 1 }))}
          >
            {pending === "addon" ? "打开中…" : "加购 $10"}
          </Button>
        </div>

        {upgrades.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
            {upgrades.map((c) => (
              <Button
                key={c.id}
                size="xs"
                variant="outline"
                disabled={pending !== null}
                // 升档走 Customer Portal，**不是**再开一张 Checkout（C2）：后者会在
                // Stripe 那边长出第二条订阅、两笔一起扣款。Portal 在同一条订阅上换
                // price 并按比例结算，是 Stripe 给「换档」准备的那扇门。
                // 按钮 key 仍然按档位记（哪一颗在飞就换哪一颗的文案），落到的动作是同一个
                // portal —— 边缘那侧也会把「已有订阅还来 checkout」拒成 409。
                onClick={() => run(`plan:${c.id}`, () => portal())}
              >
                {pending === `plan:${c.id}` ? "打开中…" : `升到 ${c.name}（$${c.priceUsd} / 月）`}
              </Button>
            ))}
            <span>换档在管理页完成，按比例结算</span>
          </div>
        )}
      </div>
    </section>
  );
}
