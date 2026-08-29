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
//   3. 模型凭据从环境里抹掉（blankCredentials）。前两条挡不住主进程开机时
//      读仓库根的 `.env` —— Playwright 起 Electron 的 cwd 就是仓库根，
//      开发者本机那把真 key 会原样进来（#480）。
//
// 三条齐了才谈得上「不碰网络、不碰模型」。要验「派活」那一段的用例自己起
// 一个假模型服务（fakeModel.ts），端点用 provider 的 `*_BASE_URL` 环境变量顶掉。

import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { providerKeyEnvs } from "../../src/shared/providerCatalog.js";
import { profileDirName } from "../../src/main/profile.js";
import { ACCOUNTS_DIR, accountDirName } from "../../src/main/accountScope.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = join(ROOT, "out", "main", "index.js");

/** 配置目录名。和 src/main/configDir.ts 的 CONFIG_DIR 是同一个字符串，但这里
    刻意重写一遍而不是 import：e2e 是黑盒，它该按「用户看到的路径」断言，
    产品把目录改名了就该在这里红一次，而不是跟着一起改、悄悄继续绿 */
export const CONFIG_DIR = ".mr-otto";

/** 播进 auth.json 的那份假 session 的 uid。抽屉名是它的哈希（ADR-0187），
    所以「播登录记录」和「算配置目录」必须读同一个常量 —— 分成两处写死，
    一处改了另一处不改，症状是播出去的 skill 一条都不出现，而没有任何报错 */
const E2E_UID = "00000000-0000-0000-0000-000000000000";

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
  /** 这只 app 开机时「有没有登录记录」（ADR-0182 的进门闸判据，0183 收紧）。**默认 true** ——
      绝大多数用例验的不是登录，它们要的是直接站在 app 里面。给 false 就是
      一个全新用户：开机第一屏是 SignInScreen，里面的东西一个都点不到 */
  authRecord?: boolean;
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
  /** 这个账号的 subagent 目录（`$HOME/.mr-otto/accounts/<抽屉>/agents`，ADR-0187） */
  userAgentsDir: string;
  /** Electron 的 userData 根。auth.json 在这里；sessions.db 不在，见 accountData */
  userData: string;
  /** 这个账号的数据抽屉（`<userData>/accounts/<抽屉>/`）。**sessions.db 在这里** */
  accountData: string;
  /** 这个账号的用户级配置目录（`$HOME/.mr-otto/accounts/<抽屉>/`）：memories / skills / agents / mcp.json */
  userConfig: string;
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

/** 把这台机器上的模型凭据从 e2e 的环境里抹掉 —— 隔离的第三条腿。
    HOME 和 OTTO_PROFILE 挡住了配置目录和 userData，但主进程还有第三条读 key 的路：
    `src/main/index.ts` 开机时 `loadDotEnv(..., join(process.cwd(), ".env"))`，
    而 Playwright 起 Electron 用的 cwd 就是仓库根 —— 开发者本机那份 `.env`
    （里面通常有一把真的 DEEPSEEK_API_KEY）会原样进 e2e 的进程。后果不是"多读了
    个变量"：会话一开就真的打给厂商、真的花钱，而且**验收结果随模型心情变**
    （#480 就是这么红的：模型答了话、要调 bash、停在审批门上不动，
    于是顶栏那颗分支下拉被 `status === "running"` 一直按着 disabled）。

    `loadDotEnv` 的语义是"只补空缺"（`process.env[k] === undefined` 才写），
    所以把这些变量显式置成空串就够挡住 —— 不需要改产品代码，也不需要挪 cwd。

    名单从 `providerKeyEnvs()` 现取而不是在这儿手抄一份：抄一份的话，
    以后目录里新增一家厂商，这里会**静默**漏掉它（fail-open，又是一次真出网），
    而 CONFIG_DIR 那种手抄的失效方式是当场红一条（fail-closed），两者不同。 */
function blankCredentials(): Record<string, string> {
  const blanked: Record<string, string> = {};
  for (const envName of providerKeyEnvs()) blanked[envName] = "";
  // 型号也来自 .env（`OTTER_MODEL`）：它不是凭据，但同样让"默认开哪款模型"
  // 跟着开发者本机的偏好走，用例就不确定了。空串 = 走目录默认款
  blanked["OTTER_MODEL"] = "";
  return blanked;
}

/** Electron 的 userData 目录 —— 起 app **之前**就得算出来，因为登录记录要先播进去
    （`app.evaluate` 拿得到真值，但那时渲染层可能已经问过 `hasAuthRecord` 了）。
    算法照抄 `src/main/index.ts` 的 `app.setPath("userData", join(appData, profileDirName(...)))`，
    目录名从 `profileDirName` 现取而不是手抄。

    `appData` 各平台不同，而且 **darwin 那一支不认 `$HOME`**（Electron 走
    NSHomeDirectory，见本文件顶部的隔离说明）—— 所以 mac 上用的是跑测试这个
    进程的真实 home，Linux 上用的才是这只 app 的临时 HOME。算错了不会静默：
    登录记录播不进去 = 每条用例都被挡在 SignInScreen 上，当场全红。 */
