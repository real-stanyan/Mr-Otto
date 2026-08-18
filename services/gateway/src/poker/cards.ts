// 一张牌 = 0..51 的整数。rank = c >>> 2（0 是 2、12 是 A），suit = c & 3。
//
// 为什么用整数而不是 {rank, suit} 对象：求值器要枚举 C(7,5)=21 种组合，
// 每手牌做几百次比较；更重要的是整数能原样进 JSON 手牌记录，
// 复盘时一个字节对一张牌，不存在"对象字段改名导致旧记录读不出来"这回事。

/** 牌面顺序与 rank 值一一对应，A 最大 */
export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;
/** 花色只用来判同花，彼此无大小 */
export const SUITS = ["c", "d", "h", "s"] as const;

export const DECK_SIZE = 52;

export const rankOf = (card: number): number => card >>> 2;
export const suitOf = (card: number): number => card & 3;

/** 未洗的一副牌，0..51 顺序排列 */
export function freshDeck(): number[] {
  return Array.from({ length: DECK_SIZE }, (_, i) => i);
}

/** "As" / "Td" 这种两字符写法，只给日志和测试读，引擎内部一律用整数 */
export function cardName(card: number): string {
  return `${RANKS[rankOf(card)]}${SUITS[suitOf(card)]}`;
}

/** cardName 的逆运算 —— 测试里写牌型比写 0..51 好读得多 */
export function parseCard(name: string): number {
  const r = RANKS.indexOf(name[0]?.toUpperCase() as (typeof RANKS)[number]);
  const s = SUITS.indexOf(name[1]?.toLowerCase() as (typeof SUITS)[number]);
  if (r < 0 || s < 0) throw new Error(`不是合法牌名：${name}`);
  return r * 4 + s;
}

export const parseCards = (names: string): number[] => names.trim().split(/\s+/).map(parseCard);
