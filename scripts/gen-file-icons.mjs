// 从 material-icon-theme 生成本仓用的文件类型图标 + 对照表。
//
// 为什么是"生成"而不是"直接依赖":上游那包里本仓用得上的只有 icons/*.svg 和一张
// 对照表,其余(文件夹图标、明暗变体、克隆生成器、VS Code 的清单文件)一概用不上,
// 而依赖装进来的是整包。这个脚本把用得上的那部分抄进仓里,顺带把对照表筛成
// 只指向抄进来的图标 —— 表里留一条指向没抄进来的图标,界面上就是一个 404 的 img。
//
// 用法(需要先 npm i -D material-icon-theme):
//   node scripts/gen-file-icons.mjs
// 产出:
//   src/renderer/src/assets/file-icons/*.svg
//   src/renderer/src/lib/fileIconMap.ts
//
// 上游 MIT,LICENSE 一并抄进 assets/file-icons/。升级 = 改 package.json 的版本
// 再跑一遍这个脚本,不手改产物。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = dirname(require.resolve("material-icon-theme/package.json"));
const theme = JSON.parse(readFileSync(join(pkgDir, "dist/material-icons.json"), "utf8"));

/**
 * 抄哪些图标：**上游文件类型表里点到名的全都抄**（后缀表 + 文件名表的并集，
 * 584 枚里实际存在的 564 枚，约 460KB）。
 *
 * 曾经只挑了 68 枚"常见类型"，理由是"上游那包 5MB 太重"——那个 5MB 是 `du` 报的
 * 磁盘块数（1250 个几百字节的小文件，每个占满一个 4KB 块），真实字节是 1MB，
 * 而其中**文件类型**那部分只有 460KB（另外那些是文件夹图标和明暗变体，本仓用不上）。
 * 按一个数错了一个量级的数去砍功能，砍掉的是这个功能本来的价值：手工挑的那 68 枚
 * 覆盖的是"我想得到的类型"，而用户打开的是他自己的工程 —— .zig / .astro / .ex /
 * .tf 落进通用图标时，退化恰好发生在这个功能最该起作用的地方。
 *
 * 代价按真实数算：图标不进主包（见 electron.vite.config.ts 里 file-icons 那条
 * assetsInlineLimit），各自留在磁盘上，界面上出现哪枚才读哪枚；进包的只有一张
 * 地址表和对照表，合计约 120KB。
 *
 * 仍然不抄的：文件夹图标（本仓没有文件树）、_light/明暗变体（本仓两套主题共用
 * 同一枚彩色图标）、克隆变体。
 */
const KEEP = [...new Set([
  ...Object.values(theme.fileExtensions ?? {}),
  ...Object.values(theme.fileNames ?? {}),
  // 兜底那两枚:上游的默认文件/文件夹图标不在上面两张表里
  theme.file,
  theme.folder,
])]
  // 上游有 20 来条指向 icons/ 里并不存在的名字(克隆/变体的产物)。
  // 抄不过来的直接不要 —— 对照表下面会跟着筛掉,不会留下指向 404 的条目
  .filter((name) => existsSync(join(pkgDir, `icons/${name}.svg`)))
  .sort();

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
