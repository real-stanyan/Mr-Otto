// 主题桶（TOPIC 档）的纯逻辑：slug 校验、种子表、路径、索引渲染。
// 放 shared：memory 工具（主进程）、设置页（渲染层）、投影（deriveMessages）三处都要认同一套。
// 不 import node:*（手机端/渲染层要跑这一层）。

/** ASCII kebab：小写字母开头，≤ 24 字符。ASCII 而不是随便什么名字，是因为它要当文件名，
    且模型建桶时「work」「工作」「Work」三个桶正是要防的东西——统一小写 ASCII 少一条歧路 */
export const TOPIC_SLUG_RE = /^[a-z][a-z0-9-]{0,23}$/;

export function isTopicSlug(v: unknown): v is string {
  return typeof v === "string" && TOPIC_SLUG_RE.test(v);
}

/** 种子桶：slug → 显示名。顺序即索引里的顺序 */
export const SEED_TOPICS: Readonly<Record<string, string>> = {
  work: "工作",
  hobbies: "爱好",
  life: "生活",
  learning: "学习",
};

/** 桶数封顶。满了新建报错、逼合并——同 MEMORY_LIMITS 的「紧上限逼出策展」 */
export const MAX_TOPICS = 8;

export const TOPICS_DIR = "memories/topics";

function assertSlug(slug: string): void {
  if (!isTopicSlug(slug)) throw new Error(`主题 slug 非法：「${slug}」（小写字母开头，只含 a-z 0-9 -，≤ 24 字符）`);
}

export function topicRelPath(slug: string): string {
  assertSlug(slug);
  return `${TOPICS_DIR}/${slug}.md`;
}

/** 用户改的显示名落这个文件（一行文本）。目录自描述、不建中心索引——同项目档的 root.txt 理由 */
export function topicLabelRelPath(slug: string): string {
  assertSlug(slug);
  return `${TOPICS_DIR}/${slug}.label`;
}

/** 目录里的文件名 → 桶 slug 列表：只认 `<slug>.md`，非法 slug 的文件当不存在 */
export function slugsFromFileNames(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    if (!n.endsWith(".md")) continue;
    const slug = n.slice(0, -3);
    if (isTopicSlug(slug)) out.add(slug);
  }
  return [...out].sort();
}

/** 种子 ∪ 磁盘：种子永远在索引里（哪怕还没写过一条），模型才有得选 */
export function withSeedTopics(slugs: string[]): string[] {
  const seeds = Object.keys(SEED_TOPICS);
  const rest = [...new Set(slugs)].filter((s) => !(s in SEED_TOPICS)).sort();
  return [...seeds, ...rest];
}

export interface TopicIndexEntry {
  slug: string;
  label: string;
  entries: number;
}

/** 注进系统提示与工具报错的那份索引：一行一桶 */
export function renderTopicIndex(index: TopicIndexEntry[]): string {
  return index.map((t) => `${t.slug}（${t.label}）· ${t.entries} 条`).join("\n");
}

/** 显示名优先级：label 文件 > 种子表 > slug 本身 */
export function topicLabel(slug: string, labelFile: string | null): string {
  const custom = labelFile?.trim();
  if (custom) return custom;
  return SEED_TOPICS[slug] ?? slug;
}
