// 德州牌桌（game 档）。目前只有桌面本身：引擎（#48 第 1 层）已就位，
// 发牌/结算/传输还没接上，所以这里不摆任何假数据——空桌是诚实的，
// 假筹码不是。牌背用 Mr Otto 的 logo。

import ottoLogo from "../assets/otto.png";

/** 牌背：正面朝下的牌。尺寸由外面给，内部按比例缩 */
export function CardBack({ className = "" }: { className?: string }) {
  return (
    <div
      className={`relative aspect-[5/7] rounded-[7px] border border-border bg-gradient-to-b from-card to-[color-mix(in_srgb,var(--card)_86%,var(--foreground))] shadow-sm overflow-hidden ${className}`}
      aria-hidden
    >
      {/* 双层内描边模拟卡纸压印，比单纯一条边框更像实物 */}
      <div className="absolute inset-[3px] rounded-[4px] border border-border/50" />
      <img
        src={ottoLogo}
        alt=""
        className="absolute inset-0 m-auto w-[56%] opacity-90 select-none"
        draggable={false}
      />
    </div>
  );
}

const SEATS = 6;

export function PokerTable() {
  return (
    <section className="flex-1 min-h-0 overflow-y-auto scrollbar-stable px-5 py-4">
      <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-6">
        {/* 桌面：径向渐变的毡面。用色板 token 而不是写死绿色，浅色/深色都成立 */}
        <div className="relative aspect-[16/10] w-full rounded-[999px/40%] border border-border/60 bg-[radial-gradient(120%_100%_at_50%_0%,color-mix(in_srgb,var(--brand)_14%,var(--card)),var(--card))] shadow-inner">
          {/* 六个空座位沿桌边分布 */}
          {Array.from({ length: SEATS }, (_, i) => {
            const angle = (i / SEATS) * Math.PI * 2 + Math.PI / 2;
            const left = 50 + Math.cos(angle) * 42;
            const top = 50 + Math.sin(angle) * 40;
            return (
              <div
                key={i}
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-border/70 px-3 py-1 text-[11px] text-muted-foreground"
                style={{ left: `${left}%`, top: `${top}%` }}
              >
                空位
              </div>
            );
          })}

          {/* 桌心：五张公共牌的位置，全部背面朝上 */}
          <div className="absolute inset-0 flex items-center justify-center gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <CardBack key={i} className="w-[11%] min-w-[34px]" />
            ))}
          </div>
        </div>

        <p className="text-center text-xs leading-relaxed text-muted-foreground">
          牌桌还没接通。
          <br />
          洗牌、发牌、下注状态机和结算已经写好并测过（issue #48 第 1 层），
          还差落库、扣额度与实时传输。
        </p>
      </div>
    </section>
  );
}
