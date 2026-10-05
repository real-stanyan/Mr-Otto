// Apple 健康（#1656）原生模块的 JS 一侧：Swift 在 ios/，读 HealthKit 按天汇总。
//
// **Expo Go 里没有它**（同 otto-speech / otto-paste）：requireOptionalNativeModule 回 null，设置页的开关置灰。
// query 回来的东西不在这里信任——交给 shared 的 answerHealthQuery → parseHealthResult 再验一遍。
import { requireOptionalNativeModule } from "expo";

export interface OttoHealthNative {
  isAvailable(): boolean;
  requestAuthorization(): Promise<boolean>;
  query(metrics: string[], from: string, to: string): Promise<unknown>;
}

export const OttoHealth: OttoHealthNative | null = requireOptionalNativeModule<OttoHealthNative>("OttoHealth");
