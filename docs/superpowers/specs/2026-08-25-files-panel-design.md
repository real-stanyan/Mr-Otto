# 右侧栏 Files 面板设计

日期：2026-08-25
状态：已由 stanyan 会话内批准（设计段落 + 两处拍板：搜索默认尊重 .gitignore、快捷键 ⌘⇧E）
Issue：#400

## 背景与约束

对照物是 Claude Code 桌面端的 Files 面板：一棵工作区文件树、一个过滤框（`?` 前缀切内容搜索）、每种文件格式各自的彩色图标。

现状盘点：

- **图标全都是现成的**：`src/renderer/src/assets/file-icons/`（material-icon-theme@5.37.0，MIT，`scripts/gen-file-icons.mjs` 生成 `lib/fileIconMap.ts`）+ `components/FileTypeIcon.tsx` / `FolderIcon`。今天只用在"路径顺带出现"的地方（工具行、附件、diff 头），没有一个地方能主动浏览工作区。
- **右侧槽位宿主是现成的**：`App.tsx` 里 `panel` 那条链（friendChat / browser / terminal / gitGraph / protocol 五选一），半屏可拖（`ResizablePanelGroup`，`autoSaveId="otter-side-panel"`）、可全屏（`panelWide`）、位置记 localStorage。加第 6 个视图 = 加一个互斥布尔。
- **预览的渲染器是现成的**：`ProtocolView.tsx` 用 `react-markdown` + `remark-gfm` + `rehype-highlight`。
- **文件通道一条都没有**：`ShellBridge` 里唯一沾文件的是 `intakePastedFiles`（附件入库），没有列目录、没有读文件、没有搜索。这是本设计的主要新增面。

约束：

- 硬规则：渲染进程只走 `ShellBridge`，不 import Node/Electron（`tests/architecture.test.ts` 第 2 条门禁钉着）。
- 硬规则：工具实现只依赖 `ExecutionWorld`。**本面板不是 agent 工具**，是 app 功能，主进程直用 `fs`/`child_process` 合规——同 `protocolService.ts`（Protocol 仪表盘）、`skills.ts`、SQLite 日志的先例。门禁只管 `src/tools`。
- 面板是**纯人用的旁路**：读到的内容不进事件日志、不进模型上下文（同终端面板 ADR-0031）。想让 Otto 看某个文件，用行内的 `@` 动作把路径塞进 composer，由 agent 自己走 read 工具——那条路径才有日志。

## 决策

### D1 懒加载，一次列一层

树**全显**（`node_modules` / `out` / `test-results` / 点文件都列，跟对照物一致）。全显要不卡，唯一的办法是不一次扫全树：展开哪个目录才列哪个目录，一次 IPC 一层。

否掉的两条：开面板扫全树（几万条，面板卡死）；`rg --files` 一次拿全路径前端建树（`--no-ignore` 下同样几万条，且渲染进程要一直拿着这份表）。

### D2 搜索跟树一样全显（真机试用后推翻原方案）

起草时定的是"搜索默认尊重 `.gitignore` + 面板头给个开关"。真机上试出两个毛病：面板里两套规矩，"树里看得见、搜不出来"要解释；那个开关只有一个真实取值，开一次就不会关回去，是个死旋钮。改成一条规矩管两处：`rg --no-ignore --hidden`。体量靠结果上限（名字 500 / 内容 200）控，不靠忽略规则。

### D3 ripgrep 优先，缺失降级

有 `rg` 用 `rg`（快、`--json` 输出好解析、`.gitignore` 语义免费）；没装退回 Node 遍历（同样的过滤规则，靠一份内置忽略名单近似，不解析 `.gitignore`）。降级要显式：面板头标一行"未装 ripgrep，搜索已降级"，别让人以为结果就是全部。

### D4 点文件 = 面板内预览；`@` 引用和外部打开是行内动作

三种行为都要，但主次分明：单击预览（最高频、不离开 Otto）；hover 出的两个小按钮和右键菜单给 `@` 塞 composer、外部程序打开、复制相对路径。

## 组件

### 1. `src/shared/files.ts`（纯逻辑，零 IO）

主进程和测试共用。内容：

