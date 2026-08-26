// devices 表那一列 `label` 该写什么。
//
// **为什么值得单独一个文件**:原来手机端写死 `registerSelf("iPhone")`,桌面写
// `hostname()`。于是同一台手机换个安装(Expo Go / 正式 app / 重装)在目录里就是
// 两行一模一样的「iPhone」—— 身份私钥按 bundle id 隔离在各自的钥匙串里,新安装
// 读不到旧的,只能重新生成,这一行本来就该出现;真正的毛病是**它们长得一样**。
//
// 平台读数(Device.deviceName / modelName / isDevice)留在 mobile 那侧,这里只做
// 拼接 —— 拼接才是会写错的那部分,而它在这儿能被测。
//
// 注意 label 只进 Supabase 的 devices 表(与桌面上传 hostname 同一档),**不进
// hello 帧**:hello 是明文过中继的,任何有辨识度的东西都会当场送给网关运营者,
// 所以那边用的是随机 deviceId(mobile/src/identity.ts 的注释)。

/** 平台报回来的那点信息。全是可空的 —— 拿不到就往下退,不是报错 */
export interface DeviceFacts {
  /** 用户给设备起的名字。**iOS 16 起拿不到真名**:没有
      user-assigned-device-name 权限的 app 读到的是机型通名(「iPhone」) */
  name: string | null;
  /** 机型,「iPhone 16 Pro Max」 */
  model: string | null;
  /** 真机 = true,模拟器 = false */
  isPhysical: boolean;
  /** 跑在哪个壳里。Expo Go 和正式 app 是两个 bundle id = 两套钥匙串 = 两个身份 */
  runtime: "expo-go" | "app";
}

/** name 读到这些就是**没读到**:iOS 16 的通名、以及各平台的占位值 */
const GENERIC = new Set(["iphone", "ipad", "ipod touch", "android", "phone", "device"]);

/**
 * 拼一个人能在列表里认出来的名字。
 *
 * 优先真名(用户自己起的「Stan 的 iPhone」),退到机型,再退到「手机」。
 * 后缀只在**需要区分**时加:正式 app 装在真机上是常态,不加后缀;
 * Expo Go 和模拟器是同一台机器上的另一份安装,不标出来就跟常态那行撞脸。
 */
export function deviceLabel(f: DeviceFacts): string {
  // 空串要当成"没读到"。`?? ` 只兜 null/undefined —— 平台把拿不到的字段报成 ""
  // 是常见的,那样退化下去的结果是一个**没有名字的名字**
  const named = f.name?.trim() || null;
  const model = f.model?.trim() || null;
  const base = (named && !GENERIC.has(named.toLowerCase()) ? named : null) ?? model ?? "手机";
  if (!f.isPhysical) return `${base}（模拟器）`;
  if (f.runtime === "expo-go") return `${base}（Expo Go）`;
  return base;
}
