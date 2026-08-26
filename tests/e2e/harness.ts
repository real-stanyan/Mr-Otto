// e2e 的开机手续：起一只**与这台机器上真实用户数据完全隔离**的 Otto。
//
// 隔离是这一层能不能写验收用例的前提，不是洁癖：#142 / #147 的清单里有
// 「新建一个子智能体，确认文件落在 ~/.mr-otto/agents/」这种条目 —— 照字面跑，
// 测试就会往开发者本人的配置目录里丢文件、甚至覆盖同名的那份。所以：
//
//   1. `HOME` 换成一次性临时目录。主进程读配置一律走 `configDir(homedir())`，
//      而 node 的 `os.homedir()` 在 POSIX 上优先认 `$HOME` —— 换掉它，
//      `~/.mr-otto/agents`、`~/.claude/agents`、skills 全部跟着搬进临时目录。
//      （注意 Electron 自己的 `app.getPath("home")` **不认** `$HOME`，它走
//      NSHomeDirectory；所以 userData 得另外用 OTTO_PROFILE 隔离，见下。）
//   2. `OTTO_PROFILE` 每次起一个新的随机值 → userData 目录（sessions.db、
//      auth.json）也是新的。跑完删掉。共用一个 e2e profile 的话，上一次跑剩下的
//      会话会漏进下一次的侧栏，用例之间就有了顺序依赖。
//
// 不碰网络、不碰模型：没有 key 就没有出网的路。要验「派活」那一段的用例自己起
// 一个假模型服务（fakeModel.ts），端点用 provider 的 `*_BASE_URL` 环境变量顶掉。

import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = join(ROOT, "out", "main", "index.js");

/** 配置目录名。和 src/main/configDir.ts 的 CONFIG_DIR 是同一个字符串，但这里
    刻意重写一遍而不是 import：e2e 是黑盒，它该按「用户看到的路径」断言，
    产品把目录改名了就该在这里红一次，而不是跟着一起改、悄悄继续绿 */
export const CONFIG_DIR = ".mr-otto";

export interface SubagentSeed {
  name: string;
  description?: string;
  tools?: string;
  approval?: string;
  model?: string;
  /** frontmatter 之后的正文 */
  body?: string;
  /** 直接给全文（给「手写一份畸形 .md」这类用例用），给了就忽略上面所有字段 */
  raw?: string;
}

export interface SkillSeed {
  name: string;
  description?: string;
  /** frontmatter 之后的正文（注入进上下文的就是它） */
  body?: string;
}

export interface LaunchOptions {
  /** 播进 `$HOME/.mr-otto/agents/` 的定义 */
  userAgents?: SubagentSeed[];
  /** 播进 `$HOME/.mr-otto/skills/<名字>/SKILL.md` 的 skill */
  skills?: SkillSeed[];
  /** 播进 `$HOME/.claude/agents/` 的定义（只读那一层） */
  claudeAgents?: SubagentSeed[];
  /** 追加/覆盖环境变量（假模型端点、key 之类） */
  env?: Record<string, string>;
  /** 起打好包的那个 .app 而不是 out/ 里的产物（见 PACKAGED_APP） */
  packaged?: boolean;
  /** 复用一份现成的 HOME + Electron profile（app 重启后还是同一台机器、同一份库）。
      给了就**不在 close() 里删**——两只共用同一份目录，谁都不该抢着删；
      清理归用例自己（`rmSync(otto.home)` + `rmSync(otto.userData)`）。
      resume 这类"重启之后会怎样"的用例要它：不重启的话 resumeSession 走的是
      "agent 还在内存里，只切视线"那条路，压根到不了 createChildAgent */
  home?: string;
  profile?: string;
}

/** electron-builder 产出的 .app 里的可执行文件。`npm run dist:mac` 跑过才有；
    没有就让用例自己 skip —— 打一次包要几分钟，不该变成跑 e2e 的前置条件 */
export const PACKAGED_APP = join(
  ROOT,
  "dist",
  "mac-arm64",
  "Mr Otto.app",
  "Contents",
  "MacOS",
  "Mr Otto"
);

export interface Otto {
  app: ElectronApplication;
  win: Page;
  /** 这一只的临时 HOME */
  home: string;
  /** 渲染层的 pageerror / console.error，收在这儿，收尾时断言为空 */
  errors: string[];
  /** `$HOME/.mr-otto/agents` */
  userAgentsDir: string;
  /** Electron 的 userData（sessions.db 在里面）。删会话那类用例要直接查库 */
  userData: string;
  /** 这一只的 OTTO_PROFILE。重启复用同一份库时要原样传回去（LaunchOptions.profile） */
  profile: string;
  /** 关窗 + 删临时目录。用例用 try/finally 保证它跑到 */
  close(): Promise<void>;
}

export function subagentFile(seed: SubagentSeed): string {
  if (seed.raw !== undefined) return seed.raw;
  const fm = [`name: ${seed.name}`];
  if (seed.description !== undefined) fm.push(`description: ${seed.description}`);
  if (seed.tools !== undefined) fm.push(`tools: ${seed.tools}`);
  if (seed.approval !== undefined) fm.push(`approval: ${seed.approval}`);
  if (seed.model !== undefined) fm.push(`model: ${seed.model}`);
  return `---\n${fm.join("\n")}\n---\n\n${seed.body ?? "测试用子智能体。"}\n`;
}

