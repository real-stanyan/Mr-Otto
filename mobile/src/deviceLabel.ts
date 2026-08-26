// 平台读数这一小层。拼接的规则在 src/shared/remote/deviceLabel.ts —— 那边能被测,
// 这边不能(要真机才有 Device.deviceName),所以这个文件刻意薄到没有分支可写错。

import Constants from "expo-constants";
import * as Device from "expo-device";
import { deviceLabel } from "../../src/shared/remote/deviceLabel.js";

/**
 * 这台设备在 devices 目录里的显示名。
 *
 * **为什么用 appOwnership 而不是官方推荐的 executionEnvironment**:后者把 Expo Go
 * 和 dev-client 归成同一个 `storeClient`,而我们要区分的恰好是"哪一份安装" ——
 * 归到一起就什么也没区分出来。appOwnership 标了 deprecated,代价是某个 SDK 之后
 * 可能没有;真没了的话退化成不加后缀,列表里靠机型和最后在线时间分,不会炸。
 */
export function myLabel(): string {
  return deviceLabel({
    name: Device.deviceName,
    model: Device.modelName,
    isPhysical: Device.isDevice,
    runtime: Constants.appOwnership === "expo" ? "expo-go" : "app",
  });
}
