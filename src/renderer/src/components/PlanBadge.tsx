// 档位徽章：Free / Lite / Pro / Max 各一个颜色。
//
// **一个组件两处用**（侧栏底部那一行 + 账号页订阅卡的档位行）。抽出来的理由
// 不是省几行 JSX，是「Lite 是什么颜色」这个答案只能有一份 —— 两处各写一张
// 色表的话，改一处忘一处的结果是同一个账号在两块屏幕上是两个档，而这种不一致
// 不会报错、只会让人以为自己看错了（同 ADR-0209「同一扇窗两个界面不能给出两个数」）。
import { cn } from "@/lib/utils.js";
import { PLAN_BADGE_LABEL, type PlanBadgeId } from "../lib/billingView.js";

/** 维护者定的四色。四个都取现成的语义色 token —— 它们两套主题都已经调过，
    自造四组十六进制等于把亮/暗两版对比度重新赌一次。
    代价说清楚：`--warn` 在本仓别处的意思是「出事了」（扣款失败横幅、额度告警条），
    Max 借它的橙色是**借形不借义**。哪天要把警告橙调得更刺眼，先想起这里还挂着
    一个最贵的档 —— 那一天就是把 Max 拆出自己那格颜色的时候。 */
const TONE: Record<PlanBadgeId, string> = {
  free: "bg-muted-foreground/12 text-muted-foreground",
  lite: "bg-ok/18 text-ok",
  pro: "bg-brand/18 text-brand",
  max: "bg-warn/18 text-warn",
};

/** `sm` = 侧栏那一行（挤在名字和齿轮之间，只有 24px 高）；
    `md` = 账号页订阅卡的档位行（ADR-0239 定稿的那枚）。
    两处几何不同是应该的，颜色和字面必须相同 —— 后两样走上面的表。 */
export function PlanBadge({
  id,
  size = "sm",
  className,
}: {
  id: PlanBadgeId;
  size?: "sm" | "md";
  className?: string | undefined;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-[6px] font-[650] leading-none whitespace-nowrap",
        size === "sm" ? "px-[5px] py-[3px] text-[10px]" : "rounded-[7px] px-[8px] py-[4px] text-[11.5px]",
        TONE[id],
        className,
      )}
    >
      {PLAN_BADGE_LABEL[id]}
    </span>
  );
}
