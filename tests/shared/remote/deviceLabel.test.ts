import { describe, expect, it } from "vitest";
import { deviceLabel, type DeviceFacts } from "../../../src/shared/remote/deviceLabel.js";

const real: DeviceFacts = {
  name: "Stan 的 iPhone", model: "iPhone 16 Pro Max", isPhysical: true, runtime: "app",
};

describe("deviceLabel", () => {
  it("有真名就用真名", () => {
    expect(deviceLabel(real)).toBe("Stan 的 iPhone");
  });

  // iOS 16 起,没有 user-assigned-device-name 权限的 app 读 name 拿到的是机型通名。
  // 直接用它的话,一屋子设备全叫「iPhone」—— 正是这个模块要解决的那件事
  it("name 读回通名（iOS 16 的行为）→ 退到机型", () => {
    expect(deviceLabel({ ...real, name: "iPhone" })).toBe("iPhone 16 Pro Max");
    expect(deviceLabel({ ...real, name: "  iPad " })).toBe("iPhone 16 Pro Max");
  });

  it("name 和 model 都没有 → 还有个能显示的东西", () => {
    expect(deviceLabel({ ...real, name: null, model: null })).toBe("手机");
    expect(deviceLabel({ ...real, name: "  ", model: "" })).toBe("手机");
  });

  // 后缀只在需要区分时加:同一台手机上的另一份安装,不标出来就跟正式 app 那行撞脸
  it("Expo Go 和模拟器各自标出来，正式 app 不加后缀", () => {
    expect(deviceLabel({ ...real, runtime: "expo-go" })).toBe("Stan 的 iPhone（Expo Go）");
    expect(deviceLabel({ ...real, isPhysical: false, model: "iPhone 17" }))
      .toBe("Stan 的 iPhone（模拟器）");
  });

  // 模拟器上跑的就是 Expo Go 时,「模拟器」是更有用的那条信息:
  // 同一台 Mac 上的模拟器只有一份,而 Expo Go 真机上也有一份
  it("模拟器 + Expo Go → 标模拟器", () => {
    expect(deviceLabel({ ...real, isPhysical: false, runtime: "expo-go" }))
      .toBe("Stan 的 iPhone（模拟器）");
  });
});
