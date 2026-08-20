// 新会话屏那句招呼语。
//
// 为什么随机而不是写死一句:那一屏每天要看很多次,一句不变的欢迎词第三次就变成
// 了背景板 —— 眼睛跳过它,它就不再是招呼,只是占位。换着说反而每次都被读一遍。
//
// 为什么是纯函数 + 注入随机数:Math.random() 直接写进组件的话,这份文案就只能靠
// 肉眼刷新去测;而"名字空着的时候会不会渲染出『，今天…』这种断头句"恰恰是最容易
// 写错、也最难碰巧看见的一处。

/** 带名字的说法。{name} 是唯一的占位符 */
const WITH_NAME: readonly string[] = [
  "{name}，今天挖点什么？",
  "{name}，手头这摊活儿交给我一段？",
  "回来了{name}。从哪儿接着干？",
  "{name}，说个方向，我去跑腿。",
  "水已经烧上了，{name}，说吧。",
  "{name}，这次想让我读点什么、改点什么？",
];

/** 没名字时的说法。不是把上面那几句掐掉名字 —— 掐完会剩下"，今天挖点什么？"
    这种断头句,或者语气整个垮掉("回来了。从哪儿接着干？") */
const PLAIN: readonly string[] = [
  "今天挖点什么？",
  "说个方向，我去跑腿。",
  "手头这摊活儿，交给我一段？",
  "想让我读点什么、改点什么？",
  "水已经烧上了，说吧。",
  "从哪儿接着干？",
];

/**
 * 招呼语。
 *
 * @param name 用户名字;空/空白 = 当没有(登录前、或者资料还没拉回来)
 * @param roll 0~1 的随机数。注入而不是内部取,是为了可测
 */
export function pickGreeting(name: string | null | undefined, roll: number): string {
  const trimmed = (name ?? "").trim();
  const pool = trimmed === "" ? PLAIN : WITH_NAME;
  // roll 落在 [0,1) 之外(调用方传了脏值)也得给出一句话,不能算出越界下标
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length)));
  return (pool[i] ?? pool[0]!).replace("{name}", trimmed);
}
