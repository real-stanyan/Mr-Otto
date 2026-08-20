// 路径 → 文件类型图标名。对照表是生成的（fileIconMap.ts，来自 material-icon-theme），
// 这里是**怎么查**那张表 —— 单独拿出来是因为查法本身有几处会出错的地方，得能验。
//
// 查法照抄 VS Code 的规矩：
//   ① 整个文件名优先（package.json 是 nodejs，不是 json）
//   ② 再按后缀，**从长到短**（foo.test.ts 是 test-ts，不是 typescript）
//   ③ 都认不出 → 通用文件图标。认不出就说认不出，不猜

import { BY_EXTENSION, BY_NAME } from "./fileIconMap.js";

/** 认不出时用它。assets/file-icons/file.svg */
export const DEFAULT_FILE_ICON = "file";

/** 目录用的那枚 */
export const FOLDER_ICON = "folder";

/** 从路径里取文件名。两种分隔符都认：路径可能来自 Windows 侧的工具输出 */
function basename(input: string): string {
  const parts = input.split(/[\\/]/).filter((p) => p !== "");
  return parts.at(-1) ?? "";
}

export function fileIconName(input: string): string {
  const base = basename(input);
  if (base === "") return DEFAULT_FILE_ICON;

  // 先按整名。上游表里少数键是大写的（APKBUILD、COMMIT_EDITMSG），所以原样先查一次
  const named = BY_NAME[base] ?? BY_NAME[base.toLowerCase()];
  if (named) return named;

  const parts = base.toLowerCase().split(".");
  // 从最长的后缀往短了试：docker-compose.yml 要压过 yml，test.ts 要压过 ts。
  // 点号开头的文件第一段是空串，从下标 1 起正好跳过它：.env 的后缀就是 env
  // （照上游的读法 —— VS Code 里 .env 拿的正是 env 那枚齿轮）。
  // 代价是 ".ts" 这种"整个名字就是个后缀"的怪文件也会被认成 ts，与上游一致
  for (let i = 1; i < parts.length; i++) {
    const icon = BY_EXTENSION[parts.slice(i).join(".")];
    if (icon) return icon;
  }
  return DEFAULT_FILE_ICON;
}