- 类型：`FileEntry { name: string; kind: "dir" | "file"; size: number; mtime: number }`、`FileHit { rel: string; line?: number; text?: string }`、`FilesErrorKind = "no-dir" | "denied" | "outside-root" | "too-large" | "binary"`、`FilesResult<T>` 判别联合（照抄 `shared/gitGraph.ts` 的 `GitLogResult` 形状）。
- `sortEntries(entries)`：目录在前，同类按名字 `localeCompare`（数字感知），点文件不特殊对待（全显，不下沉）。
- `matchesFilter(rel, query)`：子序列 fuzzy（`fic` 命中 `src/lib/fileIcon.ts`），大小写不敏感，返回命中区间供高亮。
- `parseRgJson(stdout)`：`rg --json` 的 NDJSON → `FileHit[]`，只认 `type: "match"` 行。
- `classifyRgError(err)`：`ENOENT` → `rg-missing`；退出码 1（无匹配）→ 空结果不是错误；其它 → `search-error`。
- `isBinaryish(buf)`：头 8KB 含 NUL 字节即判二进制。

### 2. `src/main/filesService.ts`

依赖注入照抄 `protocolService.ts`：一个 `FilesDeps` 接口（`listDir` / `readFileBuf` / `realpath` / `execRg`），`nodeDeps` 是真实现，测试喂假的。

四个能力：

- `list(root, relDir)` → `FilesResult<FileEntry[]>`。`withFileTypes` 一次拿类型，`stat` 拿 size/mtime；符号链接按其目标类型归类，读不到目标就当文件。
- `search(root, query, opts)` → `FilesResult<FileHit[]>`。`opts = { content: boolean; includeIgnored: boolean }`。名字模式：`rg --files`（`--no-ignore --hidden` 当 `includeIgnored`）拿路径表，`matchesFilter` 在主进程侧筛，上限 500 条。内容模式：`rg --json -n --max-count 5 -- <query>`，上限 200 条命中。
- `read(root, rel)` → `FilesResult<{ text: string; truncated: boolean }>`。见下面的安全边界。
- `reveal(root, rel, how)`：`how = "open" | "folder"` → `shell.openPath` / `shell.showItemInFolder`。同样过一遍根内校验。

**安全边界**（三条都要有测试）：

1. `resolve(root, rel)` 之后再 `realpath`，结果必须仍以 `root + sep` 开头，否则 `outside-root`。挡的是 `../` 和指向根外的符号链接。
2. 预览 >512KB 截断（读前先 `stat`，只读前 512KB），返回 `truncated: true`，UI 标"已截断"。
3. 二进制不预览：`isBinaryish` 命中就返回 `binary` + 大小，UI 显示"二进制文件 · 1.2 MB"和一个"用外部程序打开"。

### 3. 通道（四条）

`src/shared/shellBridge.ts` 加方法 + `CHANNELS` 条目，`src/preload/index.ts` 转发，`src/main/index.ts` 注册 `ipcMain.handle`：

```
filesList(root: string, relDir: string): Promise<FilesResult<FileEntry[]>>
filesSearch(root: string, query: string, opts: FilesSearchOpts): Promise<FilesResult<FileHit[]>>
filesRead(root: string, rel: string): Promise<FilesResult<FilePreview>>
filesReveal(root: string, rel: string, how: "open" | "folder"): Promise<void>
```

### 4. `src/renderer/src/components/FilesView.tsx`

根 = 当前会话的 `workspace`。切会话 = 换根 + 清树。

