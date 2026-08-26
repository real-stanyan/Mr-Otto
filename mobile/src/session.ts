// 把手机端那几件事装配到一起:身份 → 传输 → 桥。
// 逻辑本身一点都不在这儿 —— 桥在 src/shared/remote/mobileBridge.ts(跟着根门禁跑),
// 这里只负责"用哪个实现"。

import { nobleRemoteCrypto } from "../../src/shared/remote/nobleCrypto.js";
import { createMobileBridge, type MobileBridge } from "../../src/shared/remote/mobileBridge.js";
import { createRemoteDevices } from "../../src/shared/remote/devices.js";
import { relayBaseUrl } from "../../src/shared/gatewayConfig.js";
import type { DownFrame } from "../../src/shared/remote/frames.js";
import type { PinnedPeerStore } from "../../src/shared/remote/devices.js";
import { devicesApi } from "./devicesApi.js";
import { openIdentity } from "./identity.js";
import { supabase } from "./supabase.js";
import { createXhrTransport } from "./transport.js";

export const crypto = nobleRemoteCrypto();

/** RN 里没有 process.env,relayBaseUrl 读的那个 env 传空对象即可 —— 走默认生产网关 */
export const RELAY_BASE = relayBaseUrl({} as never);

export async function openStore(): Promise<PinnedPeerStore> {
  return openIdentity(crypto);
}

export function devices(store: PinnedPeerStore) {
  return createRemoteDevices({ api: devicesApi, store, crypto, selfKind: "mobile" });
}

export function connect(
  store: PinnedPeerStore,
  handlers: {
    onFrame: (f: DownFrame) => void;
    onReady: (r: boolean) => void;
    /** 桥和传输层说的每一句话。**手机上没有终端** —— 真机联调时 metro 的
        console 转发时灵时不灵,而"帧被丢了"和"帧没来"在屏幕上长得一模一样。
        接出来给 UI 显示,这一层才不是哑的 */
    onLog?: (m: string) => void;
  }
): MobileBridge {
  const log = (m: string): void => {
    console.warn(m);
    handlers.onLog?.(m);
  };
  const transport = createXhrTransport({
    baseUrl: RELAY_BASE,
    authToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    log,
  });
  return createMobileBridge({
    crypto,
    identity: store.identity,
    deviceId: store.deviceId,
    transport,
    peerIdentity: () => store.peerIdentity(),
    onFrame: handlers.onFrame,
    onReady: handlers.onReady,
    log,
  });
}