function userDataPathFor(profile: string, home: string): string {
  const appData =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? (process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"))
        : (process.env["XDG_CONFIG_HOME"] ?? join(home, ".config"));
  return join(appData, profileDirName({ OTTO_PROFILE: profile }, false));
}

/** 播一条「这台机器登录过」的记录（进门闸认的是 auth.json 里**有没有一份 session**，
    ADR-0183 收紧了 0182 的判据）。

    值必须是 session 形状（带 `access_token`），但 **key 刻意不是 `sb-<ref>-auth-token`**：
    写成 supabase 认得的 key，supabase-js 会拿着这把假 token 去刷新，e2e 就真的出网了
    —— 而这套用例的第一条规矩就是不碰网络（见本文件顶部）。闸门按**形状**认 session、
    不按 key 名认，所以一个 supabase 永远不会读的 key 既满足闸门，又不会把它叫醒。 */
function seedAuthRecord(userData: string): void {
  mkdirSync(userData, { recursive: true });
  const record = {
    "e2e-auth-record": JSON.stringify({
      access_token: "e2e",
      refresh_token: "e2e",
      token_type: "bearer",
      expires_at: 1,
      user: { id: E2E_UID, email: "e2e@example.invalid" },
    }),
  };
  writeFileSync(join(userData, "auth.json"), JSON.stringify(record), { mode: 0o600 });
}

/** 本机数据按账号分抽屉之后（ADR-0187），会话库、记忆、skill、subagent 全在
    `<根>/accounts/<抽屉>/` 底下 —— 播种和查库都得先算出这一层。抽屉名是这份
    假 session 里 uid 的哈希，所以两边必须用同一个常量。

    `authRecord: false` 的那批用例没有 session，抽屉是 `_signed-out`；它们停在
    SignInScreen 上什么也点不到，播进去的东西本来也用不上，但路径仍然算对，
    免得哪天有人写一条「登录之后才看得见」的用例，播错地方还查不出来。 */
function accountDirs(userData: string, home: string, signedIn: boolean): {
  accountData: string;
  userConfig: string;
} {
  const drawer = accountDirName(signedIn ? E2E_UID : null);
  return {
    accountData: join(userData, ACCOUNTS_DIR, drawer),
    userConfig: join(home, CONFIG_DIR, ACCOUNTS_DIR, drawer),
  };
}

export async function launchOtto(opts: LaunchOptions = {}): Promise<Otto> {
  if (!opts.packaged) {
    expect(existsSync(MAIN), "先 npm run build —— e2e 跑的是 out/ 里的产物").toBe(true);
  }

  // 自己造的才自己删（见 LaunchOptions.home）
  const own = opts.home === undefined;
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "otto-e2e-home-"));
  const profile = opts.profile ?? `e2e${randomBytes(4).toString("hex")}`;
  const userData = userDataPathFor(profile, home);
  const signedIn = opts.authRecord !== false;
  const { accountData, userConfig } = accountDirs(userData, home, signedIn);
  const userAgentsDir = join(userConfig, "agents");
  seedInto(userAgentsDir, opts.userAgents);
  // `.claude/agents` 是别家产品的安装位，机器级，不跟着账号走（ADR-0056 起也不再扫）
  seedInto(join(home, ".claude", "agents"), opts.claudeAgents);
  seedSkills(join(userConfig, "skills"), opts.skills);
  // 进门闸（ADR-0182）：没有登录记录的话第一屏是 SignInScreen，里面什么都点不到。
  // 默认播一条 —— 让 33 条既有用例继续站在 app 里面，而不是各自去登一次录
  if (signedIn) seedAuthRecord(userData);

  const app = await electron.launch({
    // 打好包的那一只从自己的 asar 里读入口，不能再把仓库根塞给它
    ...(opts.packaged ? { executablePath: PACKAGED_APP, args: [] } : { args: [ROOT] }),
    cwd: ROOT,
    // blankCredentials 排在 opts.env 之前：fakeModelEnv() 那类用例要自己塞
    // 一把假 key + 假端点，它们的意志优先
    env: { ...process.env, ...blankCredentials(), ...opts.env, HOME: home, OTTO_PROFILE: profile },
  });
  // 主进程算出来的那份必须和上面算的一致 —— 不一致的话播种全落在空处，
  // 而症状是「用例莫名其妙看不到播进去的东西」，没有任何报错
  expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(userData);
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
    accountData,
    userConfig,
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
  // #559 之后欢迎页默认落在「任务」档,那一档整行文件夹 UI 都不出现(统一走内置
  // Default 工作区)。要指定文件夹得先切到「项目」档 —— 这一步不是 UI 细节:
  // e2e 的隔离全靠"会话开在自己的临时目录里",落进 Default 就是往用户的
  // 文档区丢东西了
  await otto.win.getByRole("tab", { name: "项目" }).click();
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
