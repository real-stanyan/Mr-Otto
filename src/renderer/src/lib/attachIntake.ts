// 粘贴/拖拽拿到的 File → 主进程闸门要的字节包。
// 两条入口(clipboardData / dataTransfer)给的都是 File 列表,所以只有一个转换函数。

/** dragover 阶段 `dataTransfer.files` 一定是空的(浏览器要到 drop 才交出文件),
    想知道"拖进来的是不是文件"只能看 types 里有没有 "Files"。
    纯函数化是为了能测:拖拽事件在测试里造不出来,这条判断能 */
export function dragHasFiles(types: readonly string[] | undefined): boolean {
  return (types ?? []).includes("Files");
}

/** File[] → { name, data }[]。名字只用于展示和拒收文案;
    截图的 File 常常没名字或叫 "image.png",兜一个人能读的 */
export async function filesToPayload(files: File[]): Promise<{ name: string; data: Uint8Array }[]> {
  return Promise.all(
    files.map(async (f) => ({
      name: f.name || `粘贴的${f.type.startsWith("image/") ? "图片" : "文件"}`,
      data: new Uint8Array(await f.arrayBuffer()),
    }))
  );
}
