// 从 material-icon-theme 生成本仓要用的那一小撮文件图标 + 对照表。
//
// 为什么是"生成"而不是"依赖":上游那包带着 1250 枚图标(5MB)和一份 450KB 的
// 对照表,而本仓要显示图标的地方就那么几处(附件、工具行的路径、diff 头)。
// 全量塞进渲染进程 = 为了几十个常见后缀背 5MB;所以在这里挑一批、抄进仓里,
// 认不出的后缀退回通用的 file 图标 —— 这是诚实的降级,不是缺失。
//
// 用法(需要先 npm i -D material-icon-theme):
//   node scripts/gen-file-icons.mjs
// 产出:
//   src/renderer/src/assets/file-icons/*.svg
//   src/renderer/src/lib/fileIconMap.ts
//
// 上游 MIT,LICENSE 一并抄进 assets/file-icons/。升级 = 改 package.json 的版本
// 再跑一遍这个脚本,不手改产物。

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = dirname(require.resolve("material-icon-theme/package.json"));
const theme = JSON.parse(readFileSync(join(pkgDir, "dist/material-icons.json"), "utf8"));

/** 要抄进来的图标。挑的标准:本仓的用户实际会在界面上看到的文件类型 ——
    主流语言、常见配置/锁文件、几类二进制。名字是上游 icons/<name>.svg 的文件名 */
const KEEP = [
  // 默认与兜底
  "file", "folder",
  // 语言
  "typescript", "react_ts", "javascript", "react", "python", "rust", "go", "java",
  "kotlin", "swift", "c", "cpp", "h", "csharp", "ruby", "php", "lua", "vue", "svelte",
  "console", "powershell", "webassembly", "jupyter", "graphql",
  // 标记 / 样式 / 数据
  "markdown", "readme", "html", "css", "sass", "less", "tailwindcss", "json", "yaml",
  "toml", "xml", "database", "table", "document", "log", "todo",
  // 工程配置
  "nodejs", "npm", "pnpm", "vite", "tsconfig", "git", "docker", "makefile", "eslint",
  "prettier", "editorconfig", "settings", "tune", "lock", "license", "test-ts",
  // 资源 / 二进制
  "svg", "image", "video", "audio", "font", "pdf", "zip", "exe", "key", "certificate",
];

const keep = new Set(KEEP);

// 对照表只留指向这批图标的条目:指向没抄进来的图标的条目留着也只会 404
const pick = (table) =>
  Object.fromEntries(Object.entries(table ?? {}).filter(([, icon]) => keep.has(icon)));

const byExtension = pick(theme.fileExtensions);
const byName = pick(theme.fileNames);

const outIcons = join(root, "src/renderer/src/assets/file-icons");
rmSync(outIcons, { recursive: true, force: true });
mkdirSync(outIcons, { recursive: true });
for (const name of KEEP) {
  cpSync(join(pkgDir, `icons/${name}.svg`), join(outIcons, `${name}.svg`));
}
cpSync(join(pkgDir, "LICENSE"), join(outIcons, "LICENSE"));

const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
const header = `// 由 scripts/gen-file-icons.mjs 生成，**勿手改** —— 改了下次生成会被覆盖。
// 来源：material-icon-theme@${version}（MIT，许可证在 assets/file-icons/LICENSE）。
// 只收录 assets/file-icons/ 里实际抄进来的那批图标；认不出的后缀退回 file。
`;

const lines = [
  header,
  `/** 抄进本仓的图标名（= assets/file-icons/<name>.svg） */`,
  `export const ICON_NAMES = ${JSON.stringify(KEEP)} as const;`,
  ``,
  `/** 后缀 → 图标名。键不带点，全小写 */`,
  `export const BY_EXTENSION: Record<string, string> = ${JSON.stringify(byExtension, null, 2)};`,
  ``,
  `/** 整个文件名 → 图标名（package.json 这类）。键全小写 */`,
  `export const BY_NAME: Record<string, string> = ${JSON.stringify(byName, null, 2)};`,
  ``,
];
writeFileSync(join(root, "src/renderer/src/lib/fileIconMap.ts"), lines.join("\n"));

console.log(
  `图标 ${KEEP.length} 枚；后缀 ${Object.keys(byExtension).length} 条、文件名 ${Object.keys(byName).length} 条`,
);
