import type { IslandSnapshot } from "../shared/shellBridge.js";

export type IslandCommand =
  | { type: "ready" }
  | { type: "send"; sessionId: string; text: string }
  | { type: "approve"; sessionId: string; callId: string; grant?: "session" }
  | { type: "deny"; sessionId: string; callId: string };

export interface IslandChild {
  stdin: { write(s: string): void };
  stdout: { on(ev: "data", cb: (b: Buffer) => void): void };
  on(ev: "exit", cb: () => void): void;
  kill(): void;
}
export type SpawnFn = (binPath: string) => IslandChild;

export function encodeState(snapshot: IslandSnapshot): string {
  return JSON.stringify({ type: "state", state: snapshot }) + "\n";
}

export function decodeCommand(line: string): IslandCommand | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const c = o as Record<string, unknown>;
  switch (c.type) {
    case "ready":
      return { type: "ready" };
    case "send":
      return typeof c.sessionId === "string" && typeof c.text === "string"
        ? { type: "send", sessionId: c.sessionId, text: c.text }
        : null;
    case "approve":
      return typeof c.sessionId === "string" && typeof c.callId === "string"
        ? { type: "approve", sessionId: c.sessionId, callId: c.callId, ...(c.grant === "session" ? { grant: "session" as const } : {}) }
        : null;
    case "deny":
      return typeof c.sessionId === "string" && typeof c.callId === "string"
        ? { type: "deny", sessionId: c.sessionId, callId: c.callId }
        : null;
    default:
      return null;
  }
}

const MAX_RESTARTS = 3;

export function createIslandBridge(opts: {
  binPath: string;
  spawn: SpawnFn;
  onCommand: (c: IslandCommand) => void;
  log?: (m: string) => void;
}): { pushState(s: IslandSnapshot): void; dispose(): void } {
  const log = opts.log ?? (() => {});
  let child: IslandChild | null = null;
  let restarts = 0;
  let disposed = false;
  let last: IslandSnapshot | null = null;
  let buf = "";

  const start = () => {
    if (disposed) return;
    const c = opts.spawn(opts.binPath);
    child = c;
    buf = "";
    c.stdout.on("data", (b) => {
      buf += b.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const cmd = decodeCommand(line);
        if (cmd) opts.onCommand(cmd);
        else log(`岛桥:无法解析命令行 ${line.slice(0, 120)}`);
      }
    });
    c.on("exit", () => {
      if (disposed) return;
      if (restarts >= MAX_RESTARTS) {
        log(`岛桥:helper 崩溃 ${restarts} 次,放弃重启,岛不再显示`);
        child = null;
        return;
      }
      restarts += 1;
      log(`岛桥:helper 退出,第 ${restarts} 次重启`);
      start();
      // ready 握手会由 helper 侧发起并回推;这里重启后把最后一份快照也补推一次
      if (last) pushState(last);
    });
  };

  const pushState = (s: IslandSnapshot) => {
    last = s;
    if (!child) return;
    try {
      child.stdin.write(encodeState(s));
    } catch (e) {
      log(`岛桥:写 stdin 失败 ${String(e)}`);
    }
  };

  start();

  return {
    pushState,
    dispose() {
      disposed = true;
      child?.kill();
      child = null;
    },
  };
}
