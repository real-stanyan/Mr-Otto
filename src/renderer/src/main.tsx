import React from "react";
import { createRoot } from "react-dom/client";
import { initTheme } from "./theme.js";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { Splash } from "./components/Splash.js";
import "./app.css";

// 首帧前按偏好定主题:CSP 禁内联 script,module 顶层执行同样先于首次 paint
initTheme();

// 拖到投放区以外的文件一律吞掉。不拦的话 Chromium 会把窗口导航到 file:// 那个文件,
// 整个 app 就没了——投放区自己会 preventDefault 并 stopPropagation 之前先接住,
// 这里只兜"扔在别处"的情况(捕获阶段挂在 window 上,谁都跑不掉)
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (e) => {
    if (!e.defaultPrevented) e.preventDefault();
  });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* 组件崩了要看得见错误,而不是一片黑(issue #51) */}
    <ErrorBoundary>
      <App />
      {/* 启动画面盖在 App 上面，boot 完 + 最短停留到了自己淡出卸载 */}
      <Splash />
    </ErrorBoundary>
  </React.StrictMode>
);