- **头部**（同 `TerminalView` 那排）：`SidebarNub` + 标题 `Files` + 「含忽略文件」`Switch` + 展开/收起（`Maximize2`/`Minimize2`）+ 关（`X`）。
- **过滤框**：`Input`，占位符 `过滤文件… (?文本 搜索内容)`。空 = 显示树；非空且不以 `?` 开头 = 文件名模式（结果列表，不是树）；以 `?` 开头 = 内容模式（按文件分组的命中列表，每条带行号和该行文本）。输入去抖 150ms。
- **树**：受控展开集合 `Set<string>`（相对路径），展开一个目录才发一次 `filesList` 并缓存；折叠不丢缓存，再展开不重发。行 = `ChevronRight`/`ChevronDown`（目录）或 16px 占位（文件）+ `FolderIcon`/`FileTypeIcon` + 名字。缩进按深度 × 12px。
- **预览区**：面板下半（可拖分割？**不做**，见"明确不做"）。用 `react-markdown` + `rehype-highlight` 渲染；`.md` 直接当 markdown 渲染，其它一律包进 ```` ```<lang> ```` 代码围栏，`lang` 由后缀映射（复用 `fileIcon.ts` 那张表的思路，但另建一张小的 后缀→hljs 语言 表，两者语义不同：图标名 ≠ 语言名）。
- **行内动作**（hover 出现 + 右键菜单同款）：`@` 塞 composer（走 store 的 composer draft）、外部打开、在 Finder 中显示、复制相对路径。

### 5. store 与入口

- `store.ts`：加 `filesPanelOpen: boolean` + `openFilesPanel()` / `closeFilesPanel()`。互斥集合有 6 处（`openSettings` 的四个分支、`openProtocol`、`openGitGraph`、`openTerminalPanel`、`openBrowserPanel`、`openFriendChat`）要各加一个 `filesPanelOpen: false`——**这是本次最容易漏的一处**，e2e 里钉一条"开 Files 再开终端，Files 关掉"。
- `App.tsx`：`panel` 链加一档（排在 `protocolOpen` 之前）；头部「更多」菜单加一项 `<FolderOpen /> 文件`。
- 快捷键 `⌘⇧E`（VS Code 肌肉记忆）：挂 `window` 的 keydown，照 `⌃\`` 那条终端快捷键的写法，开/关切换。

## 数据流

```
用户展开目录 → FilesView 发 filesList(root, rel)
  → preload → ipcMain → filesService.list → fs.readdirSync
  → FilesResult<FileEntry[]> 回渲染层 → 存进 Map<rel, FileEntry[]> → 渲染子行

用户打 ?foo → 去抖 150ms → filesSearch(root, "foo", {content:true, includeIgnored})
  → filesService.search → execFile("rg", ["--json", ...]) → parseRgJson
  → FileHit[] → 按 rel 分组渲染

用户点文件 → filesRead(root, rel) → 根内校验 → stat → 读（≤512KB）→ 二进制判定
  → { text, truncated } → 预览区渲染
```

## 错误处理

每条通道都返回判别联合，不抛。UI 一律就地显示，不弹 toast：

- `no-dir`（目录被删/改名）：那一行标灰 + "目录不存在"，并把它从缓存里摘掉。
- `denied`：行内标"无权限"，不重试。
- `rg-missing`：面板头一行提示"未装 ripgrep，搜索已降级"，结果照常出（Node 降级路径）。
- `outside-root`：这是 bug 或恶意路径，不给用户看细节，只显示"无法打开"，主进程 `console.warn` 留痕。
- `too-large` / `binary`：不是错误，是预览区的两种正常状态。

## 测试

- `tests/shared/files.test.ts`：`sortEntries`（目录优先、数字感知、点文件不下沉）、`matchesFilter`（子序列命中/区间/大小写）、`parseRgJson`（多行 NDJSON、非 match 行忽略、坏行不炸）、`classifyRgError`（ENOENT / 退出码 1 / 其它）、`isBinaryish`。
- `tests/main/filesService.test.ts`：假 deps。重点是三条安全边界（`../` 越狱、符号链接指向根外、>512KB 截断）、`rg` 缺失降级、`rg` 退出码 1 = 空结果不是错误。
- `tests/e2e/files.e2e.ts`（照 `terminal.e2e.ts` 的套路，换 `HOME` 隔离 + `fakeModel`）：开面板 → 展开一层 → 点文件出预览 → 开终端面板确认 Files 被互斥关掉。

## 明确不做（YAGNI）

- **不做文件编辑**。面板只读。写文件是 agent 的活（有日志、有审批），面板里加一个绕过日志的写入口，等于开一条事实来源之外的旁路。
- **不做预览区可拖分割**。固定上下 60/40，先用着；真嫌小就全屏面板。
- **不做多根 / 多工作区**。根就是当前会话的 workspace，跟会话走。
- **不做文件监听（fs.watch）**。手动刷新按钮 + 展开时重取就够；监听全显的树等于监听 `node_modules`。
- **不做拖拽上传/移动/重命名**。同"不做编辑"。
