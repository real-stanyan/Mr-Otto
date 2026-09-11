// 到自己那台电脑那条加密连接的共享状态（ADR-0094 那条中继路）。
//
// 桥的生命周期归项目栏里的 Fleet（它握着连接）；这里只放**别的屏也要读**的：
// 一句话的状态（项目栏大标题底下、账号页）、桌面答回来的统计（账号页）、
// 「问一次统计」这个动作——只交动作，不交桥，别的屏能做的只有开口问。
// pairEpoch：每配对成功一次加一，项目栏拿它当 key 重建连接（新握手要带上刚扫到的 secret）。
import { createContext, useCallback, useContext, useRef, useState, type ReactNode, type RefObject } from "react";
import type { LinkStatus } from "../../src/shared/linkStatus.js";
import type { RemoteStats } from "../../src/shared/remote/stats.js";
import type { PinnedPeerStore } from "../../src/shared/remote/devices.js";

interface LinkValue {
  store: PinnedPeerStore;
  status: LinkStatus | null;
  setStatus: (s: LinkStatus) => void;
  stats: RemoteStats | null;
  setStats: (s: RemoteStats) => void;
  askStats: RefObject<(() => void) | null>;
  pairEpoch: number;
  bumpPair: () => void;
}

const Ctx = createContext<LinkValue | null>(null);

export function LinkProvider({ store, children }: { store: PinnedPeerStore; children: ReactNode }) {
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [stats, setStats] = useState<RemoteStats | null>(null);
  const askStats = useRef<(() => void) | null>(null);
  const [pairEpoch, setPairEpoch] = useState(0);
  const bumpPair = useCallback(() => setPairEpoch((n) => n + 1), []);
  return (
    <Ctx.Provider value={{ store, status, setStatus, stats, setStats, askStats, pairEpoch, bumpPair }}>
      {children}
    </Ctx.Provider>
  );
}

export function useLink(): LinkValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLink 只能在 LinkProvider 里面用");
  return v;
}
