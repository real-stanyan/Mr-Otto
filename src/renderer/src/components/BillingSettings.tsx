// 「模型配置」页顶部的订阅区（ADR-0176/issue #696，Task 11）：托管额度是一种
// 可选的付费方式,不是必需项 —— 没订阅时这里只是三张价目卡 + 一句"自带 key 免费
// 档能力全开",不挡住下面 ModelProviderSettings 那条主线。
//
// 版式跟 ModelProviderSettings 同一套语言:圆角 14px 卡片、发丝线分组、
// 13.5px 行标题/11.5px 灰字副文案——这一节看起来该像它的邻居,不是另一个组件库。
// 没有入场动画:这是设置页里偶尔看一眼的区块,不是天天盯着的仪表盘,
// 唯一值得过渡的是进度条宽度变化(状态指示,不是装饰)。

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { addonLine, countdown, PLAN_CARDS, windowPercent } from "../lib/billingView.js";
import { fmtCredit } from "../../../shared/billing.js";
import { useNow } from "../lib/useNow.js";
import { useChat } from "../store.js";

/** 一张价目卡：档名 + 价格 + 一句话 + 订阅按钮 */
function PlanCard({ id, name, priceUsd, blurb, pending, disabled, onSubscribe }: {
  id: string;
  name: string;
  priceUsd: number;
  blurb: string;
  /** 这张卡自己的下单在飞——按钮换文案 */
  pending: boolean;
  /** 有任意一张卡（或加购/管理）在飞——全部按钮跟着禁掉,防重复下单开出两个 Stripe session */
  disabled: boolean;
  onSubscribe: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[12px] border border-border bg-card p-3">
      <div className="text-[13.5px] font-[550]">{name}</div>
      <div className="flex items-baseline gap-1">
        <span className="text-[17px] font-[550] tabular-nums">${priceUsd}</span>
        <span className="text-[11px] text-muted-foreground">/月</span>
      </div>
      <p className="text-[11.5px] leading-[1.5] text-muted-foreground">{blurb}</p>
      <Button size="sm" className="mt-1" disabled={disabled} onClick={onSubscribe} data-testid={`plan-subscribe-${id}`}>
        {pending ? "打开中…" : "订阅"}
      </Button>
    </div>
  );
}

/** 一条额度窗口：标题 + 用量/倒计时 + 进度条 */
function WindowRow({ label, w, now }: {
  label: string;
  w: { usedMicro: number; limitMicro: number; resetAt: number };
  now: number;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-[11.5px]">
        <span className="text-foreground/80">{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {fmtCredit(w.usedMicro)} / {fmtCredit(w.limitMicro)} · {countdown(w.resetAt, now)}
        </span>
      </div>
      <div className="h-[5px] overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground/70 transition-[width] duration-300 ease-[var(--ease-strong)]"
          style={{ width: `${windowPercent(w)}%` }}
        />
      </div>
    </div>
  );
}

export function BillingSettings() {
  const billing = useChat((s) => s.billing);
  const loadBilling = useChat((s) => s.loadBilling);
  const checkout = useChat((s) => s.billingCheckout);
  const portal = useChat((s) => s.billingPortal);

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

  if (!me || me.status === "none" || me.plan === null) {
    return (
      <section className="flex flex-col gap-[6px]">
        <h2 className="px-1 text-[11px] tracking-[0.06em] text-muted-foreground uppercase">订阅</h2>
        <p className="px-1 text-[11.5px] leading-[1.5] text-muted-foreground">
          订阅后模型调用走 Mr Otto 的 key，不用自己配。自带 key 的免费档能力全开。
        </p>
        <div className="grid grid-cols-3 gap-2">
          {PLAN_CARDS.map((c) => (
            <PlanCard
              key={c.id}
              {...c}
              pending={pending === `plan:${c.id}`}
              disabled={pending !== null}
              onSubscribe={() => run(`plan:${c.id}`, () => checkout({ planId: c.id }))}
            />
          ))}
        </div>
      </section>
    );
  }

  const planName = PLAN_CARDS.find((c) => c.id === me.plan)?.name ?? me.plan;
  const upgrades = PLAN_CARDS.filter(
    (c) => c.priceUsd > (PLAN_CARDS.find((x) => x.id === me.plan)?.priceUsd ?? 0)
  );
  const addonText = addonLine(me.addon, now);

  return (
    <section className="flex flex-col gap-[10px]">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
          订阅 · {planName}
          {me.status === "past_due" && <span className="text-warn"> · 扣款失败</span>}
        </h2>
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          disabled={pending !== null}
          onClick={() => run("portal", () => portal())}
        >
          {pending === "portal" ? "打开中…" : "管理"}
        </Button>
      </div>

      <div className="flex flex-col gap-[10px] rounded-[14px] border border-border bg-card p-3">
        {me.windows && (
          <>
            <WindowRow label="5 小时窗" w={me.windows.h5} now={now} />
            <WindowRow label="本周" w={me.windows.week} now={now} />
          </>
        )}

        {billing?.exhausted && (
          <p className="text-[11.5px] leading-[1.5] text-warn">
            额度已用完，{countdown(billing.exhausted.resetAt, now)}；配了自己的 key 会自动切过去。
          </p>
        )}

        <div className="flex items-center justify-between gap-2 text-[11.5px]">
          <span className="text-muted-foreground">{addonText ?? "没有加购余额"}</span>
          <Button
            size="xs"
            variant="outline"
            disabled={pending !== null}
            onClick={() => run("addon", () => checkout({ addon: true, quantity: 1 }))}
          >
            {pending === "addon" ? "打开中…" : "加购 $10"}
          </Button>
        </div>
      </div>

      {upgrades.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1">
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
              {pending === `plan:${c.id}` ? "打开中…" : `升到 ${c.name}（在管理页切换）`}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
