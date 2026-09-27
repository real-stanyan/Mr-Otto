// 从 lucide-react（桌面在用的那一套图标，ISC）抽出手机端要的几十个图标，写成
// mobile/src/wx/iconNodes.ts（#1386）。手机上不为图标加依赖：react-native-svg 已经在，
// 把 lucide 的 [标签, 属性] 节点原样搬过来就画得出来，和桌面、demo 是同一套形状。
//
//   node mobile/scripts/gen-icons.mjs
//
// 生成物提交进仓；要加一个图标就在 NAMES 里加一个名字再跑一遍。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const dir = join(root, "node_modules", "lucide-react", "dist", "esm", "icons");
const version = JSON.parse(readFileSync(join(root, "node_modules", "lucide-react", "package.json"), "utf8")).version;

const NAMES = [
  "message-circle", "contact-round", "user-round", "circle-plus", "search", "sparkles", "users-round", "user-round-plus",
  "chevron-right", "chevron-left", "chevron-down", "ellipsis", "audio-lines", "keyboard", "smile", "phone", "phone-off",
  "mic", "mic-off", "type", "at-sign", "plus", "x", "folder", "file-text", "blocks", "book-open", "chart-column",
  "settings", "gauge", "check", "app-window", "square", "user-round-minus", "log-out", "mail", "lock-keyhole", "image",
  "trash-2", "pencil", "info", "shield-check", "circle-alert",
];

/** 一个图标文件里的 __iconNode（有的文件是别名：只 re-export 另一个图标，跟过去） */
function nodesOf(name, depth = 0) {
  const src = readFileSync(join(dir, `${name}.mjs`), "utf8");
  const m = src.match(/const __iconNode = (\[[\s\S]*?\]);\s*\nconst /);
  if (m) return Function(`"use strict"; return (${m[1]});`)();
  const alias = src.match(/from '\.\/([a-z0-9-]+)\.mjs'/);
  if (alias && depth < 3) return nodesOf(alias[1], depth + 1);
  throw new Error(`读不出 ${name} 的 __iconNode`);
}

const out = {};
for (const name of NAMES) {
  out[name] = nodesOf(name).map(([tag, attrs]) => {
    const { key: _key, ...rest } = attrs;
    return [tag, rest];
  });
}

const body = `// 生成物：node mobile/scripts/gen-icons.mjs（#1386）。别手改——加图标去改脚本里的 NAMES。
// 形状来自 lucide-react v${version}（ISC），与桌面、demo 同一套。
/* eslint-disable */
export type IconTag = "path" | "circle" | "rect" | "line" | "polyline" | "ellipse";
export type IconNode = readonly [IconTag, Readonly<Record<string, string | number>>];

export const ICON_NODES = ${JSON.stringify(out, null, 1)} as const satisfies Record<string, readonly IconNode[]>;

export type IconName = keyof typeof ICON_NODES;
`;
writeFileSync(join(root, "mobile", "src", "wx", "iconNodes.ts"), body);
console.log("wrote", Object.keys(out).length, "icons");