function seedInto(dir: string, seeds: SubagentSeed[] | undefined): void {
  if (!seeds?.length) return;
  mkdirSync(dir, { recursive: true });
  for (const s of seeds) writeFileSync(join(dir, `${s.name}.md`), subagentFile(s));
}

/** skill 是**目录**不是单文件（`<根>/<名字>/SKILL.md`），所以不能跟 agent 共用
    seedInto。名字用目录名和 frontmatter 两处写同一个 —— 产品取 frontmatter，
    目录名只是路径 */
function seedSkills(root: string, seeds: SkillSeed[] | undefined): void {
  if (!seeds?.length) return;
  for (const s of seeds) {
    const dir = join(root, s.name);
    mkdirSync(dir, { recursive: true });
    const fm = [`name: ${s.name}`, `description: ${s.description ?? "测试用 skill。"}`];
    writeFileSync(join(dir, "SKILL.md"), `---\n${fm.join("\n")}\n---\n\n${s.body ?? "测试用 skill 正文。"}\n`);
  }
}

export async function launchOtto(opts: LaunchOptions = {}): Promise<Otto> {
  if (!opts.packaged) {
    expect(existsSync(MAIN), "先 npm run build —— e2e 跑的是 out/ 里的产物").toBe(true);
  }

  // 自己造的才自己删（见 LaunchOptions.home）
  const own = opts.home === undefined;
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "otto-e2e-home-"));
  const profile = opts.profile ?? `e2e${randomBytes(4).toString("hex")}`;
  const userAgentsDir = join(home, CONFIG_DIR, "agents");
  seedInto(userAgentsDir, opts.userAgents);
  seedInto(join(home, ".claude", "agents"), opts.claudeAgents);
  seedSkills(join(home, CONFIG_DIR, "skills"), opts.skills);

  const app = await electron.launch({
    // 打好包的那一只从自己的 asar 里读入口，不能再把仓库根塞给它
    ...(opts.packaged ? { executablePath: PACKAGED_APP, args: [] } : { args: [ROOT] }),
    cwd: ROOT,
    env: { ...process.env, ...opts.env, HOME: home, OTTO_PROFILE: profile },
  });
  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  const errors: string[] = [];
  const win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  win.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  await win.waitForLoadState("domcontentloaded");
  // 启动画面盖在最上面时点什么都点不着（splash.e2e.ts 断言过它会自己退场）
  await expect(win.getByTestId("splash")).toHaveCount(0, { timeout: 20_000 });

  return {
    app,
    win,
    home,
    errors,
    userAgentsDir,
    userData,
    profile,
    async close() {
      await app.close().catch(() => {});
      if (!own) return; // 复用的那份归用例清，见 LaunchOptions.home
      rmSync(home, { recursive: true, force: true });
      // userData 落在真实 ~/Library/Application Support（Electron 不认 $HOME），
      // 名字带随机后缀，不删就每跑一次攒一个
      if (userData.includes(profile)) rmSync(userData, { recursive: true, force: true });
    },
  };
}

/** 渲染层零异常。放在每个用例的收尾：一条 console.error 往往就是某个 IPC 悄悄失败了 */
export function expectNoRendererErrors(otto: Otto): void {
  expect(otto.errors, `渲染层有异常：\n  ${otto.errors.join("\n  ")}`).toEqual([]);
}

/** 打开设置页的某一栏。齿轮在侧栏页脚，点它先落在「模型配置」，再点左侧栏目 */
export async function openSettings(win: Page, section: string): Promise<void> {
  await win.getByRole("button", { name: "设置" }).click();
  await win.getByRole("button", { name: section, exact: true }).click();
}

/** 把系统文件夹选择框换成「直接返回这个路径」。
    Playwright 驱动不了原生 dialog，而「工作区」是作用域用例的全部前提；
    这是**唯一**一处用打桩绕开真实交互的地方，绕开的也只是 macOS 的那张框，
    框之后的每一步（IPC、白名单、落盘路径）跑的都是真代码 */
export async function stubFolderPicker(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, dir);
}

/** 在某个文件夹里开一条会话 —— 作用域用例的前提：设置页那个下拉的候选来自
    「有过会话的工程」（subagentScopes.ts），没有会话就没有那一层可选。
    模型这一步会失败（没有 key，也不该有），但会话本身在发请求之前就已经建好、
    workspace 也已经进了白名单，作用域用例要的就是这个。 */
export async function startSession(otto: Otto, workspace: string, text = "开个会话"): Promise<void> {
  await stubFolderPicker(otto.app, workspace);
  await otto.win.getByRole("button", { name: "选择工作区" }).click();
  await otto.win.getByRole("button", { name: "打开文件夹…" }).click();
  await otto.win.getByRole("textbox", { name: /描述任务/ }).fill(text);
  await otto.win.getByRole("button", { name: "开始会话" }).click();
  // 会话头部出现 = 已落盘
  await expect(otto.win.getByRole("tab", { name: "对话" })).toBeVisible({ timeout: 15_000 });
}

/** 切设置页那个作用域下拉。radix Select 不是原生 <select>，选项在 portal 里 */
export async function selectScope(win: Page, label: string): Promise<void> {
  await win.getByRole("combobox", { name: "作用域" }).click();
  await win.getByRole("option", { name: label }).click();
}
