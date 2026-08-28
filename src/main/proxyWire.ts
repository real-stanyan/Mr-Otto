// proxyWire —— wsTransport → ProxyWireTransport 的适配层（issue #622 PR-D2，ADR-0151）。
//
// wsTransport 是「按 cid 寻址」的（send 必须带收件人 cid，relay 一户多连接），
// 而好友代理的 proxyConnection 要的是「点对点」的 ProxyWireTransport（send 不带
// 收件人——一条代理通道就一个好友）。本层把前者包成后者：
//
//   - peerCid：relay 在对端 attach 时给两侧各发一条 `:peer <cid>`（wire.ts），
//     本层存下它，之后 send(payload) 内部补上 send(payload, peerCid)。
//   - 握手起点：`:peer` 一到就是「对端在场」，驱动连接 start()（同 remoteBridge 口径）。
//   - `:gone` / close：对端走了或连接断了，清 peerCid。
//
// 依赖注入（wsTransport 的 RemoteTransport），本层可脱离真 relay 测试。

import type { RemoteTransport } from "../shared/remote/transport.js";
import type { ProxyWireTransport } from "./proxyCoordinator.js";

/** 把按 cid 寻址的 RemoteTransport 包成点对点的 ProxyWireTransport。
    onPeer 回调 = 「对端在场」的信号（驱动 proxyConnection.start()） */
export function adaptProxyWire(
  transport: RemoteTransport,
  hooks: {
    /** 对端在场（`:peer <cid>`）——驱动连接握手 start */
    onPeerPresent: () => void;
    /** 对端走了（`:gone`）或连接断开 */
    onPeerGone?: () => void;
    log?: (m: string) => void;
  }
): ProxyWireTransport {
  let peerCid: string | null = null;
  const log = hooks.log ?? (() => {});

  transport.onPeer((cid) => {
    peerCid = cid;
    log(`代理传输:对端在场 ${cid.slice(0, 8)}`);
    hooks.onPeerPresent();
  });
  transport.onGone((goneCid) => {
    if (goneCid === peerCid) peerCid = null;
    log("代理传输:对端走了");
    hooks.onPeerGone?.();
  });
  transport.onClose(() => {
    peerCid = null;
  });

  return {
    send(payload: string): void {
      if (!peerCid) {
        log("代理传输:没有对端 cid,帧发不出去（对端还没 attach）");
        return;
      }
      transport.send(payload, peerCid);
    },
    onMessage(cb: (payload: string) => void): void {
      transport.onMessage((payload, _from) => {
        cb(payload);
      });
    },
    close(): void {
      transport.close();
    },
  };
}
