// 中继（edge）的根地址。原来住在 session.ts（配对那条中继的装配），#1356 删掉配对之后单独留下：
// 账号页诊断那一行要它，A1 的云会话客户端也要它（role=guest 连 cs 房）。
// RN 里没有 process.env，relayBaseUrl 读的那个 env 传空对象即可 —— 走默认生产地址。
import { relayBaseUrl } from "../../src/shared/edgeConfig.js";

export const RELAY_BASE = relayBaseUrl({} as never);
