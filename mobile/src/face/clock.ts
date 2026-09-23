// 一口共用的钟（#1356）：会动的脸订阅它，25fps 一拍。有订阅者才跑、App 进后台就停——
// 每张脸各起一个定时器的话，一墙十几张脸就是十几个定时器各打各的。
// 25fps 不是省电的借口：这些位移全是整格的，60fps 里一多半帧与上一帧逐像素相同。
import { AppState } from "react-native";

type Tick = (now: number) => void;

const FPS = 25;
const subs = new Set<Tick>();
let timer: ReturnType<typeof setInterval> | null = null;
let active = AppState.currentState === "active";

function start(): void {
  if (timer !== null || !active || subs.size === 0) return;
  timer = setInterval(() => {
    const now = Date.now();
    for (const f of subs) f(now);
  }, 1000 / FPS);
}

function stop(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

AppState.addEventListener("change", (s) => {
  active = s === "active";
  if (active) start();
  else stop();
});

/** 订阅；立刻回调一次「此刻」，之后每拍一次。返回退订函数 */
export function subscribeFaceClock(fn: Tick): () => void {
  subs.add(fn);
  fn(Date.now());
  start();
  return () => {
    subs.delete(fn);
    if (subs.size === 0) stop();
  };
}
