// activityWriter —— agent_activity 那张表的写库节流 + 心跳（#1282，spec §3.2）。每条会话一个。
//
// 形状同 lastWriter：首尾两沿，窗口从上一次**写**算起；一次把这条会话里变了的几只一起写。
// 另有一件 lastWriter 没有的事：心跳。此刻在进行的几档（LIVE_ACTIVITIES）每 beatMs 补写一次 beat，
// 客户端 3 次没收到就当「不知道」——daemon 崩了、没来得及写 idle 时，列表不会永远停在「在跑」上。
// 出错 / 额度用完不心跳：它们说的是上一轮的结局，不过期（spec §3.3）。
//
// 一只智能体第一次出现就是 idle 的不写：没有那一行 = 闲着（客户端两者画法相同），而 daemon 启动时
// 已经把上一个进程留下的行全部写回了 idle（cloudSessionMeta.resetAgentActivity）。
// 写的是日志的投影：失败只丢这一次（CloudSessionMeta 的实现自己记日志），下一次变化盖掉。
// 时钟与定时器可注入，测试不必动 vi 的假定时器。

import { LIVE_ACTIVITIES, type AgentActivity } from "../../../src/shared/agentActivity.js";

export interface ActivityWrite {
  agentId: string;
  state: AgentActivity;
  since: number;
  beat: number;
}

export interface ActivityWriter {
  set(agentId: string, state: AgentActivity): void;
  /** 收摊（归档）：不在 idle 的当场写成 idle，之后的 set 与到点的定时器一律不理 */
  close(): void;
}

export function createActivityWriter(o: {
  write: (rows: ActivityWrite[]) => Promise<void>;
  throttleMs: number;
  beatMs: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}): ActivityWriter {
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number): unknown => {
    const t = setTimeout(fn, ms);
    // 一个待写的状态投影不该拖着进程不退（daemon 收摊、测试结束时）
    (t as { unref?: () => void }).unref?.();
    return t;
  });
  const current = new Map<string, { state: AgentActivity; since: number }>();
  const dirty = new Set<string>();
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let armed = false;
  let beating = false;
  let closed = false;

  const send = (ids: Iterable<string>): void => {
    const at = now();
    const rows: ActivityWrite[] = [];
    for (const id of ids) {
      const c = current.get(id);
      if (c !== undefined) rows.push({ agentId: id, state: c.state, since: c.since, beat: at });
    }
    if (rows.length === 0) return;
    void o.write(rows).catch(() => undefined);
  };

  const liveIds = (): string[] => [...current].filter(([, c]) => LIVE_ACTIVITIES.has(c.state)).map(([id]) => id);

  const armBeat = (): void => {
    if (beating || closed || liveIds().length === 0) return;
    beating = true;
    setTimer(beat, o.beatMs);
  };

  function beat(): void {
    beating = false;
    if (closed) return;
    const live = liveIds();
    if (live.length === 0) return;
    send(live);
    armBeat();
  }

  const fire = (): void => {
    armed = false;
    if (closed || dirty.size === 0) return;
    lastWriteAt = now();
    const ids = [...dirty];
    dirty.clear();
    send(ids);
    armBeat();
  };

  return {
    set(agentId, state) {
      if (closed) return;
      const prev = current.get(agentId);
      if (prev?.state === state) return;
      current.set(agentId, { state, since: now() });
      if (prev === undefined && state === "idle") return;
      dirty.add(agentId);
      if (armed) return;
      const wait = lastWriteAt + o.throttleMs - now();
      if (wait <= 0) {
        fire();
        return;
      }
      armed = true;
      setTimer(fire, wait);
    },
    close() {
      if (closed) return;
      const t = now();
      const idle: string[] = [];
      for (const [id, c] of current) {
        if (c.state === "idle") continue;
        current.set(id, { state: "idle", since: t });
        idle.push(id);
      }
      closed = true;
      dirty.clear();
      send(idle);
    },
  };
}
