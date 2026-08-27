// 把手机端那几件事装配到一起:身份 → 传输 → 桥。
// 逻辑本身一点都不在这儿 —— 桥在 src/shared/remote/mobileBridge.ts(跟着根门禁跑),
// 这里只负责"用哪个实现"。

import { AppState } from "react-native";

import { nobleRemoteCrypto } from "../../src/shared/remote/nobleCrypto.js";
import { createMobileBridge, type MobileBridge } from "../../src/shared/remote/mobileBridge.js";
import { createRemoteDevices } from "../../src/shared/remote/devices.js";
import { relayBaseUrl } from "../../src/shared/edgeConfig.js";
import type { DownFrame } from "../../src/shared/remote/frames.js";
import type { PinnedPeerStore } from "../../src/shared/remote/devices.js";
import { devicesApi } from "./devicesApi.js";
import { openIdentity } from "./identity.js";
import { supabase } from "./supabase.js";
import { createWsTransport } from "../../src/shared/remote/wsTransport.js";

export const crypto = nobleRemoteCrypto();

/** RN 里没有 process.env,relayBaseUrl 读的那个 env 传空对象即可 —— 走默认生产地址 */
export const RELAY_BASE = relayBaseUrl({} as never);

export async function openStore(): Promise<PinnedPeerStore> {
  return openIdentity(crypto);
}

/**
 * 刚扫到的那把配对 secret(issue #583)。**只在内存里**:它的寿命是"从扫完到连上"
 * 那几秒,落盘只会让一次性的东西活得比该有的久。
 *
 * 放模块级而不是穿进 connect():扫码发生在配对屏,而连接是会话屏建的 ——
 * 中间隔着一次换屏,穿参数要把它一路托过去。
 */
let pendingPairSecret: Uint8Array | null = null;

/** 扫完码调:下一轮握手带上持有证明 */
export function armPairing(secret: Uint8Array): void {
  pendingPairSecret = secret;
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
  const transport = createWsTransport({
    baseUrl: RELAY_BASE,
    role: "mobile",
    authToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    log,
  });
  // **回前台就换一条连接。** iOS 切后台会把 socket 掐掉,而 WebSocket 未必立刻
  // onclose:回来时它可能还"连着",既不报错也再不来一个字节 —— 桥那侧仍然是
  // ready,发出去的每一帧都掉进虚空,而屏幕上一切正常。这是"手机看着连着、
  // 其实什么都收不到"的主要成因,比断线难查得多。
  // 反过来,就算 socket 真断了,退避的 setTimeout 在后台也不走 —— 回来最长要再等
  // 30s。两种情况一条修法:回前台一律重连,不去猜旧连接还活着没有。
  //
  // 接在这里而不是传输里(桌面那条对称的触发是"刚登录",见 src/main/index.ts):
  // AppState 是 RN 独有的,而传输层现在两个平台共用一份。
  AppState.addEventListener("change", (next) => {
    if (next === "active") transport.reconnectNow("回到前台");
  });
  return createMobileBridge({
    crypto,
    identity: store.identity,
    deviceId: store.deviceId,
    transport,
    peerIdentities: () => store.peerIdentities(),
    pairSecret: () => pendingPairSecret,
    onFrame: handlers.onFrame,
    // 连上了 = 那张码在电脑那边已经用掉,手里这把再留着也没用了
    onReady: (r) => {
      if (r) pendingPairSecret = null;
      handlers.onReady(r);
    },
    log,
  });
}
