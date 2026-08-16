// 富回放视图：画布 + step 列表 + 事件 payload + 函数轨迹。
// 回放"系统里发生了什么"——不是切聊天框，是重演每条事件穿过哪些组件、数据怎么流。
// 全部只读：主进程和 agent 对回放毫不知情（纯渲染层投影）。

import { useEffect, useMemo, useState } from "react";
import { useChat } from "../store.js";
import { toStep, hl, type ReplayStep } from "./steps.js";
import { Canvas } from "./Canvas.js";

/** token 数组 → 着色 span（steps.ts 的 hl 保持纯数据，DOM 在这拼） */
function Hl({ src }: { src: string }) {
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

  step.fns.forEach((f, i) => {
    const cls = f.skip ? "fn skip" : step.deny ? "fn deny" : "fn";
    parts.push(
      <div key={`f${i}`} className={cls} style={d()}>
        <div className="name">{f.skip ? "✕ " : ""}{f.n}</div>
        <div className="file">{f.f}</div>
        <div className="io">{f.io}</div>
      </div>
    );
    if (i < step.fns.length - 1) {
      const chev = step.fns[i + 1]?.skip ? "chev skip" : "chev";
      if (f.out) {
        parts.push(
          <span key={`c${i}a`} className={chev} style={d()}>➤</span>,
          <div key={`d${i}`} className="dat" style={d()}>
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
  return <div className="chain">{parts}</div>;
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

  return (
    <section className="replay">
      <div className="rp-top">
        <div className="rp-canvas">
          <Canvas nodes={s?.nodes ?? []} edges={s?.edges ?? []} deny={s?.deny ?? false} />
        </div>
        <div className="rp-side">
          <div className="rp-controls">
            <button onClick={() => goto(cur - 1)}>◀</button>
            <button
              className="primary"
              onClick={() => {
                if (playing) return setPlaying(false);
                if (cur >= steps.length - 1) setReplayCursor(0);
                setPlaying(true);
              }}
            >
              {playing ? "⏸ 暂停" : "▶ 播放"}
            </button>
            <button onClick={() => goto(cur + 1)}>▶</button>
            <span className="rp-pos">
              {cur + 1} / {steps.length}
            </span>
          </div>
          <div className="rp-steps">
            {steps.map((st, i) => (
              <div
                key={st.ev.seq}
                className={"rp-step" + (i === cur ? " cur" + (st.deny ? " deny" : "") : "")}
                onClick={() => goto(i)}
              >
                <span className="n">seq {st.ev.seq}</span>
                <span className="t">{st.title}</span>
                <span className={"badge" + (st.deny ? " deny" : "")}>{st.badge}</span>
              </div>
            ))}
          </div>
          <div className="rp-payload">
            {s ? (
              <>
                <h3>
                  seq {s.ev.seq} · {s.title}
                </h3>
                <div className="desc">{s.desc}</div>
                <pre>
                  <Hl src={displayEvent(s.ev)} />
                </pre>
              </>
            ) : (
              <div className="desc">点一个 step，或按播放。</div>
            )}
          </div>
        </div>
      </div>
      <div className="rp-trace">
        <h3>
          {s
            ? `函数轨迹 · seq ${s.ev.seq} ${s.title}（${s.badge}）—— 芯片 = 函数，蓝卡 = 函数之间流动的数据`
            : "函数轨迹（本 step 实际经过的调用链）"}
        </h3>
        {/* key=cur：换 step 时整棵子树重建，pop 入场动画重新播 */}
        {s ? (
          <FnChain key={cur} step={s} />
        ) : (
          <div className="chain">
            <span className="empty">选一个 step 看它穿过哪些函数。</span>
          </div>
        )}
      </div>
    </section>
  );
}
