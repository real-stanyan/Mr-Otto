// 后台任务完成回注（issue #389，dsh completion re-injection 对照）。
//
// 形态：bash 的 run_in_background 起任务（world.execDetached，不绑 turn 信号），
// 这里跟踪存活任务；完成时回调组装根（index.ts），由它落
// background_task_completed 事件并决定回注时机——**以新 turn 回注，永不
// mid-splice**：steer 那条"往跑着的 turn 里 append"的路技术上现成，但 turn
// 中途改投影中段 = prefix cache 全废（ADR-0073 的教训，微压缩为此宁可丢结果）。
// turn 在跑就攒着，收口（completed）后合并成一条注回。
//
// 模型可见的载体是回注 turn 的 user_message（"先落盘再喂模型"由 runTurn 的
// 既有路径满足）；background_task_completed 事件是审计注记，模型不消费。

import type { ExecResult } from "../world/executionWorld.js";
// BackgroundStarter 接口声明在工具层（tools/bash.ts）：工具不 import main 模块
// （分层与 ExecutionWorld 同款方向——main 实现、工具只见接口），这里是实现方
import type { BackgroundOutputSink, BackgroundStarter } from "../tools/bash.js";

export interface BackgroundCompletion {
  id: string;
  cmd: string;
  result: ExecResult;
}

/** 一段后台任务的实时输出（issue #772）。组装根接上它，按会话推给渲染层，
    面板据此把每个任务画成一个真终端而不是一个空盒子。
    与 tool_output 同款边界：碎片永不进日志，完整输出仍随回注那条 user_message 走 */
export interface BackgroundOutput {
  id: string;
  chunk: string;
  stream: "stdout" | "stderr";
}

/** 每个任务在主进程留多长的输出尾巴（字符）。留这一份的理由不是"再存一遍"，
    是**补得回来**：推送只覆盖此刻在场的人，而后台任务的典型形态是一个跑三十
    分钟、十分钟不吭声的构建——重开面板/重载渲染层的人错过那几帧就是永远空白。
    同渲染层 toolOutputByCall 的 4000 字上限，两头对齐 */
const TAIL_CHARS = 4_000;

/** 留尾巴的任务数上限。完成 ≠ 可以立刻扔：结果注回对话之前那一行还画在面板上。
    淘汰只挑已经死掉的那些——活着的任务正在写这份尾巴，砍它等于当场清屏 */
const TAIL_TASKS = 32;

export class BackgroundTasks implements BackgroundStarter {
  private n = 0;
  private liveMap = new Map<string, string>();
  private cb: ((c: BackgroundCompletion) => void) | null = null;
  private startCb: ((s: { id: string; cmd: string }) => void) | null = null;
  private outCb: ((o: BackgroundOutput) => void) | null = null;
  /** taskId ⇒ 输出尾巴。插入序 = 淘汰序（见 TAIL_TASKS） */
  private tails = new Map<string, string>();

  get armed(): boolean {
    return this.cb !== null;
  }

  /** 组装根（index.ts）接线；只允许一个订阅者——回注入口只有一个 */
  onCompletion(cb: (c: BackgroundCompletion) => void): void {
    this.cb = cb;
  }

  /** 起点订阅（issue #452 / ADR-0109）：组装根据此落 background_task_started。
      与 onCompletion 分开而不是塞进同一个回调：起点不是"完成的一种"，
      两者的落盘时机和事件形状都不同。
      **armed 只看 onCompletion**——它守的是"结果有没有人接"，起点没人听
      不影响这个承诺，所以没接 startCb 的装配（subagent）照样该被 bash 拒绝，
      判据不能被这个新回调稀释 */
  onStart(cb: (s: { id: string; cmd: string }) => void): void {
    this.startCb = cb;
  }

  /** 实时输出订阅（issue #772）。与 onStart/onCompletion 分开的理由同它俩：
      三者的时机与形状都不同，而且这一路**不落盘**——它是 UI 增强，
      订不订阅都不影响"结果会注回"这个承诺（armed 因此照旧只看 onCompletion） */
  onOutput(cb: (o: BackgroundOutput) => void): void {
    this.outCb = cb;
  }

  /** 某个任务此刻的输出尾巴。面板重开/渲染层重载后补空白用 */
  tailOf(id: string): string {
    return this.tails.get(id) ?? "";
  }

  /** 存活任务（id + 命令 + 输出尾巴）。这是"谁还真的活着"的唯一判据：事件日志会把上一次
      app 运行留下的 started-without-completed 一起重放出来，但那些进程早没了，
      渲染层分不出来（ADR-0109 的投影表） */
  live(): Array<{ id: string; cmd: string; tail: string }> {
    return [...this.liveMap].map(([id, cmd]) => ({ id, cmd, tail: this.tailOf(id) }));
  }

  private appendTail(id: string, chunk: string): void {
    const merged = (this.tails.get(id) ?? "") + chunk;
    this.tails.set(id, merged.length > TAIL_CHARS ? merged.slice(-TAIL_CHARS) : merged);
    this.pruneTails();
  }

  /** 淘汰跳过还活着的任务：宁可暂时超额，也不清一个正在写字的终端——
      超额的上界是"同时活着的后台任务数"，那个数本来就很小。
      两个时机都要跑：**有新输出**（缓冲又长了）和**有任务死掉**（多出一个
      可淘汰的候选）。只挂前者的话，一批任务全跑完之后没人再写字，
      超额就永远收不回来 */
  private pruneTails(): void {
    while (this.tails.size > TAIL_TASKS) {
      const victim = [...this.tails.keys()].find((k) => !this.liveMap.has(k));
      if (victim === undefined) return;
      this.tails.delete(victim);
    }
  }

  start(cmd: string, run: (onOutput: BackgroundOutputSink) => Promise<ExecResult>): string {
    const id = `bg-${++this.n}`;
    this.liveMap.set(id, cmd);
    // 起点就建一格空尾巴：面板要能区分"这个任务还没吭声"和"还没有这个任务"
    this.tails.set(id, "");
    this.startCb?.({ id, cmd });
    // execDetached 不该 reject（起不来也按 ExecResult 返回，LocalWorld 契约），
    // 这里仍兜一层：万一实现抛了，完成事实不能丢
    run((chunk, stream) => {
      this.appendTail(id, chunk);
      this.outCb?.({ id, chunk, stream });
    })
      .catch(
        (e): ExecResult => ({
          stdout: "",
          stderr: e instanceof Error ? e.message : String(e),
          exitCode: 1,
        })
      )
      .then((result) => {
        this.liveMap.delete(id);
        this.pruneTails();
        this.cb?.({ id, cmd, result });
      });
    return id;
  }
}

/** 回注 turn 的 user_message 文案。中间截断同 bash 的三层截断精神：
    模型预算有界，日志侧本来就只有 HeadTail 1MB 内的事实 */
const MAX_REPORT_CHARS = 8_000;

export function formatCompletion(c: BackgroundCompletion): string {
  const body = [
    c.result.stdout ? `stdout:\n${c.result.stdout}` : "",
    c.result.stderr ? `stderr:\n${c.result.stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const clipped =
    body.length <= MAX_REPORT_CHARS
      ? body
      : `${body.slice(0, MAX_REPORT_CHARS / 2)}\n…[中间省略，原始 ${body.length} 字符]…\n${body.slice(-MAX_REPORT_CHARS / 2)}`;
  return `[后台任务 ${c.id} 完成] ${c.cmd}\nexit code: ${c.result.exitCode}\n${clipped}`.trimEnd();
}
