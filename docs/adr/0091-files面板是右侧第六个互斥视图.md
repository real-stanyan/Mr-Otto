# ADR-0091: Files 面板是右侧第六个互斥视图，全显树 + 懒加载，严格只读

日期：2026-08-25
状态：已接受
关联：ADR-0031（终端面板是纯人用旁路，本决定把同一条边界推广到文件浏览）、ADR-0001（渲染层只走 ShellBridge）、ADR-0014（git 写操作的唯一例外，本决定不新增例外）

## 背景

对照 Claude Code 桌面端的 Files 面板：一棵工作区文件树、一个过滤框（`?` 前缀切内容搜索）、每种文件格式各自的彩色图标。

Otto 这边有一半是现成的：图标那套（material-icon-theme@5.37.0，68+ 枚，`assets/file-icons/` + `components/FileTypeIcon.tsx`）早就抄进仓了，但只在"路径顺带出现"的地方用（工具行、附件、diff 头）。**没有一个地方能主动浏览工作区**——想知道 agent 面前摆着什么文件，只能开终端 `ls` 或者问它。

缺的是后端：`ShellBridge` 此前一条文件通道都没有（唯一沾边的 `intakePastedFiles` 是附件入库）。

## 决定

1. **占右侧槽位的第 6 个位置，与其它 5 个视图互斥**（Protocol / Git Graph / 终端 / 浏览器 / DM）。不新开一列：右侧只有一块地方，两块并排会把会话区挤没，而会话才是主体。代价是 Files 和终端不能同屏——接受，两者都是旁路工具，同时要看的场景稀少。

2. **树全显，但一次只列一层**。`node_modules` / `out` / 点文件都列（跟对照物一致，也跟"我要找的就是那个被忽略的文件"这个真实需求一致）。全显要不卡，唯一的办法是懒加载：展开哪个目录才发一次 `filesList`。否掉的两条——开面板扫全树（几万条，面板卡死）、`rg --files` 一次拿全路径前端建树（`--no-ignore` 下同样几万条）。

3. **搜索跟树一样全显**：被 `.gitignore` 忽略的、隐藏的一并搜（`rg --no-ignore --hidden`）。

   这条推翻了本 ADR 起草时的方案（"搜索默认尊重 `.gitignore`，面板头给个开关"）——那个方案在真机上试出两个毛病：一是**面板里两套规矩**，"树里看得见、搜不出来"是个要解释的怪现象；二是那个开关只有一个真实取值，用户开一次就再也不会关回去，留着只是个死旋钮。体量不靠忽略规则控，靠结果上限（名字 500 / 内容 200）。

4. **ripgrep 优先，缺失降级，且降级要显式标出来**。有 `rg` 用 `rg`（快、`--json` 好解析、`.gitignore` 语义免费）。没装时面板头标一行"未装 ripgrep，搜索已降级"——不标的话用户会把空结果读成"仓里没有"。

5. **严格只读，且读到的内容不进事件日志、不进模型上下文**（ADR-0031 的同一条边界）。面板不提供任何写文件的通道：写是 agent 的活，有日志有审批；面板里开一个写入口等于开一条事实来源之外的旁路。想让 Otto 看某个文件，行内的 `@` 动作只把**路径**塞进 composer，由 agent 自己走 read 工具——那一次才有日志。

6. **主进程直用 fs / child_process 合规**，不经 `ExecutionWorld`。这是 app 功能不是 agent 工具，同 `protocolService` / `gitGraphService` / SQLite 日志的先例；架构门禁（`tests/architecture.test.ts`）管的是 `src/tools`。`filesService.ts` 刻意也不 import electron——`shell.openPath` / `showItemInFolder` 由 `index.ts` 注入（同 browserHub 的 `webContentsViewFactory`），否则模块在 vitest 里加载不起来，三条安全边界就没法在单测里钉。

7. **「用编辑器打开」给候选，不替用户决定**：那颗外部打开按钮是个下拉菜单，列出本机装了的编辑器（固定名单探 `/Applications` 与 `~/Applications`）+ 系统默认 + 在访达中显示。每次点都弹菜单，不记忆上次选择——同一个人对不同文件用不同编辑器是常态（`.md` 用一个、`.ts` 用另一个），记忆只会让人不断地改回来。名单是主进程探出来的，`reveal` 只认名单里的名字，渲染层塞别的字符串进不了 `open -a`。

   菜单里每条带 app 自己那枚图标：图标取自 bundle 内的 `.icns`（`plutil` 读 `CFBundleIconFile`，`sips` 转 png，内嵌成 data URI），**不用** electron 的 `app.getFileIcon`——后者对 `.app` 包回的是通用占位图，三个编辑器长成一个样，等于没有图标。

## 权衡与后果

- **多一条 ripgrep 的软依赖**。缺失时降级到 Node 遍历，功能不断，只是慢且忽略规则只能近似。
- **面板与 agent 看到的内容可能不同步**：不做 `fs.watch`（监听一棵全显的树等于监听 `node_modules`），靠展开时重取 + 刷新按钮。
- **路径校验的第二道比的是解过的根**：macOS 的 `/var/folders/...` 本身就是 `/private/var` 的软链，拿字面根去比会把整个工作区判成越狱。这条是 e2e 抓出来的，现在有单测钉着（`tests/main/filesService.test.ts`）。
- **预览 >512KB 截断、二进制不预览**：面板是浏览器不是编辑器，把 200MB 的 log 整个塞进渲染进程没有收益。
