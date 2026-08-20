// key 的遮罩形态 —— 「配没配」之外，渲染层唯一能知道的关于 key 的事。
//
// 为什么要有它：设置页那一行上写 `DEEPSEEK_API_KEY` 只回答"这一格是干什么的"，
// 回答不了用户真正会问的那句——**贴进去的是哪一把**。多账号、轮换过、
// 或者怀疑贴串了家的时候，前八位加后四位一眼就能对上。
//
// 硬约束不变：**遮罩在主进程算，key 本体永不过桥**。过桥的是一个推不回原文的
// 派生物，不是秘密本身（同 keyStatus 的老规矩：桥上只走结论，不走凭据）。
//
// 露多少：前 8 + 后 4 是这一行的通行写法（各家控制台、Stripe、OpenAI 都这么显示）。
// 中间固定五颗星、不按长度伸缩 —— 星星的个数本身也是信息，没必要白送。

/** 遮罩。空 key 返回空串（"没配"这件事本来就该用空串表示，不是一串星） */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k === "") return "";
  const stars = "*****";
  // 太短的 key 少露一点：一把 10 位的 key 露前 8 等于没遮
  if (k.length >= 16) return `${k.slice(0, 8)}${stars}${k.slice(-4)}`;
  if (k.length >= 8) return `${k.slice(0, 3)}${stars}${k.slice(-2)}`;
  return stars;
}
