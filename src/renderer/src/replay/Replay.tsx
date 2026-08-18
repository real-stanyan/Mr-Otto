// 富回放视图：画布 + step 列表 + 事件 payload + 函数轨迹。
// 回放"系统里发生了什么"——不是切聊天框，是重演每条事件穿过哪些组件、数据怎么流。
// 全部只读：主进程和 agent 对回放毫不知情（纯渲染层投影）。

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../store.js";
import { toStep, hl, type ReplayStep } from "./steps.js";
import { Canvas } from "./Canvas.js";
import { Button } from "@/components/ui/button.js";

/* 面板小标题统一:小字 + 加字重 + 微加字距(小字号要正字距才清楚) */
const PANEL_H3 = "text-[11px] text-muted-foreground font-semibold tracking-[0.05em] mb-2 tabular-nums";
/* 轨迹链入场动画(pop 定义在 app.css;减少动效时停摆直接可见) */
const POP_ANIM = "opacity-0 animate-[pop_0.3s_ease-out_forwards] motion-reduce:animate-none motion-reduce:opacity-100";
const CHEV = `self-center text-sm ${POP_ANIM}`;
/* 函数间流动的数据卡(虚线);链条端点卡(输入/输出)实线边框另加 */
const DAT = `hl self-center font-mono text-[10.5px] leading-[1.55] text-foreground bg-muted border border-dashed border-border rounded-lg px-[10px] py-[7px] max-w-[270px] whitespace-pre-wrap break-all ${POP_ANIM}`;
const DAT_CAP = `${DAT} border-solid border-ring bg-card`;
const CAP_LABEL = "block text-[9px] font-semibold tracking-[0.12em] text-brand mb-1";
/* 调用链 = 单行流水线:一律从左往右读,长了在面板内横向滚(不是窗口滚);窄窗折行 */
const CHAIN =
  "flex flex-nowrap items-stretch gap-2 overflow-x-auto pb-2 [&>*]:shrink-0 max-[980px]:flex-wrap max-[980px]:overflow-x-visible max-[980px]:gap-y-[10px]";

/** token 数组 → 着色 span（steps.ts 的 hl 保持纯数据，DOM 在这拼）。
    导出：聊天区工具详情面板复用同一高亮器——一处逻辑，两处消费。
    token 类的配色作用域挂在容器的 .hl 上（app.css） */
export function Hl({ src }: { src: string }) {
  return (
    <>
      {hl(src).map((t, i) =>
        t.cls ? (
          <i key={i} className={t.cls}>
            {t.text}
          </i>
        ) : (
          t.text
        )
      )}
    </>
  );
}

/** payload 面板用：长字段截断后再序列化，事件是看结构不是读全文 */
function displayEvent(ev: ReplayStep["ev"]): string {
  const clipped = JSON.parse(JSON.stringify(ev)) as Record<string, unknown>;
  for (const k of ["content", "output"] as const) {
    const v = clipped[k];
    if (typeof v === "string" && v.length > 400) clipped[k] = v.slice(0, 400) + `…（共 ${v.length} 字符）`;
  }
  return JSON.stringify(clipped, null, 2);
}

