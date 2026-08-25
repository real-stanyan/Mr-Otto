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
  handlers: { onFrame: (f: DownFrame) => void; onReady: (r: boolean) => void }
): MobileBridge {
  const transport = createXhrTransport({
    baseUrl: RELAY_BASE,
    authToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    log: (m) => console.warn(m),
  });
  return createMobileBridge({
    crypto,
    identity: store.identity,
    deviceId: store.deviceId,
    transport,
    peerIdentity: () => store.peerIdentity(),
    onFrame: handlers.onFrame,
    onReady: handlers.onReady,
    log: (m) => console.warn(m),
  });
}
