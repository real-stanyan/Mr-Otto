// src/shared/mcpCatalogFill.ts
// 目录条目 + 参数值 → http 连接要用的 url 与请求头（#1430 从 renderer/lib/mcpDirectory.ts 抽出）。
// 两个消费方：桌面装一台（configFromEntry）与 edge 替手机接一台（pxCloudOps）。**判据只能有一份**——
// 桌面能连上的一台，手机那边代出来的地址差一个字就是一次莫名其妙的 401。规矩原样照搬：请求头只从
// headerTemplates 生成、键是真实请求头名；空值与代完仍带 {占位符} 的一律不落。
import type { CatalogEntry } from "./mcpCatalog.js";

export function fillHttpEntry(
  entry: CatalogEntry,
  values: Readonly<Record<string, string>>
): { url: string; headers: Record<string, string> } {
  const fill = (text: string): string =>
    text.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const v = values[name];
      return v === undefined || v === "" ? whole : v;
    });
  const hasHole = (text: string): boolean => /\{\w+\}/.test(text);
  const headers: Record<string, string> = {};
  for (const [headerName, template] of Object.entries(entry.headerTemplates ?? {})) {
    const value = fill(template);
    if (value === "" || hasHole(value)) continue;
    headers[headerName] = value;
  }
  return { url: fill(entry.url ?? ""), headers };
}

/** 必填但空（含全空白）的参数名，按目录顺序 */
export function missingParams(entry: CatalogEntry, values: Readonly<Record<string, string>>): string[] {
  return entry.params.filter((p) => p.required && (values[p.name] ?? "").trim() === "").map((p) => p.name);
}
