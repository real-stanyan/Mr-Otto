// HeadTail 缓冲 —— exec 输出三层截断的第一层：内存有界（issue #343，
// 借鉴 codex head_tail_buffer.rs）。
//
// 一条命令可能吐几百 MB。头尾各半、中间丢弃计数：头 = 启动报错，尾 = 最终结果，
// 中间的进度刷屏最没用。进程照常读到 EOF（丢弃发生在缓冲层，不是停止消费——
// 停读会让管道 back-pressure 卡死子进程）。
//
// 单位是字符（JS string 的 code unit 已经由 setEncoding("utf8") 保证不切半个
// 多字节序列；surrogate pair 的边界由 push 里的收尾修正保住）。

export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private omitted = 0;
  private readonly half: number;

  /** @param cap 总字符上限（头尾各半） */
  constructor(cap: number) {
    this.half = Math.max(1, Math.floor(cap / 2));
  }

  push(chunk: string): void {
    if (chunk.length === 0) return;
    // 先填头
    if (this.head.length < this.half) {
      const take = Math.min(this.half - this.head.length, chunk.length);
      this.head += chunk.slice(0, take);
      chunk = chunk.slice(take);
      if (chunk.length === 0) return;
    }
    // 其余进尾巴；尾巴超限就从前面丢（丢的都计数）
    this.tail += chunk;
    if (this.tail.length > this.half) {
      const drop = this.tail.length - this.half;
      this.tail = this.tail.slice(drop);
      this.omitted += drop;
      // 别从 surrogate pair 中间开场：低位起头就再丢一个字符
      const first = this.tail.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) {
        this.tail = this.tail.slice(1);
        this.omitted += 1;
      }
    }
  }

  /** 丢过多少字符（0 = 完整） */
  get omittedChars(): number {
    return this.omitted;
  }

  /** 拼回文本；丢过中段就插标记 */
  text(): string {
    if (this.omitted === 0) return this.head + this.tail;
    return `${this.head}\n…[中间省略 ${this.omitted} 字符]…\n${this.tail}`;
  }
}
