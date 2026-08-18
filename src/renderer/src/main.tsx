import React from "react";
import { createRoot } from "react-dom/client";
import { initTheme } from "./theme.js";
import { App } from "./App.js";
import "./app.css";

// 首帧前按偏好定主题:CSP 禁内联 script,module 顶层执行同样先于首次 paint
initTheme();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