function FnChain({ step }: { step: ReplayStep }) {
  let delay = 0;
  const d = () => ({ animationDelay: `${(delay += 80)}ms` });
  const parts: React.ReactNode[] = [];

  // 链条头：进入第一个函数之前的世界（用户动作 / 上一步的产物）
  if (step.input) {
    parts.push(
      <div key="in" className={DAT_CAP} style={d()}>
        <span className={CAP_LABEL}>输入</span>
        <Hl src={step.input} />
      </div>,
      <span key="inc" className={`${CHEV} text-ok`} style={d()}>➤</span>
    );
  }

  step.fns.forEach((f, i) => {
    // 芯片 = 函数:skip 虚线划掉,deny 红边
    const fnCls =
      `bg-muted border rounded-[10px] px-3 py-2 min-w-[130px] ${POP_ANIM} ` +
      (f.skip
        ? "border-border border-dashed"
        : step.deny
          ? "border-deny shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
          : "border-ok shadow-[0_1px_3px_rgba(0,0,0,0.3)]");
    parts.push(
      <div key={`f${i}`} className={fnCls} style={d()}>
        <div className={"font-mono text-xs font-medium" + (f.skip ? " text-muted-foreground line-through" : "")}>
          {f.skip ? "✕ " : ""}{f.n}
        </div>
        <div className="font-mono text-[10px] text-muted-foreground mt-[3px]">{f.f}</div>
        <div className={"text-[10.5px] leading-normal mt-[5px] " + (f.skip ? "text-deny" : "text-brand")}>
          {f.io}
        </div>
      </div>
    );
    if (i < step.fns.length - 1) {
      const chev = `${CHEV} ` + (step.fns[i + 1]?.skip ? "text-border" : "text-ok");
      if (f.out) {
        parts.push(
          <span key={`c${i}a`} className={chev} style={d()}>➤</span>,
          <div key={`d${i}`} className={DAT} style={d()}>
            <Hl src={f.out} />
          </div>,
          <span key={`c${i}b`} className={chev} style={d()}>➤</span>
        );
      } else {
        parts.push(
          <span key={`c${i}`} className={chev} style={d()}>➤</span>
        );
      }
    }
  });

  // 链条尾：最后一个函数的产物 = 本 step 对世界的净效果
  const last = step.fns[step.fns.length - 1];
  if (last?.out) {
    parts.push(
      <span key="outc" className={`${CHEV} text-ok`} style={d()}>➤</span>,
      <div key="out" className={DAT_CAP} style={d()}>
        <span className={CAP_LABEL}>输出</span>
        <Hl src={last.out} />
      </div>
    );
  }
  return <div className={CHAIN}>{parts}</div>;
}

