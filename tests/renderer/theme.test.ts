import { describe, it, expect } from "vitest";
import { resolveTheme, createThemeController, type ThemeEnv, type ThemePref } from "../../src/renderer/src/theme.js";

function fakeEnv(init: { stored?: string | null; systemDark?: boolean } = {}) {
  let stored = init.stored ?? null;
  let sysDark = init.systemDark ?? false;
  const applied: boolean[] = [];
  let listener: (() => void) | null = null;
  const env: ThemeEnv = {
    getStored: () => stored,
    setStored: (v: ThemePref) => { stored = v; },
    systemDark: () => sysDark,
    onSystemChange: (cb) => { listener = cb; return () => { listener = null; }; },
    applyDark: (d) => { applied.push(d); },
  };
  return {
    env, applied,
    setSystemDark(v: boolean) { sysDark = v; listener?.(); },
    stored: () => stored,
    hasListener: () => listener !== null,
  };
}

describe("resolveTheme", () => {
  it("light/dark 直出,system 跟系统", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("createThemeController", () => {
  it("无存储默认 system,创建即按系统 apply", () => {
    const f = fakeEnv({ systemDark: true });
    const c = createThemeController(f.env);
    expect(c.pref()).toBe("system");
    expect(f.applied).toEqual([true]);
  });

  it("非法存储值当 system", () => {
    const f = fakeEnv({ stored: "banana" });
    const c = createThemeController(f.env);
    expect(c.pref()).toBe("system");
  });

  it("setPref 持久化并立即 apply", () => {
    const f = fakeEnv({ systemDark: true });
    const c = createThemeController(f.env);
    c.setPref("light");
    expect(f.stored()).toBe("light");
    expect(f.applied.at(-1)).toBe(false);
  });

  it("system 时系统切换跟着变;手动锁定后系统切换不生效", () => {
    const f = fakeEnv();
    const c = createThemeController(f.env);
    f.setSystemDark(true);
    expect(f.applied.at(-1)).toBe(true);
    c.setPref("light");
    const n = f.applied.length;
    f.setSystemDark(false);
    f.setSystemDark(true);
    expect(f.applied.length).toBe(n); // 锁定后不再 apply
  });

  it("dispose 退订", () => {
    const f = fakeEnv();
    const c = createThemeController(f.env);
    expect(f.hasListener()).toBe(true);
    c.dispose();
    expect(f.hasListener()).toBe(false);
  });
});
