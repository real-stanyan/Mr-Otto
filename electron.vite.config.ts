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
    build: {
      // 文件类型图标(566 枚,共约 470KB)一律不内联成 data URI。
      // Vite 默认把 4KB 以下的资源塞进 JS,而这些图标平均才 800 字节 —— 全内联
      // 等于把 470KB(base64 后更多)搬进主包,开机就得全部解析,而一屏上通常
      // 只出现其中几枚。留成磁盘上的文件:界面上出现哪枚才读哪枚,
      // 进包的只剩一张地址表。其它资源照旧走默认(返回 undefined)
      assetsInlineLimit: (filePath: string) =>
        filePath.includes("/assets/file-icons/") ? false : undefined,
      // 灵动岛(Task 6)是第二个 renderer 入口:独立 HTML/bundle,主窗和岛窗
      // 各自的 loadFile 指到各自的产物(见 index.ts createWindow / createIslandWindow)
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          island: resolve(__dirname, "src/renderer/island.html"),
        },
      },
    },
  },
});