export function Replay() {
  const events = useChat((s) => s.events);
  const cursor = useChat((s) => s.replayCursor);
  const setReplayCursor = useChat((s) => s.setReplayCursor);
  const [playing, setPlaying] = useState(false);

  const steps = useMemo(() => events.map((e, i) => toStep(e, i, events)), [events]);
  const cur = cursor === null ? -1 : Math.min(cursor, steps.length - 1);
  const s = cur >= 0 ? (steps[cur] ?? null) : null;

  // 播放 = 定时推进游标；到尾自动停。手点 step 也会经这里重置计时
  useEffect(() => {
    if (!playing) return;
    if (cur >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setReplayCursor(cur + 1), 1600);
    return () => clearTimeout(t);
  }, [playing, cur, steps.length, setReplayCursor]);

  const goto = (i: number) => {
    setPlaying(false);
    setReplayCursor(Math.max(0, Math.min(steps.length - 1, i)));
  };

  // 播放/切步时当前行跟进视野（nearest：不居中猛跳，就近露出）
  const curRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    curRef.current?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  // 驾驶舱布局：画布 / 轨迹 / 步骤三区同屏（grid），信息不藏在滚动下面;
  // 窄窗口降级:摆不下就回到纵向文档流,整区滚动。
  // .replay 类保留:画布 SVG 节点/边状态样式的作用域(app.css)
  return (
    <section className="replay flex-1 min-h-0 px-[14px] py-3 grid gap-3 grid-cols-[minmax(0,1fr)_minmax(300px,380px)] grid-rows-[minmax(0,1fr)_auto] [grid-template-areas:'canvas_side'_'trace_side'] max-[980px]:flex max-[980px]:flex-col max-[980px]:overflow-y-auto max-[980px]:overflow-x-hidden">
      {/* SVG 撑满面板并保持比例(preserveAspectRatio 默认 meet) */}
      <div className="[grid-area:canvas] min-h-0 bg-card border border-border rounded-xl p-2 flex items-center justify-center [&>svg]:w-full [&>svg]:h-full [&>svg]:block max-[980px]:shrink-0 max-[980px]:[&>svg]:h-auto">
        <Canvas nodes={s?.nodes ?? []} edges={s?.edges ?? []} deny={s?.deny ?? false} />
      </div>
      <aside className="[grid-area:side] min-h-0 flex flex-col gap-[10px]">
        <div className="flex gap-[6px] items-center">
          <Button variant="outline" className="px-[14px] py-[6px] h-auto text-[13px]" onClick={() => goto(cur - 1)}>◀</Button>
          <Button
            className="px-[14px] py-[6px] h-auto text-[13px] bg-ok border-ok text-white hover:bg-ok/90 hover:border-ok/90"
            onClick={() => {
              if (playing) return setPlaying(false);
              if (cur >= steps.length - 1) setReplayCursor(0);
              setPlaying(true);
            }}
          >
            {playing ? "⏸ 暂停" : "▶ 播放"}
          </Button>
          <Button variant="outline" className="px-[14px] py-[6px] h-auto text-[13px]" onClick={() => goto(cur + 1)}>▶</Button>
          {/* 位置计数:等宽数字,走完 27 步数字不跳宽 */}
          <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
            {cur + 1} / {steps.length}
          </span>
        </div>
        <div className="bg-card border border-border rounded-xl p-[6px] flex-[1_1_40%] min-h-[120px] overflow-y-auto max-[980px]:flex-none max-[980px]:max-h-[min(260px,32vh)]">
          {steps.map((st, i) => {
            const isCur = i === cur;
            // 当前步:左侧 accent 条 + 底色,比整圈描边安静(描边会跟滚动条打架)
            return (
              <div
                key={st.ev.seq}
                ref={isCur ? curRef : null}
                className={
                  "px-[10px] py-[6px] rounded-lg cursor-pointer flex gap-[10px] items-baseline transition-colors duration-100 " +
                  (isCur
                    ? st.deny
                      ? "bg-deny/15 shadow-[inset_2px_0_0_var(--color-deny)]"
                      : "bg-ok/15 shadow-[inset_2px_0_0_var(--color-ok)]"
                    : "hover:bg-foreground/5 active:bg-foreground/[0.09]")
                }
                onClick={() => goto(i)}
              >
                <span className="font-mono text-[11px] text-muted-foreground w-[46px] shrink-0 tabular-nums">seq {st.ev.seq}</span>
                {/* 事件类型是代码标识符:用等宽,和 payload/轨迹同一语言 */}
                <span className="font-mono text-[12.5px] font-medium">{st.title}</span>
                <span
                  className={
                    "text-[10px] px-[7px] py-[2px] rounded-full ml-auto shrink-0 whitespace-nowrap tracking-[0.02em] " +
                    (isCur
                      ? st.deny
                        ? "bg-deny/[0.18] text-deny"
                        : "bg-ok/[0.18] text-ok"
                      : st.deny
                        ? "bg-deny/[0.14] text-deny"
                        : "bg-foreground/[0.06] text-muted-foreground")
                  }
                >
                  {st.badge}
                </span>
              </div>
            );
          })}
        </div>
        <div className="bg-card border border-border rounded-xl p-[14px] flex-[1_1_60%] min-h-[140px] overflow-y-auto max-[980px]:flex-none max-[980px]:overflow-visible">
          {s ? (
            <>
              <h3 className={PANEL_H3}>
                seq {s.ev.seq} · {s.title}
              </h3>
              <div className="text-[13px] leading-[1.65] mb-[10px]">{s.desc}</div>
              <pre className="hl font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap break-all text-[var(--hl-string)] bg-[var(--pre-bg)] rounded-lg px-3 py-[10px]">
                <Hl src={displayEvent(s.ev)} />
              </pre>
            </>
          ) : (
            <div className="text-[13px] leading-[1.65] mb-[10px]">点一个 step，或按播放。</div>
          )}
        </div>
      </aside>
      <div className="[grid-area:trace] bg-card border border-border rounded-xl pt-[14px] px-[14px] pb-2">
        {/* 轨迹标题:左说明右图例,单行截断 */}
        <h3 className={`${PANEL_H3} flex gap-3 items-baseline whitespace-nowrap`}>
          <span className="overflow-hidden text-ellipsis">
            {s ? `函数轨迹 · seq ${s.ev.seq} ${s.title}（${s.badge}）` : "函数轨迹"}
          </span>
          <span className="ml-auto font-normal text-muted-foreground shrink-0">芯片 = 函数 · 蓝卡 = 函数间流动的数据</span>
        </h3>
        {/* key=cur：换 step 时整棵子树重建，pop 入场动画重新播 */}
        {s ? (
          <FnChain key={cur} step={s} />
        ) : (
          <div className={CHAIN}>
            <span className="text-muted-foreground text-[13px]">选一个 step 看它穿过哪些函数。</span>
          </div>
        )}
      </div>
    </section>
  );
}
