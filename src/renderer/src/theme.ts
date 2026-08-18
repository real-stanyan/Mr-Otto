// 主题偏好控制器。纯逻辑 + 注入环境(可测);浏览器胶水只在 browserThemeEnv。
// UI 偏好非会话事实:localStorage 即可,不走 IPC,不进事件日志。
export type ThemePref = "system" | "light" | "dark";

export interface ThemeEnv {
  getStored(): string | null;
  setStored(v: ThemePref): void;
  systemDark(): boolean;
  onSystemChange(cb: () => void): () => void;
  applyDark(dark: boolean): void;
}

const PREFS: readonly ThemePref[] = ["system", "light", "dark"];
const STORAGE_KEY = "otter-theme";

export function resolveTheme(pref: ThemePref, systemDark: boolean): "light" | "dark" {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

export function createThemeController(env: ThemeEnv) {
  const raw = env.getStored();
  let pref: ThemePref = PREFS.includes(raw as ThemePref) ? (raw as ThemePref) : "system";
  const apply = () => env.applyDark(resolveTheme(pref, env.systemDark()) === "dark");
  const unsub = env.onSystemChange(() => {
    if (pref === "system") apply();
  });
  apply();
  return {
    pref: () => pref,
    setPref(p: ThemePref) {
      pref = p;
      env.setStored(p);
      apply();
    },
    dispose: unsub,
  };
}

export function browserThemeEnv(): ThemeEnv {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  return {
    getStored: () => localStorage.getItem(STORAGE_KEY),
    setStored: (v) => localStorage.setItem(STORAGE_KEY, v),
    systemDark: () => mq.matches,
    onSystemChange(cb) {
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    applyDark: (dark) => document.documentElement.classList.toggle("dark", dark),
  };
}

let singleton: ReturnType<typeof createThemeController> | null = null;
export function initTheme() {
  singleton ??= createThemeController(browserThemeEnv());
  return singleton;
}
export function themeController() {
  return initTheme();
}
