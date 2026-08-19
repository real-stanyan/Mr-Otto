// electron-vite — 一个配置管三个构建目标（对应 Electron 的三个世界）
// main/preload 是 Node 侧：externalizeDepsPlugin 让 better-sqlite3 这类原生依赖
// 保持 require 外部引用，不被打进 bundle（原生 .node 文件没法 bundle）。
import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: { "@": resolve(__dirname, "src/renderer/src") },
      // 依赖里若有人把 react 解析成第二份实例，hook 会读到一个空的 dispatcher
      // （症状是 "Cannot read properties of null (reading 'useXxx')"）。
      // dedupe 强制全图共用同一份 —— 组件库越多这道保险越值钱
      dedupe: ["react", "react-dom"],
    },
    plugins: [react(), tailwindcss()],
  },
});
