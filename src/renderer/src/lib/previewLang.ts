// 后缀 → highlight.js 语言名(Files 面板的预览区用)。
//
// 为什么不复用 lib/fileIcon.ts 那张表:那张表回的是**图标名**,和语言名
// 只是碰巧有时候一样(react_ts / test-ts / json_schema 都不是语言)。
// 喂 rehype-highlight 一个它不认识的语言,那段代码会整块掉回无高亮。
// 认不出就回空串,让它自己猜。

const BY_EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "json",
  css: "css", scss: "scss", less: "less", html: "xml", xml: "xml", svg: "xml",
  md: "markdown", markdown: "markdown",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
  swift: "swift", kt: "kotlin", php: "php", cs: "csharp",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  sql: "sql", graphql: "graphql", lua: "lua",
};

const BY_NAME: Record<string, string> = {
  makefile: "makefile",
  dockerfile: "dockerfile",
  ".gitignore": "bash",
};

export function previewLang(path: string): string {
  const base = path.split(/[\\/]/).at(-1) ?? "";
  const named = BY_NAME[base.toLowerCase()];
  if (named !== undefined) return named;
  const parts = base.toLowerCase().split(".");
  if (parts.length < 2) return "";
  return BY_EXT[parts.at(-1) ?? ""] ?? "";
}
