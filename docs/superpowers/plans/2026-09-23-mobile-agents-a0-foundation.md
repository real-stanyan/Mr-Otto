# 手机端「智能体」单栏 A0（基座）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为手机端「智能体」单栏立基座：两端共用的纯逻辑（ottoFace 纯层、云会话客户端、workspaces API、时间线那批纯函数）挪进 `src/shared/`；手机端能画像素脸（react-native-svg）；导航换成单栈、根是名册占位；删掉用不到的三栏 / 项目投影 / 配对 / 好友。

**Architecture:** 搬家一律「先跑一次性改写脚本（按旧位置解析、按新位置写 import）→ 再 `git mv`」，测试只挪不改断言，门禁全绿是每一步的唯一判据。新增的判断（`alive` 态、帧去重、行程 / 描边）写成 `src/shared/ottoFace/` 里的纯函数、测试进 `tests/shared/`；手机端只剩画 SVG 的一层和一口共用的钟。两条新架构断言把「shared 不反指桌面」「手机只 import shared」从事实钉成规则。

**Tech Stack:** TypeScript（strict）、vitest（根门禁 `npm test` = 根 tsc + edge tsc + runtime tsc + 手机 tsc + vitest）、Expo SDK 57（Expo Go）、React Native 0.86、@react-navigation/native-stack 7、react-native-svg 15.15、expo-blur。

**Spec:** `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md`（§3.1 形象、§3.2 云会话客户端、§4 设计语言、§5.2 名册、§8 的 A0 行、§9 搬家清单、§10 偏差、§11 拍板）。Demo：分支 `claude/auto-mobile-app-redesign-0a1e2f` 的 `.demo/mobile-agents-redesign.html`。Task issue：#1356。

## Global Constraints

- **工作目录**：`/Users/stanyan/Github/Mr_Otto/.claude/worktrees/issue-1302-d5947b`。**你改的每一个路径都必须在这个目录下**；绝不碰主 checkout `/Users/stanyan/Github/Mr_Otto`（它冻结在 main、只读）。
- **绝不用任何形式的 `git stash`**（stash 栈跨 worktree 共享，#543）。要搁置改动就 `npm run wip`（ADR-0154）。
- **不在 `mobile/` 下跑 `npm install` / `npm uninstall` / `npm ci`**：这个 worktree 的 `mobile/node_modules` 是指向主 checkout 那份的软链，装卸会改到所有 lane 共用的那一份。A0 不加、不删任何手机端依赖（没用上的依赖留着，Task 9 开 issue 另清）。
- **门禁**：`npm test`（逐字，ADR-0053 / 0294）。每个任务结束必须全绿，判据是输出末尾 `Test Files … passed` 且进程退出码 0。后台跑门禁时把退出码写进日志（`; echo GATE_EXIT=$?`），只认日志里的 `GATE_EXIT=0`。
- **搬家只挪不改断言**：挪过去的测试文件里只改 import 路径；本计划明写要改的断言（Task 3 的 `alive` 例外）除外。
- **分层**：纯逻辑住 `src/shared/`、测试住 `tests/shared/`（镜像目录）；`src/shared/` 不 import `src/main/` / `src/renderer/`；`mobile/` 在自身之外只 import `src/shared/**` 与 `MOBILE_SAFE` 那几份 `src/session/` 文件（Task 1 把这两条钉成断言）。
- **import 约定**：TS 源码里的相对说明符一律带 `.js` 扩展名（`./frame.js`）。`src/shared/` 下的代码同时要过根 tsconfig 的 `noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes`。
- **形象的数**：网格 `GRID_W × GRID_H` = 59 × 52（角色 55 × 48 + 四周各 `FACE_PAD` = 2 格）；三档每格 0.5 / 1 / 2 点（`s` / `m` / `l`），盒子 29.5×26 / 59×52 / 118×104；钟 25fps；相位 `fnv1a(id) % 12000`。
- **文案**：界面上不出现「水獭」；用「智能体」「团队」。
- **提交**：中文 commit message，写**为什么**；结尾一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。只合并提交（merge commit），不 squash、不 rebase。
- 相对路径：`mobile/src/<子目录>/` 到仓库根是 `../../../`；`mobile/src/` 到仓库根是 `../../`；`mobile/App.tsx` 到仓库根是 `../`。

## 一次性工具：改写 import 的脚本

Task 2、4、5、6 都用它。**它不进仓库**，放在会话的 scratchpad：

`/private/tmp/claude-501/-Users-stanyan-Github-Mr-Otto--claude-worktrees-issue-1302-d5947b/a80005fd-dde5-469a-8982-86675e224e95/scratchpad/rewrite-imports.mjs`

（下面记作 `$RW`。已在起草这份计划时 dry-run 验过：ottoFace 那批改 4 个文件 11 处、渲染层那批改 71 个文件 127 处，无误改。）若那个文件不在了，按下面的全文重建：

```js
// 一次性工具：把一批模块从旧路径挪到新路径之后，改写全仓对它们的 import。
//
// 用法（在仓库根目录跑）：
//   node rewrite-imports.mjs <mapping.json> [--apply]
// mapping.json：{ "src/renderer/src/lib/dayLabel.ts": "src/shared/dayLabel.ts", ... }
//   键 = 旧文件路径（相对仓库根），值 = 新文件路径。目录映射写成以 "/" 结尾的一对：
//   { "src/renderer/src/lib/ottoFace/": "src/shared/ottoFace/" }
// 不带 --apply 只打印将要改的行（dry-run）。
//
// 认的说明符：`from "…"`、`import("…")`、`import "…"`、`require("…")`、
// `vi.mock("…")`、`vi.importActual("…")`；相对路径与渲染层的 `@/` 别名（= src/renderer/src/）。
// 被改写的文件本身如果也在映射里（它自己挪了家），按它的**新**位置算相对路径。
// **必须在 git mv 之前跑**：旧说明符要按文件的旧位置解析，新说明符按新位置写。
// 输出的说明符一律带 `.js`（本仓 TS 源码的 import 约定）。

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = process.cwd();
const [mappingPath, flag] = process.argv.slice(2);
if (!mappingPath) {
  console.error("usage: node rewrite-imports.mjs <mapping.json> [--apply]");
  process.exit(2);
}
const APPLY = flag === "--apply";
const raw = JSON.parse(readFileSync(mappingPath, "utf8"));

const fileMap = new Map();
const dirMap = [];
for (const [from, to] of Object.entries(raw)) {
  if (from.endsWith("/")) dirMap.push([resolve(ROOT, from), resolve(ROOT, to)]);
  else fileMap.set(stripExt(resolve(ROOT, from)), stripExt(resolve(ROOT, to)));
}

function stripExt(p) {
  return p.replace(/\.(ts|tsx|js|mjs)$/, "");
}

function moved(absNoExt) {
  if (fileMap.has(absNoExt)) return fileMap.get(absNoExt);
  for (const [from, to] of dirMap) {
    if (absNoExt === from || absNoExt.startsWith(from + sep)) return to + absNoExt.slice(from.length);
  }
  return null;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".claude", ".superpowers", ".demo"]);
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const SPEC_RE =
  /((?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*|vi\.mock\(\s*|vi\.importActual\(\s*|vi\.doMock\(\s*))(["'])([^"']+)\2/g;

function targetOf(spec, fromDir) {
  if (spec.startsWith("@/")) return stripExt(resolve(ROOT, "src/renderer/src", spec.slice(2)));
  if (spec.startsWith("./") || spec.startsWith("../")) return stripExt(resolve(fromDir, spec));
  return null;
}

function specFor(fromDir, targetAbsNoExt) {
  let rel = relative(fromDir, targetAbsNoExt).split(sep).join("/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel + ".js";
}

const roots = ["src", "tests", "scripts", "services", "mobile"].map((d) => join(ROOT, d)).filter(existsSync);
let changedFiles = 0;
let changedSpecs = 0;
for (const r of roots) {
  for (const file of walk(r)) {
    const src = readFileSync(file, "utf8");
    const fileNoExt = stripExt(file);
    const selfMoved = moved(fileNoExt);
    const hereDir = dirname(selfMoved ? selfMoved : fileNoExt);
    const origDir = dirname(fileNoExt);
    let dirty = false;
    const next = src.replace(SPEC_RE, (whole, lead, q, spec) => {
      const target = targetOf(spec, origDir);
      if (target === null) return whole;
      const dest = moved(target) ?? target;
      if (dest === target && !selfMoved) return whole;
      const nextSpec = spec.startsWith("@/") && dest === target ? spec : specFor(hereDir, dest);
      if (nextSpec === spec) return whole;
      dirty = true;
      changedSpecs++;
      console.log(`${relative(ROOT, file)}: ${spec}  →  ${nextSpec}`);
      return `${lead}${q}${nextSpec}${q}`;
    });
    if (dirty) {
      changedFiles++;
      if (APPLY) writeFileSync(file, next);
    }
  }
}
console.log(`\n${APPLY ? "改了" : "将改"} ${changedFiles} 个文件、${changedSpecs} 处说明符${APPLY ? "" : "（dry-run，加 --apply 才写盘）"}`);
```

映射文件也放 scratchpad（`$S` = 上面那个 scratchpad 目录）。

## 文件结构

挪进 `src/shared/`（桌面改 import，不留转发壳；ottoFace 的渲染层 barrel 例外——它还要带着 `paint.ts`）：
- `src/shared/ottoFace/{character,sprites,states,frame,adapt,index}.ts` + `characters/*`（Task 2）
- `src/shared/{agentAvatarSlot,agentAvatar,chatBubbles,cloudStreaming,dayLabel,systemNote,proxyShare,workspaceView,billingView,cloudTimeline,workspaceAccess,agentRoster,agentMentionInput}.ts`（Task 4）
- `src/shared/remote/cloudSessionClient.ts`（Task 5）
- `src/shared/supabaseWorkspacesApi.ts`（Task 6）

新建（共享纯逻辑）：
- `src/shared/ottoFace/runs.ts`：帧 → 每色一层横向行程、行程 → SVG `d` 串、轮廓外一圈（Task 3）
- `src/shared/ottoFace/art.ts`：按 (坑位, 状态, motion) 缓存画好的几层、三档盒子、相位（Task 3）
- `src/shared/homeWorkspace.ts`：`ensureHomeWorkspace`（Task 6）
- `src/main/cloudSessionFleet.ts`：`cloudSessionFleetRow` 留在桌面（Task 5）

新建（手机端）：
- `mobile/src/relay.ts`、`mobile/src/chrome/RoundButton.tsx`、`mobile/src/roster/{RosterScreen,AccountButton}.tsx`（Task 7）
- `mobile/src/face/{clock.ts,Face.tsx}`、`mobile/src/dev/FaceGallery.tsx`（Task 8）

重写：`mobile/App.tsx`、`mobile/src/nav/{types.ts,RootNavigator.tsx}`、`mobile/src/account/AccountScreen.tsx`（Task 7）

删除（手机端，Task 7）：`mobile/src/tabs/`、`mobile/src/projects/`、`mobile/src/pair/`、`mobile/src/friends/`、`mobile/src/friends.tsx`、`mobile/src/friendsApi.ts`、`mobile/src/nav/{TabBar,AvatarButton}.tsx`、`mobile/src/{chrome,link}.tsx`、`mobile/src/{session,identity,attach,devicesApi,deviceLabel,haptics}.ts`、`mobile/src/icons.tsx`

文档（Task 9）：`docs/adr/0317-手机端改成智能体单栏-形象用SVG画-云会话客户端挪进shared.md`（编号合并时认领）、`mobile/README.md`、`AGENTS.md`（Where to find things）、spec §10 回写。

---

### Task 1: 两条新架构断言

**Files:**
- Modify: `tests/architecture.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: 断言 1「`src/shared` 不 import `src/main` / `src/renderer`」；断言 2「`mobile/` 只 import `src/shared/**` 与 `MOBILE_SAFE` 那几份 `src/session/` 文件」。Task 2–8 的搬家与新代码都受它们约束。

这两条是**更严的新断言**（L2，ADR-0010）：今天的代码本来就满足，它们把事实钉成会红的规则——Task 5 搬客户端、Task 4 搬 `agentRoster` 时都踩在这条线上。

- [ ] **Step 1: 把 `MOBILE_SAFE` 提到模块顶层**

`tests/architecture.test.ts` 里 `it("移动端复用的那批 src/session 文件不 import node builtin", …)` 内部定义了 `const MOBILE_SAFE = [...]`。把这个数组原样剪到文件顶部（`NODE_BUILTIN` 定义之后），用例里改成引用它。同时把顶部的 path import 扩成：

```ts
import { dirname, join, relative, resolve } from "node:path";
```

- [ ] **Step 2: 在 `describe(...)` 里、`src/shared 不 import 任何 node builtin` 那条用例后面加两条**

```ts
  it("src/shared 不 import src/main / src/renderer —— 这一层手机端也要跑（#1356）", () => {
    const bad = walk(join(ROOT, "shared"))
      .filter((f) =>
        imports(f).some((s) => {
          if (!s.startsWith(".")) return false;
          return /^(main|renderer)(\/|$)/.test(relative(ROOT, resolve(dirname(f), s)));
        })
      )
      .map((f) => relative(ROOT, f));
    expect(
      bad,
      `这些 shared 文件反指了桌面那两层:\n  ${bad.join("\n  ")}\n` +
        "修法:src/shared 是三端共用的纯层,手机端会直接 import 同一份——它指向 src/main 或 src/renderer," +
        "手机端就得连带类型检查整棵桌面树(better-sqlite3、DOM、zustand)。" +
        "要的只是一个类型就把类型挪进 shared;要的是一个能力就做成注入的依赖(同 cloudSessionClient 的 deps)"
    ).toEqual([]);
  });

  it("mobile/ 在自身之外只 import src/shared/**（加上 MOBILE_SAFE 那几份 session 投影）（#1356）", () => {
    const REPO = join(__dirname, "..");
    const MOBILE = join(REPO, "mobile");
    const files = [...walk(join(MOBILE, "src")), join(MOBILE, "App.tsx"), join(MOBILE, "index.ts")];
    const safeSession = new Set(MOBILE_SAFE.map((f) => `src/session/${f.replace(/\.ts$/, "")}`));
    const bad: string[] = [];
    for (const f of files) {
      for (const s of imports(f)) {
        if (s.startsWith("@/")) {
          bad.push(`${relative(REPO, f)} → ${s}`);
          continue;
        }
        if (!s.startsWith(".")) continue; // 包名
        const target = relative(REPO, resolve(dirname(f), s)).replace(/\.(js|ts|tsx|json)$/, "");
        if (target.startsWith("mobile/")) continue;
        if (target.startsWith("src/shared/")) continue;
        if (safeSession.has(target)) continue;
        bad.push(`${relative(REPO, f)} → ${s}`);
      }
    }
    expect(
      bad,
      `手机端 import 了 shared 以外的桌面代码:\n  ${bad.join("\n  ")}\n` +
        "修法:把要用的纯逻辑挪进 src/shared/(测试挪进 tests/shared/),桌面改 import 它——" +
        "不要跨目录 import 渲染层或主进程(spec 2026-09-23 §3.2;2026-09-11 spec §9 已否决过这条路)。" +
        "src/session 里只有 MOBILE_SAFE 名单上的文件可以用"
    ).toEqual([]);
  });
```

- [ ] **Step 3: 跑这一个文件，确认两条都绿（今天的代码满足它们）**

Run: `npx vitest run tests/architecture.test.ts`
Expected: PASS（全部用例绿）

- [ ] **Step 4: 证明它们真的会咬人（不提交）**

临时在 `mobile/src/theme.ts` 第一行后插入 `import type {} from "../../src/renderer/src/store.js";`，再跑 `npx vitest run tests/architecture.test.ts -t "mobile/"`。
Expected: FAIL，报错里列出 `mobile/src/theme.ts → ../../src/renderer/src/store.js`。
然后**撤掉那一行**（`git checkout -- mobile/src/theme.ts`），再跑一次同一条命令确认回到 PASS。

- [ ] **Step 5: 跑门禁并提交**

Run: `npm test`
Expected: 全绿

```bash
git add tests/architecture.test.ts
git commit -m "test(architecture): shared 不反指桌面、手机只 import shared（#1356）

A0 要把云会话客户端、时间线那批纯函数挪进 src/shared 给手机用。这两条今天碰巧都成立，
但搬的过程里最容易顺手犯的正是它们：agentRoster 从一个 .tsx 组件拿类型、客户端从
main/proxyManager 拿类型——挪过去之后手机端的 tsc 就要连带检查整棵桌面树。
先钉成会红的规则，再动搬家。更严的新断言，L2（ADR-0010）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: ottoFace 纯层挪进 `src/shared/ottoFace/`

**Files:**
- Move: `src/renderer/src/lib/ottoFace/{character,sprites,states,frame,adapt}.ts` → `src/shared/ottoFace/`
- Move: `src/renderer/src/lib/ottoFace/characters/*` → `src/shared/ottoFace/characters/`
- Create: `src/shared/ottoFace/index.ts`
- Rewrite: `src/renderer/src/lib/ottoFace/index.ts`（只剩转出 shared + `paint`）
- Move: `tests/renderer/ottoFace/{frame,adapt}.test.ts` → `tests/shared/ottoFace/`
- Modify: `scripts/build-face-gallery.mjs`、`scripts/extract-face-sprite.mjs`（两处写死的路径）

**Interfaces:**
- Consumes: Task 1 的断言
- Produces: `src/shared/ottoFace/index.ts` 导出 `composeFrame`、`faceCharacterAt`、`FaceCell`、`FaceFrame`、`FrameOptions`、`FACE_STATES`、`FACE_STATE_LIST`、`faceAnimates`、`isFaceState`、`BADGE_COLORS`、`FaceState`、`FaceBadge`、`FaceStateSpec`、`LookDriver`、`FACE_CHARACTERS`、`FACE_CANVAS`、`GRID_W`、`GRID_H`、`DISC_COLOR`、`FaceCharacter`、`FACE_PACKS`、`faceCharacter`、`dmFaceState`、`deriveBrows`、`deriveEyes`、`deriveMouths` 及类型 `Box` / `EyePair` / `EyeShape` / `MouthShape` / `Tone`。渲染层 `src/renderer/src/lib/ottoFace/index.ts` 导出上面全部 + `paintFace`、`sizeFaceCanvas`。

- [ ] **Step 1: 写映射**

`$S/map-ottoface.json`：

```json
{
  "src/renderer/src/lib/ottoFace/character.ts": "src/shared/ottoFace/character.ts",
  "src/renderer/src/lib/ottoFace/characters/": "src/shared/ottoFace/characters/",
  "src/renderer/src/lib/ottoFace/sprites.ts": "src/shared/ottoFace/sprites.ts",
  "src/renderer/src/lib/ottoFace/states.ts": "src/shared/ottoFace/states.ts",
  "src/renderer/src/lib/ottoFace/frame.ts": "src/shared/ottoFace/frame.ts",
  "src/renderer/src/lib/ottoFace/adapt.ts": "src/shared/ottoFace/adapt.ts",
  "tests/renderer/ottoFace/frame.test.ts": "tests/shared/ottoFace/frame.test.ts",
  "tests/renderer/ottoFace/adapt.test.ts": "tests/shared/ottoFace/adapt.test.ts"
}
```

- [ ] **Step 2: dry-run，核对改动面**

Run: `node $RW $S/map-ottoface.json`
Expected: 列出 `adapt.ts` 的 `../../../../shared/turnLedger.js → ../turnLedger.js`、渲染层 `index.ts` / `paint.ts` 改指 `../../../../shared/ottoFace/…`、两个测试文件的路径；末尾「将改 N 个文件」，N 在 4–6 之间。没有别的文件出现。

- [ ] **Step 3: 落盘，再挪文件（顺序不能反）**

```bash
node $RW $S/map-ottoface.json --apply
mkdir -p src/shared/ottoFace tests/shared/ottoFace
git mv src/renderer/src/lib/ottoFace/characters src/shared/ottoFace/characters
for f in character sprites states frame adapt; do git mv src/renderer/src/lib/ottoFace/$f.ts src/shared/ottoFace/$f.ts; done
git mv tests/renderer/ottoFace/frame.test.ts tests/shared/ottoFace/frame.test.ts
git mv tests/renderer/ottoFace/adapt.test.ts tests/shared/ottoFace/adapt.test.ts
```

- [ ] **Step 4: 建 shared 的 barrel**

`src/shared/ottoFace/index.ts`：

```ts
// ottoFace —— 会动的像素脸的纯层（#1345，ADR-0316；#1356 挪进 shared，桌面与手机共用同一份）。
//
// · `character.ts`  一份角色包的契约 + 从两三个尺寸推全套眉/眼/嘴的那几个函数
// · `characters/`   十一个角色，每个一张自己的矩阵（**不是共用一张光头加头发**）
// · `sprites.ts`    13 个坑位 → 角色，外加这张脸的构图常量
// · `states.ts`     表情表
// · `frame.ts`      纯函数：坑位 + 状态 + 时刻 → 一帧的网格坐标
// · `adapt.ts`      仓里已有的状态 → 脸上的表情
//
// 画出来的那一层各端各写：桌面是 canvas（`src/renderer/src/lib/ottoFace/paint.ts`），
// 手机是 react-native-svg（`mobile/src/face/Face.tsx`）。

export { dmFaceState } from "./adapt.js";
export {
  deriveBrows,
  deriveEyes,
  deriveMouths,
  type Box,
  type EyePair,
  type EyeShape,
  type MouthShape,
  type Tone,
} from "./character.js";
export { faceCharacter, FACE_PACKS } from "./characters/index.js";
export { composeFrame, faceCharacterAt, type FaceCell, type FaceFrame, type FrameOptions } from "./frame.js";
export {
  BADGE_COLORS,
  FACE_STATE_LIST,
  FACE_STATES,
  faceAnimates,
  isFaceState,
  type FaceBadge,
  type FaceState,
  type FaceStateSpec,
  type LookDriver,
} from "./states.js";
export {
  DISC_COLOR,
  FACE_CANVAS,
  FACE_CHARACTERS,
  GRID_H,
  GRID_W,
  type FaceCharacter,
} from "./sprites.js";
```

- [ ] **Step 5: 渲染层 barrel 改成只转出**

用下面的全文**覆盖** `src/renderer/src/lib/ottoFace/index.ts`：

```ts
// ottoFace（渲染层这一半）。纯层在 `src/shared/ottoFace/`（#1356 挪过去，两端共用），
// 这里只多 canvas 那一层（`paint.ts`）。桌面的调用点照旧 import 这个文件。

export * from "../../../../shared/ottoFace/index.js";
export { paintFace, sizeFaceCanvas } from "./paint.js";
```

- [ ] **Step 6: 挪过去的测试改指 shared 的 barrel**

`tests/shared/ottoFace/frame.test.ts` 里指向渲染层 barrel 的那一行（脚本已按新位置重算成 `../../../src/renderer/src/lib/ottoFace/index.js`）改成：

```ts
} from "../../../src/shared/ottoFace/index.js";
```

（`AGENT_AVATAR_COUNT` 那一行仍指渲染层的 `agentAvatarSlot.js`——它在 Task 4 才挪，届时脚本会改。）

- [ ] **Step 7: 两个脚本里写死的路径**

`scripts/build-face-gallery.mjs`：

```js
import { FACE_CHARACTERS } from "${join(root, "src/shared/ottoFace/sprites.ts")}";
import { FACE_STATES, faceAnimates } from "${join(root, "src/shared/ottoFace/states.ts")}";
import { paintFace, sizeFaceCanvas } from "${join(root, "src/renderer/src/lib/ottoFace/paint.ts")}";
```

（第三行不变；同文件第 7、14、136 行注释里的 `lib/ottoFace/` 改成 `src/shared/ottoFace/`，`tests/renderer/ottoFace/` 改成 `tests/shared/ottoFace/`。）

`scripts/extract-face-sprite.mjs` 第 284 行：

```js
const outPath = opt("out", `src/shared/ottoFace/characters/${id}.ts`);
```

- [ ] **Step 8: 核对没有残留**

Run: `grep -rn "renderer/src/lib/ottoFace/\(character\|sprites\|states\|frame\|adapt\|characters\)" src tests scripts services mobile`
Expected: 没有输出

- [ ] **Step 9: 跑门禁并提交**

Run: `npm test`
Expected: 全绿（测试总数与 Task 1 结束时相同）

```bash
git add -A src/shared/ottoFace src/renderer/src/lib/ottoFace tests/shared/ottoFace tests/renderer/ottoFace scripts/build-face-gallery.mjs scripts/extract-face-sprite.mjs
git commit -m "refactor(ottoFace): 纯层挪进 src/shared，手机端要画同一份脸（#1356）

手机端的名册、聊天页都要画智能体的像素脸（spec §3.1）。判断——角色矩阵、状态表、
composeFrame——必须与桌面是同一份源，不然两端的脸会在某一格上悄悄漂开。
只挪不改：canvas 那一层 paint.ts 留在渲染层，渲染层 index.ts 只剩转出，桌面的
四个调用点一个字不改；测试挪进 tests/shared/ottoFace，断言一条没动。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: ottoFace 新增 `alive` 态、帧去重、行程 / 描边 / 画好的几层

**Files:**
- Modify: `src/shared/ottoFace/states.ts`（加 `alive`）
- Modify: `src/shared/ottoFace/frame.ts`（拆出 `frameMotion` / `motionKey` / `composeFrameAt`）
- Modify: `src/shared/ottoFace/sprites.ts`（加 `firstSlotOf`）
- Create: `src/shared/ottoFace/runs.ts`、`src/shared/ottoFace/art.ts`
- Modify: `src/shared/ottoFace/index.ts`（导出新增的名字）
- Modify: `tests/shared/ottoFace/frame.test.ts`（`alive` 例外 + 新用例）
- Create: `tests/shared/ottoFace/runs.test.ts`、`tests/shared/ottoFace/art.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `src/shared/ottoFace/*`
- Produces（Task 8 手机端用）：
  - `FaceState` 多一档 `"alive"`
  - `interface FaceMotion { readonly bob: number; readonly sway: number; readonly lookX: number; readonly lookY: number; readonly eye: EyeShape; readonly mouth: MouthShape }`
  - `frameMotion(state: FaceState, t: number, opts?: FrameOptions): FaceMotion`
  - `motionKey(m: FaceMotion): string`
  - `composeFrameAt(slot: number, state: FaceState, m: FaceMotion): FaceFrame`
  - `firstSlotOf(characterId: string): number | null`
  - `type FaceRun = readonly [x: number, y: number, n: number]`；`interface FaceLayer { readonly tone: string; readonly color: string; readonly runs: readonly FaceRun[] }`
  - `faceLayers(frame: FaceFrame): FaceLayer[]`、`runsPath(runs: readonly FaceRun[]): string`、`faceRim(frame: FaceFrame): FaceRun[]`
  - `interface FaceArt { readonly key: string; readonly layers: readonly { tone: string; color: string; d: string }[]; readonly rim: string; readonly badge: string | null; readonly dim: boolean }`
  - `faceArtKey(slot: number, state: FaceState, t: number, opts?: FrameOptions): string`
  - `createFaceArtCache(limit?: number): (slot: number, state: FaceState, t: number, opts?: FrameOptions) => FaceArt`
  - `FACE_TIERS = { s: 0.5, m: 1, l: 2 }`、`type FaceTier = "s" | "m" | "l"`、`faceBox(tier: FaceTier): { w: number; h: number }`
  - `facePhase(id: string): number`（0 ≤ 值 < 12000）

- [ ] **Step 1: 先写 `alive` 与 motion 的失败用例**

`tests/shared/ottoFace/frame.test.ts`：

(a) import 那一段加上 `composeFrameAt`、`frameMotion`、`motionKey`、`firstSlotOf`（全部从 `../../../src/shared/ottoFace/index.js`）。

(b) 把文件末尾 `it("会动的那几档都画了角标", …)` **整条替换**成下面两条（这是本计划唯一改动的既有断言——`alive` 是这条规矩的例外，理由写在 ADR 与 states.ts 里）：

```ts
  it("会动的那几档都画了角标——唯一的例外是 alive", () => {
    // 脸负责近看、角标负责扫一眼：会动却没角标的那一档在 24px 下只是「抖了一下」。
    // alive 是故意的例外（#1356）：名册那一墙查不到谁在跑，角标 = 声称，而眨眼与呼吸只是「活着」
    const noBadge = FACE_STATE_LIST.filter((s) => FACE_STATES[s].badge === null);
    expect(noBadge).toEqual(["plain", "alive"]);
  });

  it("alive：会动，但不画角标、不跟指针、不摆动、不压色", () => {
    const a = FACE_STATES.alive;
    expect(a.badge).toBeNull();
    expect(faceAnimates("alive")).toBe(true);
    expect(a.look).toBe("still");
    expect(a.sway).toBeUndefined();
    expect(a.desaturate).toBeUndefined();
    expect(a.dim).toBeUndefined();
    const frames = new Set<string>();
    for (let t = 0; t < 8000; t += 10) frames.add(JSON.stringify(composeFrame(0, "alive", t).cells));
    expect(frames.size).toBeGreaterThan(1);
  });
```

(c) 在 `describe("composeFrame", …)` 之后加一个新 describe：

```ts
describe("frameMotion / composeFrameAt", () => {
  it("composeFrame 就是 composeFrameAt(frameMotion(...))", () => {
    for (let slot = 0; slot < FACE_CHARACTERS.length; slot += 3) {
      for (const s of FACE_STATE_LIST) {
        for (let t = 0; t < 9000; t += 1373) {
          expect(composeFrame(slot, s, t)).toEqual(composeFrameAt(slot, s, frameMotion(s, t)));
        }
      }
    }
  });

  it("同一个 motion 键画出来的帧逐格相同——手机端据此做帧去重", () => {
    for (const s of ["alive", "idle", "composing", "searching", "working", "solving", "waiting"] as const) {
      const byKey = new Map<string, string>();
      for (let t = 0; t < 20000; t += 37) {
        const key = motionKey(frameMotion(s, t));
        const cells = JSON.stringify(composeFrame(5, s, t).cells);
        const seen = byKey.get(key);
        if (seen === undefined) byKey.set(key, cells);
        else expect(cells, `${s} @ ${t}`).toBe(seen);
      }
    }
  });

  it("motion 键不把 -0 与 0 拆成两个键", () => {
    const base = { bob: 0, sway: 0, lookX: 0, lookY: 0, eye: "open", mouth: "smile" } as const;
    expect(motionKey({ ...base, bob: -0 })).toBe(motionKey(base));
  });
});

describe("firstSlotOf", () => {
  it("每个角色都有坑位，回的是那个角色的第一个坑位", () => {
    for (const p of FACE_PACKS) {
      const slot = firstSlotOf(p.id);
      expect(slot, p.id).not.toBeNull();
      expect(FACE_CHARACTERS[slot!]!.id).toBe(p.id);
      for (let i = 0; i < slot!; i++) expect(FACE_CHARACTERS[i]!.id, `${p.id} 更早出现在 ${i}`).not.toBe(p.id);
    }
  });

  it("认不出的 id 回 null，不回一个看起来像挑过的坑位", () => {
    expect(firstSlotOf("no-such-face")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑，确认失败**

Run: `npx vitest run tests/shared/ottoFace/frame.test.ts`
Expected: FAIL（`composeFrameAt` / `frameMotion` / `motionKey` / `firstSlotOf` 不存在；`alive` 不在状态表里）

- [ ] **Step 3: states.ts 加 `alive`**

`src/shared/ottoFace/states.ts`：`FaceState` 联合里 `| "plain"` 下一行加 `| "alive"`；`FACE_STATES` 里 `plain: …,` 下一行加：

```ts
  // 名册那一墙（手机端，#1356）：眨眼 + 呼吸 = 活着，**不画角标、不跟指针**。它不回答
  // 「此刻在干嘛」——名册查不到谁在跑（#722 / #1282），角标在这套东西里是「声称」。
  // 这是「会动的那几档都画了角标」唯一的例外，理由在 ADR（#1356 A0）
  alive: spec({ zh: "活着", bobMs: 2600, bobAmp: 1 }),
```

（`spec()` 缺省 `blinks: true`、`look: "still"`、`badge: null`。）

- [ ] **Step 4: frame.ts 拆出 motion**

在 `src/shared/ottoFace/frame.ts` 里：保留文件头注释、`FaceCell` / `FaceFrame` / `faceCharacterAt` 转出、`SCAN` / `scanAt` / `blinkingAt` / `TALK_CYCLE` / `clampUnit` / `dimHex` / `desaturated`、`FrameOptions` 不动；把 `export function composeFrame(...) { ... }` **整段替换**成：

```ts
/**
 * 一帧里**随时刻变**的那几样：整格位移、视线、眼形、嘴形。其余（角色、色板、角标）只看
 * 坑位与状态。**同一个 (坑位, 状态, motion) 画出来的帧逐格相同**——手机端据此做帧去重：
 * 每拍只算这几个数，键没变就不重画（`art.ts`）。
 */
export interface FaceMotion {
  readonly bob: number;
  readonly sway: number;
  readonly lookX: number;
  readonly lookY: number;
  readonly eye: EyeShape;
  readonly mouth: MouthShape;
}

export function frameMotion(state: FaceState, t: number, opts?: FrameOptions): FaceMotion {
  const def = FACE_STATES[state];

  // ---- 位移。全部整数格：像素画做亚像素平滑会立刻糊 ----
  const bob = def.bobMs > 0 ? Math.round(Math.sin((t / def.bobMs) * Math.PI * 2) * def.bobAmp) : 0;
  const sway =
    def.sway === "urgent" ? (Math.floor(t / 260) % 2 === 0 ? -1 : 1)
    : def.sway === "lean" ? (Math.sin(t / 3700) > 0 ? -1 : 0)
    : 0;

  let lookX = 0;
  let lookY = 0;
  if (def.look === "pointer") {
    lookX = Math.round(clampUnit(opts?.pointerX ?? 0) * 2);
    lookY = Math.round(clampUnit(opts?.pointerY ?? 0));
  } else if (def.look === "scan") {
    const [sx, sy] = scanAt(t);
    lookX = sx; lookY = sy;
  } else if (def.look === "dart") {
    lookX = Math.floor(t / 190) % 2 === 0 ? -2 : 2;
  } else if (def.look === "fixed") {
    lookX = def.fixedLook?.[0] ?? 0;
    lookY = def.fixedLook?.[1] ?? 0;
  }

  const eye: EyeShape = def.blinks && blinkingAt(t) ? "blink" : def.eye;
  const mouth: MouthShape =
    def.mouth === "talk" ? (TALK_CYCLE[Math.floor(t / 130) % TALK_CYCLE.length] ?? "smile") : def.mouth;
  return { bob, sway, lookX, lookY, eye, mouth };
}

/** motion 的稳定键。`-0` 在模板串里写成 "0"，不会把同一帧拆成两个键 */
export function motionKey(m: FaceMotion): string {
  return `${m.bob}|${m.sway}|${m.lookX}|${m.lookY}|${m.eye}|${m.mouth}`;
}

/**
 * 一帧。`t` 是毫秒时刻（`performance.now()` / `Date.now()`），静态帧传 0。
 */
export function composeFrame(slot: number, state: FaceState, t: number, opts?: FrameOptions): FaceFrame {
  return composeFrameAt(slot, state, frameMotion(state, t, opts));
}

/** 按一个已经算好的 motion 叠一帧（`art.ts` 的缓存用它，免得同一拍算两遍 motion） */
export function composeFrameAt(slot: number, state: FaceState, m: FaceMotion): FaceFrame {
  const ch: FaceCharacter = faceCharacterAt(slot);
  const def = FACE_STATES[state];

  const grid: Tone[] = new Array<Tone>(ch.w * ch.h).fill(".");
  const put = (x: number, y: number, tone: Tone): void => {
    if (tone === "." || x < 0 || x >= ch.w || y < 0 || y >= ch.h) return;
    grid[y * ch.w + x] = tone;
  };
  const stamp = (sprite: readonly string[], x0: number, y0: number, tone: Tone): void => {
    for (let j = 0; j < sprite.length; j++) {
      const row = sprite[j] ?? "";
      for (let i = 0; i < row.length; i++) if ((row[i] ?? ".") !== ".") put(x0 + i, y0 + j, tone);
    }
  };

  // ---- 角色本体：品牌锁死，原样搬 ----
  for (let j = 0; j < ch.h; j++) {
    const row = ch.base[j] ?? "";
    for (let i = 0; i < ch.w; i++) put(i, j, (row[i] ?? ".") as Tone);
  }
  // ---- 抹掉原装的眉眼嘴。第五项指定填什么色（大胡子的嘴长在胡子上）----
  for (const [r0, r1, c0, c1, fill] of ch.erase) {
    const tone = fill ?? ch.skin;
    for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) put(x, y, tone);
  }

  // ---- 五官 ----
  const browDy = (def.browDy ?? 0) + (m.lookY < 0 ? -1 : 0);
  stamp(ch.brows.L, ch.anchors.browL[0], ch.anchors.browL[1] + browDy + (def.browAsym ?? 0), ch.ink);
  stamp(ch.brows.R, ch.anchors.browR[0], ch.anchors.browR[1] + browDy, ch.ink);

  const eye = ch.eyes[m.eye];
  stamp(eye.L, ch.anchors.eyeL[0] + eye.lx + m.lookX, ch.anchors.eyeL[1] + eye.ly + m.lookY, ch.ink);
  stamp(eye.R, ch.anchors.eyeR[0] + eye.rx + m.lookX, ch.anchors.eyeR[1] + eye.ry + m.lookY, ch.ink);

  stamp(ch.mouths[m.mouth], ch.anchors.mouth[0] + (def.mouthDx ?? 0), ch.anchors.mouth[1], ch.ink);

  // ---- 覆盖层（镜框、压脸的发丝）画在五官之上 ----
  if (ch.front !== undefined) {
    for (let j = 0; j < ch.front.length; j++) {
      const row = ch.front[j] ?? "";
      for (let i = 0; i < row.length; i++) put(i, j, (row[i] ?? ".") as Tone);
    }
  }

  const cells: FaceCell[] = [];
  for (let y = 0; y < ch.h; y++) {
    for (let x = 0; x < ch.w; x++) {
      const tone = grid[y * ch.w + x]!;
      if (tone !== ".") cells.push({ x: x + FACE_PAD + m.sway, y: y + FACE_PAD + m.bob, key: tone });
    }
  }

  const palette = def.desaturate === true ? (ch.dimPalette ?? desaturated(ch.palette)) : ch.palette;
  return {
    cells,
    palette,
    badge: def.badge === null ? null : BADGE_COLORS[def.badge],
    dim: def.dim === true,
  };
}
```

- [ ] **Step 5: sprites.ts 加 `firstSlotOf`**

在 `src/shared/ottoFace/sprites.ts` 的 `faceCharacterAt` 后面加：

```ts
/**
 * 一个角色的**第一个**坑位；认不出的 id 回 null。
 *
 * 挑头像的那一墙按角色列（11 张脸），库里存的是坑位（13 格，`avatar_slot`）。sweep 占了 1 与 3、
 * mane 占了 10 与 12——挑中 sweep 存 1、挑中 mane 存 10（spec §10 第 13 条）。
 * 回 null 而不是 0：0 是 stoic 的坑位，拿它兜底等于替人挑了一张他没挑过的脸。
 */
export function firstSlotOf(characterId: string): number | null {
  const i = SLOT_TO_ID.indexOf(characterId);
  return i < 0 ? null : i;
}
```

- [ ] **Step 6: barrel 导出新名字**

`src/shared/ottoFace/index.ts`：`frame.js` 那一行换成

```ts
export {
  composeFrame,
  composeFrameAt,
  faceCharacterAt,
  frameMotion,
  motionKey,
  type FaceCell,
  type FaceFrame,
  type FaceMotion,
  type FrameOptions,
} from "./frame.js";
```

`sprites.js` 那一段加上 `firstSlotOf,`。

- [ ] **Step 7: 跑，确认 frame 这一份转绿**

Run: `npx vitest run tests/shared/ottoFace/frame.test.ts`
Expected: PASS

- [ ] **Step 8: 写 runs 的失败用例**

`tests/shared/ottoFace/runs.test.ts`：

```ts
// 帧 → 画得出来的几层。断言的都是「画出来少一格 / 多一格也不会报错」的那类：
// 行程拼回去必须逐格等于原帧，描边必须恰好是轮廓外一圈。
import { describe, expect, it } from "vitest";
import {
  composeFrame,
  FACE_CHARACTERS,
  FACE_STATE_LIST,
  GRID_H,
  GRID_W,
  type FaceFrame,
} from "../../../src/shared/ottoFace/index.js";
import { faceLayers, faceRim, runsPath, type FaceRun } from "../../../src/shared/ottoFace/runs.js";

function frame(cells: [number, number, string][], palette: Record<string, string>): FaceFrame {
  return { cells: cells.map(([x, y, key]) => ({ x, y, key })), palette, badge: null, dim: false };
}

function expand(runs: readonly FaceRun[]): string[] {
  const out: string[] = [];
  for (const [x, y, n] of runs) for (let i = 0; i < n; i++) out.push(`${x + i},${y}`);
  return out;
}

describe("faceLayers", () => {
  it("同一行同色相邻的格子合成一段，按色调分层", () => {
    const layers = faceLayers(
      frame([[0, 0, "a"], [1, 0, "a"], [3, 0, "a"], [1, 1, "b"]], { a: "#111111", b: "#222222" })
    );
    expect(layers).toEqual([
      { tone: "a", color: "#111111", runs: [[0, 0, 2], [3, 0, 1]] },
      { tone: "b", color: "#222222", runs: [[1, 1, 1]] },
    ]);
  });

  it("色板里查不到的色调不画（同 paint.ts：透明而不是崩）", () => {
    expect(faceLayers(frame([[0, 0, "z"]], { a: "#111111" }))).toEqual([]);
  });

  it("每个坑位每个态：拼回去逐格等于原帧", () => {
    for (let slot = 0; slot < FACE_CHARACTERS.length; slot++) {
      for (const s of FACE_STATE_LIST) {
        const f = composeFrame(slot, s, 1234);
        const got = faceLayers(f).flatMap((l) => expand(l.runs).map((p) => `${p},${l.tone}`)).sort();
        const want = f.cells.map((c) => `${c.x},${c.y},${c.key}`).sort();
        expect(got, `坑位 ${slot} / ${s}`).toEqual(want);
      }
    }
  });
});

describe("runsPath", () => {
  it("一段一个闭合矩形", () => {
    expect(runsPath([[1, 2, 3]])).toBe("M1 2h3v1h-3z");
    expect(runsPath([[0, 0, 1], [4, 5, 2]])).toBe("M0 0h1v1h-1zM4 5h2v1h-2z");
  });

  it("没有行程就是空串", () => {
    expect(runsPath([])).toBe("");
  });
});

describe("faceRim", () => {
  it("一格的描边是它四邻那四格", () => {
    expect(faceRim(frame([[5, 5, "a"]], { a: "#111111" }))).toEqual([
      [5, 4, 1], [4, 5, 1], [6, 5, 1], [5, 6, 1],
    ]);
  });

  it("贴着网格边的不往外画", () => {
    expect(faceRim(frame([[0, 0, "a"]], { a: "#111111" }))).toEqual([[1, 0, 1], [0, 1, 1]]);
  });

  it("真实的脸：描边不压在脸上、每格都挨着脸、脸外一圈一格不落、全在网格里", () => {
    for (let slot = 0; slot < FACE_CHARACTERS.length; slot++) {
      const f = composeFrame(slot, "alive", 0);
      const filled = new Set(f.cells.map((c) => `${c.x},${c.y}`));
      const rim = new Set(expand(faceRim(f)));
      for (const p of rim) {
        const [x, y] = p.split(",").map(Number) as [number, number];
        expect(filled.has(p), `坑位 ${slot} 描边压在脸上 ${p}`).toBe(false);
        expect(x >= 0 && x < GRID_W && y >= 0 && y < GRID_H, `坑位 ${slot} 出界 ${p}`).toBe(true);
        const touches = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].some(([a, b]) => filled.has(`${a},${b}`));
        expect(touches, `坑位 ${slot} 描边悬空 ${p}`).toBe(true);
      }
      for (const c of f.cells) {
        for (const [a, b] of [[c.x - 1, c.y], [c.x + 1, c.y], [c.x, c.y - 1], [c.x, c.y + 1]] as const) {
          if (a < 0 || a >= GRID_W || b < 0 || b >= GRID_H) continue;
          const p = `${a},${b}`;
          if (!filled.has(p)) expect(rim.has(p), `坑位 ${slot} 漏了 ${p}`).toBe(true);
        }
      }
    }
  });
});
```

- [ ] **Step 9: 跑，确认失败**

Run: `npx vitest run tests/shared/ottoFace/runs.test.ts`
Expected: FAIL（找不到 `runs.js`）

- [ ] **Step 10: 实现 runs.ts**

`src/shared/ottoFace/runs.ts`：

```ts
// ottoFace/runs —— 一帧 → 画得出来的几层（#1356）。给**不走 canvas** 的那一侧用：
// 手机端的 react-native-svg 一种颜色一条 Path，而一条 Path 就是一串横向行程。
//
// 纯函数、零 IO：行程拼回去必须逐格等于原帧（有断言），SVG 那一侧因此一个判断都不做。

import type { FaceFrame } from "./frame.js";
import { GRID_H, GRID_W } from "./sprites.js";

/** 一段横向行程：从 (x, y) 起、向右 n 格 */
export type FaceRun = readonly [x: number, y: number, n: number];

export interface FaceLayer {
  /** 调色板的键（`#` / `o` / …） */
  readonly tone: string;
  readonly color: string;
  readonly runs: readonly FaceRun[];
}

/**
 * 一帧 → 每种颜色一层。层按色调键排序（稳定，与格子遍历顺序无关）；同一行里同色且相邻的
 * 格子合成一段。一格只有一种颜色，所以层与层之间不会重叠，谁先画都一样。
 * 色板里查不到的色调不画——与 `paint.ts` 同一条：透明而不是崩。
 */
export function faceLayers(frame: FaceFrame): FaceLayer[] {
  const byTone = new Map<string, Map<number, number[]>>();
  for (const c of frame.cells) {
    let rows = byTone.get(c.key);
    if (rows === undefined) {
      rows = new Map();
      byTone.set(c.key, rows);
    }
    const xs = rows.get(c.y);
    if (xs === undefined) rows.set(c.y, [c.x]);
    else xs.push(c.x);
  }
  const out: FaceLayer[] = [];
  for (const tone of [...byTone.keys()].sort()) {
    const color = frame.palette[tone];
    const rows = byTone.get(tone);
    if (color === undefined || rows === undefined) continue;
    out.push({ tone, color, runs: rowsToRuns(rows) });
  }
  return out;
}

/** 行程 → SVG path 的 d 串。一段一个闭合矩形：`M x y h n v 1 h -n z` */
export function runsPath(runs: readonly FaceRun[]): string {
  let d = "";
  for (const [x, y, n] of runs) d += `M${x} ${y}h${n}v1h-${n}z`;
  return d;
}

/**
 * 轮廓外一圈：自己空着、四邻里至少一格有颜色的格子（限在网格内）。
 * 深色底上把它画成浅色——这批脸的头发是纯黑的，贴在 #000 上整颗头会糊成一团；桌面靠圆盘
 * 解决这件事，手机不画圆盘（demo「不许裁」），所以靠描边。网格四周各留了 2 格
 * （`FACE_PAD`），呼吸 / 摆动最多挪 1 格，描边永远画得下。
 */
export function faceRim(frame: FaceFrame): FaceRun[] {
  const filled = new Set<number>();
  for (const c of frame.cells) filled.add(c.y * GRID_W + c.x);
  const at = (x: number, y: number): boolean => filled.has(y * GRID_W + x);
  const rim = new Map<number, number[]>();
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (at(x, y)) continue;
      const near =
        (x > 0 && at(x - 1, y)) ||
        (x < GRID_W - 1 && at(x + 1, y)) ||
        (y > 0 && at(x, y - 1)) ||
        (y < GRID_H - 1 && at(x, y + 1));
      if (!near) continue;
      const xs = rim.get(y);
      if (xs === undefined) rim.set(y, [x]);
      else xs.push(x);
    }
  }
  return rowsToRuns(rim);
}

function rowsToRuns(rows: ReadonlyMap<number, readonly number[]>): FaceRun[] {
  const runs: FaceRun[] = [];
  for (const y of [...rows.keys()].sort((a, b) => a - b)) {
    const xs = [...(rows.get(y) ?? [])].sort((a, b) => a - b);
    if (xs.length === 0) continue;
    let start = xs[0]!;
    let prev = start;
    for (let i = 1; i < xs.length; i++) {
      const x = xs[i]!;
      if (x === prev + 1) {
        prev = x;
        continue;
      }
      runs.push([start, y, prev - start + 1]);
      start = x;
      prev = x;
    }
    runs.push([start, y, prev - start + 1]);
  }
  return runs;
}
```

- [ ] **Step 11: 跑，确认 runs 转绿**

Run: `npx vitest run tests/shared/ottoFace/runs.test.ts`
Expected: PASS

- [ ] **Step 12: 写 art 的失败用例**

`tests/shared/ottoFace/art.test.ts`：

```ts
// 画好的几层 + 缓存 + 三档盒子 + 相位。缓存错了的样子是安静的：要么每拍都重算（手机上一墙脸
// 一起掉帧），要么该换的帧没换（脸僵住）——两个方向各钉一条。
import { describe, expect, it } from "vitest";
import { BADGE_COLORS, frameMotion, GRID_H, GRID_W, motionKey } from "../../../src/shared/ottoFace/index.js";
import {
  createFaceArtCache,
  faceArtKey,
  faceBox,
  facePhase,
} from "../../../src/shared/ottoFace/art.js";

describe("createFaceArtCache", () => {
  it("同一个 (坑位, 状态, motion) 回同一个对象", () => {
    const art = createFaceArtCache();
    expect(art(3, "idle", 0)).toBe(art(3, "idle", 0));
  });

  it("t 不同但 motion 相同：仍是同一个对象；motion 变了：换一个", () => {
    const art = createFaceArtCache();
    let prevKey = "";
    let prev = art(0, "alive", 0);
    for (let t = 0; t < 8000; t += 40) {
      const k = motionKey(frameMotion("alive", t));
      const now = art(0, "alive", t);
      if (k === prevKey) expect(now).toBe(prev);
      else if (prevKey !== "") expect(now).not.toBe(prev);
      prevKey = k;
      prev = now;
    }
  });

  it("key 就是 faceArtKey", () => {
    const art = createFaceArtCache();
    expect(art(7, "working", 999).key).toBe(faceArtKey(7, "working", 999));
  });

  it("超过上限按最久没用的先扔", () => {
    const art = createFaceArtCache(2);
    const a = art(0, "plain", 0);
    art(1, "plain", 0);
    art(2, "plain", 0);
    expect(art(0, "plain", 0)).not.toBe(a);
  });

  it("每一层都有 d 串、真实的脸都有描边；角标跟着状态表走", () => {
    const art = createFaceArtCache();
    const a = art(4, "working", 0);
    expect(a.layers.length).toBeGreaterThan(0);
    for (const l of a.layers) expect(l.d.length, l.tone).toBeGreaterThan(0);
    expect(a.rim.length).toBeGreaterThan(0);
    expect(a.badge).toBe(BADGE_COLORS.work);
    expect(art(4, "alive", 0).badge).toBeNull();
    expect(art(4, "offline", 0).dim).toBe(true);
  });
});

describe("faceBox", () => {
  it("盒子就是网格乘档位：s / m / l = 0.5 / 1 / 2", () => {
    expect(faceBox("m")).toEqual({ w: GRID_W, h: GRID_H });
    expect(faceBox("s")).toEqual({ w: GRID_W / 2, h: GRID_H / 2 });
    expect(faceBox("l")).toEqual({ w: GRID_W * 2, h: GRID_H * 2 });
  });
});

describe("facePhase", () => {
  it("同一个 id 永远同一个相位，落在 [0, 12000)", () => {
    for (const id of ["admin", "a_000000000001", "a_0123456789ab"]) {
      const p = facePhase(id);
      expect(p).toBe(facePhase(id));
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(12000);
    }
  });

  it("不同的 id 错开（否则一墙脸同时眨眼）", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `a_${String(i).padStart(12, "0")}`);
    expect(new Set(ids.map(facePhase)).size).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 13: 跑，确认失败**

Run: `npx vitest run tests/shared/ottoFace/art.test.ts`
Expected: FAIL（找不到 `art.js`）

- [ ] **Step 14: 实现 art.ts**

`src/shared/ottoFace/art.ts`：

```ts
// ottoFace/art —— 画好的几层 + 缓存（#1356）。给不走 canvas 的那一侧（手机端 react-native-svg）用。
//
// 同一个 (坑位, 状态, motion) 画出来的帧逐格相同（`frame.ts` 有断言），所以按这个键记住
// 算好的 SVG 串：会动的脸每拍只算一次 motion，键没变就连 composeFrame 都不跑。
// 缓存是按最久没用的先扔（LRU）：一墙十几张脸、每张一个态，常驻的键不过几十个。

import { fnv1a } from "../fnv1a.js";
import { composeFrameAt, frameMotion, motionKey, type FrameOptions } from "./frame.js";
import { faceLayers, faceRim, runsPath } from "./runs.js";
import { GRID_H, GRID_W } from "./sprites.js";
import type { FaceState } from "./states.js";

export interface FaceArtLayer {
  readonly tone: string;
  readonly color: string;
  readonly d: string;
}

export interface FaceArt {
  readonly key: string;
  readonly layers: readonly FaceArtLayer[];
  /** 轮廓外一圈的 d 串（深色底上画成浅色） */
  readonly rim: string;
  /** 角标颜色；null = 不画 */
  readonly badge: string | null;
  /** 整张脸压淡（离线那一档） */
  readonly dim: boolean;
}

export function faceArtKey(slot: number, state: FaceState, t: number, opts?: FrameOptions): string {
  return `${slot}|${state}|${motionKey(frameMotion(state, t, opts))}`;
}

export function createFaceArtCache(
  limit = 256
): (slot: number, state: FaceState, t: number, opts?: FrameOptions) => FaceArt {
  const cache = new Map<string, FaceArt>();
  return (slot, state, t, opts) => {
    const m = frameMotion(state, t, opts);
    const key = `${slot}|${state}|${motionKey(m)}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit); // 挪到最新
      return hit;
    }
    const frame = composeFrameAt(slot, state, m);
    const art: FaceArt = {
      key,
      layers: faceLayers(frame).map((l) => ({ tone: l.tone, color: l.color, d: runsPath(l.runs) })),
      rim: runsPath(faceRim(frame)),
      badge: frame.badge,
      dim: frame.dim,
    };
    cache.set(key, art);
    if (cache.size > limit) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return art;
  };
}

/** 三档：每格 0.5 / 1 / 2 点。**盒子就是脸的真实尺寸**（网格乘档位），不裁、不加圆底（spec §3.1） */
export const FACE_TIERS = { s: 0.5, m: 1, l: 2 } as const;
export type FaceTier = keyof typeof FACE_TIERS;

export function faceBox(tier: FaceTier): { w: number; h: number } {
  const k = FACE_TIERS[tier];
  return { w: GRID_W * k, h: GRID_H * k };
}

/** 一墙脸各自错开的相位（毫秒）：共用同一个时刻的话一墙脸同时眨眼。按 id 派生，同一只每次
    打开都在同一个相位上——不用随机数，理由同 frame.ts 的眨眼 */
export function facePhase(id: string): number {
  return fnv1a(id) % 12_000;
}
```

- [ ] **Step 15: 跑 ottoFace 这三份测试**

Run: `npx vitest run tests/shared/ottoFace`
Expected: PASS

- [ ] **Step 16: 跑门禁并提交**

Run: `npm test`
Expected: 全绿（若有桌面代码写了 `Record<FaceState, …>` 这类穷举表，tsc 会要它补 `alive`——补一格与 `plain` 同值即可，并在 commit message 里写明）

```bash
git add src/shared/ottoFace tests/shared/ottoFace
git commit -m "feat(ottoFace): alive 态、帧去重、行程与描边——手机端画脸要的纯层（#1356）

名册那一墙要「活着但不声称任何事」：main 的表里 plain 完全静止、idle 带一枚灰角标
（那是在声称「空闲」，而名册查不到谁在跑）。加 alive：眨眼 + 呼吸、没有角标——
「会动的那几档都画了角标」唯一的例外，那条断言随之改成显式列出 plain 与 alive。

手机端用 react-native-svg 画：一种颜色一条 Path，所以要把帧拆成横向行程（runs.ts），
深色底上要一圈描边代替桌面的圆盘（faceRim）。frameMotion 从 composeFrame 里拆出来，
同一个 motion 键画出来的帧逐格相同（有断言），会动的脸每拍只算这几个数就知道要不要重画。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 渲染层那批时间线纯函数挪进 `src/shared/`

**Files:**
- Modify（先挪类型）：`src/renderer/src/lib/agentRoster.ts`、`src/renderer/src/components/{AgentChatHeader,CloudSessionMain,CloudSessionPage}.tsx`、`tests/renderer/agentChatPage.test.tsx`
- Move: `src/renderer/src/lib/{agentAvatarSlot,agentAvatar,chatBubbles,cloudStreaming,dayLabel,systemNote,proxyShare,workspaceView,billingView,cloudTimeline,workspaceAccess,agentRoster,agentMentionInput}.ts` → `src/shared/`
- Move（纯测试）: `tests/renderer/{agentAvatarSlot,agentAvatarSrc,chatBubbles,cloudStreaming,dayLabel,systemNote,cloudTimeline,cloudTimelineLabels,voiceCallCards,workspaceView,workspaceView.agents,workspaceView.cloud,proxyShare,billingViewPercent,planBadge,agentRoster,workspaceAccess,agentMentionInput}.test.ts` → `tests/shared/`；`tests/renderer/lib/billingView.test.ts` → `tests/shared/billingView.test.ts`
- 留在原处、只改 import：`tests/renderer/{conversationMap,subscriberGates,cloudSessionListStore}.test.ts`、`tests/renderer/{chatRosterLine,voiceCallCard,cloudSessionShell,agentChatPage}.test.tsx` 及全部渲染层组件

**Interfaces:**
- Consumes: Task 2 的 `src/shared/ottoFace/`（`agentAvatarSlot` 的测试 import `FACE_CHARACTERS`）
- Produces（A1 用）：`src/shared/agentRoster.ts` 导出 `ChatView`（`{ kind: "dm" | "group"; agentIds: string[]; title: string }`）、`homeOf`、`teamsOf`、`rosterRows`、`groupRows`、`rosterGate`、`chatSeedOf`、`chatViewOf`；`src/shared/cloudTimeline.ts` 导出 `hiddenFromCloudTimeline`、`relayLineText`、`chatRosterLineParts`、`stopButtonRows` 等（与挪之前同名同签名）；其余各文件导出不变。

判据（哪些测试跟着挪）：**挪完之后它的每一条非 vitest import 都落在 `src/shared/` 或 `src/session/events.ts` / `deriveMessages.ts`**。上面「Move（纯测试）」那一列就是按这条逐个核过的结果；留下的那几份 import 了组件、store 或留在渲染层的 lib。

- [ ] **Step 1: `ChatView` 类型先挪进 agentRoster.ts**

`agentRoster.ts` 挪进 shared 之后，不能再从一个 `.tsx` 组件拿类型（Task 1 的断言会红，手机端 tsc 也会连带检查组件）。

(a) `src/renderer/src/lib/agentRoster.ts`：删掉 `import type { ChatView } from "../components/AgentChatHeader.js";`，在 import 段之后加：

```ts
/** 聊天页头上那一行要的三样（#1280）。住在这里而不是组件里：`chatViewOf` 产出它，
    而这个文件两端共用（#1356）——从组件拿类型等于让手机端连带类型检查一个 React DOM 组件 */
export interface ChatView {
  kind: "dm" | "group";
  agentIds: string[];
  /** 私聊 = 那只智能体的名字；群聊 = 群名（没起名时是成员名拼起来的） */
  title: string;
}
```

(b) `src/renderer/src/components/AgentChatHeader.tsx`：删掉 `export interface ChatView { … }` 那一整段（含上面的注释行），在 import 段加 `import type { ChatView } from "../lib/agentRoster.js";`。

(c) `src/renderer/src/components/CloudSessionMain.tsx`：`import type { ChatView } from "./AgentChatHeader.js";` 改成 `import type { ChatView } from "../lib/agentRoster.js";`（若该文件已有一行 import `../lib/agentRoster.js`，合并进那一行）。

(d) `src/renderer/src/components/CloudSessionPage.tsx`：`import { AgentChatHeader, type ChatView } from "./AgentChatHeader.js";` 改成两行：

```ts
import { AgentChatHeader } from "./AgentChatHeader.js";
import type { ChatView } from "../lib/agentRoster.js";
```

(e) `tests/renderer/agentChatPage.test.tsx`：`import type { ChatView } from "../../src/renderer/src/components/AgentChatHeader.js";` 改成 `import type { ChatView } from "../../src/renderer/src/lib/agentRoster.js";`。

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 2: 写映射**

`$S/map-libs.json`：

```json
{
  "src/renderer/src/lib/agentAvatarSlot.ts": "src/shared/agentAvatarSlot.ts",
  "src/renderer/src/lib/agentAvatar.ts": "src/shared/agentAvatar.ts",
  "src/renderer/src/lib/chatBubbles.ts": "src/shared/chatBubbles.ts",
  "src/renderer/src/lib/cloudStreaming.ts": "src/shared/cloudStreaming.ts",
  "src/renderer/src/lib/dayLabel.ts": "src/shared/dayLabel.ts",
  "src/renderer/src/lib/systemNote.ts": "src/shared/systemNote.ts",
  "src/renderer/src/lib/proxyShare.ts": "src/shared/proxyShare.ts",
  "src/renderer/src/lib/workspaceView.ts": "src/shared/workspaceView.ts",
  "src/renderer/src/lib/billingView.ts": "src/shared/billingView.ts",
  "src/renderer/src/lib/cloudTimeline.ts": "src/shared/cloudTimeline.ts",
  "src/renderer/src/lib/workspaceAccess.ts": "src/shared/workspaceAccess.ts",
  "src/renderer/src/lib/agentRoster.ts": "src/shared/agentRoster.ts",
  "src/renderer/src/lib/agentMentionInput.ts": "src/shared/agentMentionInput.ts",
  "tests/renderer/agentAvatarSlot.test.ts": "tests/shared/agentAvatarSlot.test.ts",
  "tests/renderer/agentAvatarSrc.test.ts": "tests/shared/agentAvatarSrc.test.ts",
  "tests/renderer/chatBubbles.test.ts": "tests/shared/chatBubbles.test.ts",
  "tests/renderer/cloudStreaming.test.ts": "tests/shared/cloudStreaming.test.ts",
  "tests/renderer/dayLabel.test.ts": "tests/shared/dayLabel.test.ts",
  "tests/renderer/systemNote.test.ts": "tests/shared/systemNote.test.ts",
  "tests/renderer/cloudTimeline.test.ts": "tests/shared/cloudTimeline.test.ts",
  "tests/renderer/cloudTimelineLabels.test.ts": "tests/shared/cloudTimelineLabels.test.ts",
  "tests/renderer/voiceCallCards.test.ts": "tests/shared/voiceCallCards.test.ts",
  "tests/renderer/workspaceView.test.ts": "tests/shared/workspaceView.test.ts",
  "tests/renderer/workspaceView.agents.test.ts": "tests/shared/workspaceView.agents.test.ts",
  "tests/renderer/workspaceView.cloud.test.ts": "tests/shared/workspaceView.cloud.test.ts",
  "tests/renderer/proxyShare.test.ts": "tests/shared/proxyShare.test.ts",
  "tests/renderer/billingViewPercent.test.ts": "tests/shared/billingViewPercent.test.ts",
  "tests/renderer/planBadge.test.ts": "tests/shared/planBadge.test.ts",
  "tests/renderer/agentRoster.test.ts": "tests/shared/agentRoster.test.ts",
  "tests/renderer/workspaceAccess.test.ts": "tests/shared/workspaceAccess.test.ts",
  "tests/renderer/agentMentionInput.test.ts": "tests/shared/agentMentionInput.test.ts",
  "tests/renderer/lib/billingView.test.ts": "tests/shared/billingView.test.ts"
}
```

- [ ] **Step 3: dry-run，查「挪进 shared 之后反指渲染层」的说明符**

Run: `node $RW $S/map-libs.json | grep -E "^src/renderer/src/lib/(agentAvatarSlot|agentAvatar|chatBubbles|cloudStreaming|dayLabel|systemNote|proxyShare|workspaceView|billingView|cloudTimeline|workspaceAccess|agentRoster|agentMentionInput)\.ts:" | grep -v "→  \./\|→  \.\./session/"`
Expected: 没有输出（Step 1 之前这里会列出 `agentRoster.ts: ../components/AgentChatHeader.js`）

Run: `node $RW $S/map-libs.json | tail -3`
Expected: 「将改」约 72 个文件、130 处上下

- [ ] **Step 4: 落盘，再挪文件（顺序不能反）**

```bash
node $RW $S/map-libs.json --apply
for f in agentAvatarSlot agentAvatar chatBubbles cloudStreaming dayLabel systemNote proxyShare workspaceView billingView cloudTimeline workspaceAccess agentRoster agentMentionInput; do git mv src/renderer/src/lib/$f.ts src/shared/$f.ts; done
for t in agentAvatarSlot agentAvatarSrc chatBubbles cloudStreaming dayLabel systemNote cloudTimeline cloudTimelineLabels voiceCallCards workspaceView workspaceView.agents workspaceView.cloud proxyShare billingViewPercent planBadge agentRoster workspaceAccess agentMentionInput; do git mv tests/renderer/$t.test.ts tests/shared/$t.test.ts; done
git mv tests/renderer/lib/billingView.test.ts tests/shared/billingView.test.ts
```

- [ ] **Step 5: 挪过去的 agentAvatarSlot 测试改指 shared 的 ottoFace**

`tests/shared/agentAvatarSlot.test.ts` 里 `import { FACE_CHARACTERS } from "…/src/renderer/src/lib/ottoFace/index.js";` 改成：

```ts
import { FACE_CHARACTERS } from "../../src/shared/ottoFace/index.js";
```

- [ ] **Step 6: 核对**

Run: `grep -rnE "renderer/src/lib/(agentAvatarSlot|agentAvatar|chatBubbles|cloudStreaming|dayLabel|systemNote|proxyShare|workspaceView|billingView|cloudTimeline|workspaceAccess|agentRoster|agentMentionInput)\.js" src tests services scripts mobile`
Expected: 没有输出

Run: `grep -rnE "from \"(\.\./)+renderer/" src/shared`
Expected: 没有输出

- [ ] **Step 7: 跑门禁并提交**

Run: `npm test`
Expected: 全绿，测试总数与 Task 3 结束时相同

```bash
git add -A src/shared src/renderer tests/shared tests/renderer
git commit -m "refactor(shared): 时间线与名册那批纯函数挪进 src/shared（#1356）

手机端的名册、私聊、群聊要用同一份判据：哪些事件不上时间线（hiddenFromCloudTimeline）、
接力线怎么写、名单那一行怎么拆、谁的「停一下」画在哪一行、进门七态、头像坑位……
抄第二份的那天两端就开始各走各的（spec §3.2 / §9）。整份挪、不拆：cloudTimeline 的
渲染层依赖只有 agentAvatar / workspaceView / systemNote / billingView 这一串，挪完它自己
就是纯 shared。ChatView 类型先从 AgentChatHeader.tsx 挪进 agentRoster.ts——shared 不能
从组件拿类型。桌面改 import、不留转发壳；测试只挪不改断言。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 云会话客户端挪进 `src/shared/remote/`，会话列表那一行留在桌面

**Files:**
- Create: `src/main/cloudSessionFleet.ts`
- Modify: `src/main/cloudSessionClient.ts`（拆出 fleet 行、换 `FriendsResult` 来源、删一行没用的 import），然后 Move → `src/shared/remote/cloudSessionClient.ts`
- Modify: `src/main/index.ts:206`
- Create: `tests/main/cloudSessionFleet.test.ts`
- Modify + Move: `tests/main/cloudSessionClient.test.ts` → `tests/shared/remote/cloudSessionClient.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（A1 手机端用）：`src/shared/remote/cloudSessionClient.ts` 导出 `createCloudSessionClient(deps: CloudSessionClientDeps): CloudSessionClient`、`deniedMessage`、`CloudSessionClient`、`CloudSessionClientDeps`、`CloudSessionSummary`（签名与挪之前一字不差）。`src/main/cloudSessionFleet.ts` 导出 `cloudSessionFleetRow(summary: CloudSessionSummary | null): SessionSummary | null`。

- [ ] **Step 1: 记下挪之前的用例数**

Run: `npx vitest run tests/main/cloudSessionClient.test.ts 2>&1 | grep -E "Tests +[0-9]+"`
Expected: 形如 `Tests  N passed (N)`。**记下 N**。

- [ ] **Step 2: 建 `src/main/cloudSessionFleet.ts`**

把 `src/main/cloudSessionClient.ts` 里 `export function cloudSessionFleetRow(...)` 连同它上面那段文档注释（从 `/** CloudSessionSummary → 喂给 flattenFleet 的那一条虚拟 SessionSummary` 起）**剪切**过来，文件头加：

```ts
// cloudSessionFleet —— 云会话在桌面会话列表 / 灵动岛上的那一行（复审 P0；#1356 从
// cloudSessionClient.ts 拆出来）。客户端本体挪进 src/shared 给手机用了，这一行是桌面专属：
// 它产出一条虚拟 SessionSummary（来自 session/store.ts，better-sqlite3 那一层），手机端
// 没有也不该有这个概念。

import type { SessionSummary } from "../session/store.js";
// 合成这串前缀的是这里，识别它的是岛的分档（shared/islandTabs.ts）——两边共用一个常量
import { CLOUD_WORKSPACE_PREFIX } from "../shared/islandTabs.js";
import type { CloudSessionSummary } from "./cloudSessionClient.js";
```

（函数体一字不改。）

- [ ] **Step 3: 客户端里对应删改**

`src/main/cloudSessionClient.ts`：
- 删掉 `import type { SessionSummary } from "../session/store.js";`
- 删掉 `import { CLOUD_WORKSPACE_PREFIX } from "../shared/islandTabs.js";` 及它上面那三行注释
- `cloudSession.js` 那条 import 里删掉 `validateRepoUrl,`（没人用）
- `import type { FriendsResult } from "./proxyManager.js";` 改成 `import type { FriendsResult } from "../shared/friends.js";`（两份类型逐字相同）
- 文件头第 60–66 行那段讲 `cloudSessionFleetRow` 的注释末尾加一句：「那个函数住在 `src/main/cloudSessionFleet.ts`（#1356：客户端挪进 shared，这一行是桌面专属）。」

- [ ] **Step 4: index.ts 拆开那一行 import**

`src/main/index.ts:206`：

```ts
import { createCloudSessionClient } from "./cloudSessionClient.js";
import { cloudSessionFleetRow } from "./cloudSessionFleet.js";
```

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: 测试拆成两份**

(a) 新建 `tests/main/cloudSessionFleet.test.ts`：把 `tests/main/cloudSessionClient.test.ts` 里的两个 describe——`describe("cloudSessionFleetRow — 复审 P0：云会话上岛", …)`（连同它上方那段 `// ─── 复审 P0：云会话必须能上原生岛/手机 fleet` 注释）与 `describe("cloudSessionFleetRow 的标题（#1280）", …)`——**剪切**过来；它们用到的辅助函数（`cloudSummary`，以及块内引用到的构造审批的辅助函数、`noFs` 之类）**复制**过来（原文件里别的用例还在用的就留一份，没人用了就删）。文件头：

```ts
// cloudSessionFleetRow（桌面会话列表 / 灵动岛上的那一行）——从 cloudSessionClient.test.ts
// 拆出来（#1356）：客户端挪进 shared，这一行留在桌面，测试跟着分家。
import { describe, expect, it } from "vitest";
import { cloudSessionFleetRow } from "../../src/main/cloudSessionFleet.js";
import type { CloudSessionSummary } from "../../src/main/cloudSessionClient.js";
import { flattenFleet, initialIsland, type IslandState } from "../../src/main/islandProjection.js";
import { createWorkspaceLens } from "../../src/main/workspaceLens.js";
```

（再按块内实际用到的补 import，例如 `ApprovalRequest` 类型。）

(b) `tests/main/cloudSessionClient.test.ts`：删掉 `cloudSessionFleetRow` 的 import、`islandProjection` / `workspaceLens` 两行 import（剪走之后没人用了），以及只被剪走那两块用到的辅助函数。

Run: `npx vitest run tests/main/cloudSessionClient.test.ts tests/main/cloudSessionFleet.test.ts 2>&1 | grep -E "Tests +[0-9]+"`
Expected: 合计仍是 N

- [ ] **Step 6: 挪客户端与它的测试**

`$S/map-cs.json`：

```json
{
  "src/main/cloudSessionClient.ts": "src/shared/remote/cloudSessionClient.ts",
  "tests/main/cloudSessionClient.test.ts": "tests/shared/remote/cloudSessionClient.test.ts"
}
```

```bash
node $RW $S/map-cs.json
node $RW $S/map-cs.json --apply
git mv src/main/cloudSessionClient.ts src/shared/remote/cloudSessionClient.ts
git mv tests/main/cloudSessionClient.test.ts tests/shared/remote/cloudSessionClient.test.ts
```

Dry-run 预期：`src/main/index.ts`、`src/main/cloudSessionFleet.ts`、`tests/main/cloudSessionFleet.test.ts` 改指 `../shared/remote/cloudSessionClient.js`（按各自位置）；客户端自己的 `../shared/remote/*.js` 变成 `./*.js`、`../session/events.js` 变成 `../../session/events.js`、`../shared/friends.js` 变成 `../friends.js`、`../shared/shellBridge.js` 变成 `../shellBridge.js`。

- [ ] **Step 7: 核对**

Run: `grep -rn "main/cloudSessionClient" src tests services`
Expected: 没有输出

Run: `grep -nE "from \"(\.\./)+(main|renderer)/" src/shared/remote/cloudSessionClient.ts`
Expected: 没有输出

- [ ] **Step 8: 跑门禁并提交**

Run: `npm test`
Expected: 全绿；`tests/shared/remote/cloudSessionClient.test.ts` + `tests/main/cloudSessionFleet.test.ts` 合计 N

```bash
git add -A src/main src/shared/remote tests/main tests/shared/remote
git commit -m "refactor(cloud): 云会话客户端挪进 src/shared/remote，手机端做第二个客户端（#1356）

手机端要跟桌面连同一个 VPS runtime（spec §3.2）。客户端 1247 行的协议状态机——缓冲合并、
按 seq 去重、ACK 超时三态、尾巴分页——抄两份必然分家；而它运行时本来就只依赖
src/shared/remote，传输、令牌、推送全是注入的，挪过去不用改一行逻辑。
三处绊脚：会话列表 / 灵动岛那一行（cloudSessionFleetRow，要 better-sqlite3 那层的
SessionSummary）拆到 src/main/cloudSessionFleet.ts 留在桌面；FriendsResult 改用 shared 那份
（逐字相同）；validateRepoUrl 那行 import 没人用，删掉。测试跟着分家，合计用例数不变。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: workspaces API 挪进 `src/shared/`，主场那 13 行抽成 `ensureHomeWorkspace`

**Files:**
- Move: `src/main/supabaseWorkspacesApi.ts` → `src/shared/supabaseWorkspacesApi.ts`
- Move: `tests/main/supabaseWorkspacesApi.{cloudSessions,rowCount}.test.ts` → `tests/shared/`
- Create: `src/shared/homeWorkspace.ts`、`tests/shared/homeWorkspace.test.ts`
- Modify: `src/main/workspaceManager.ts`（`ensureHome` 改调 `ensureHomeWorkspace`）

**Interfaces:**
- Consumes: 无
- Produces（A1 手机端用）：`src/shared/supabaseWorkspacesApi.ts` 全部导出不变（`findHomeWorkspace`、`createWorkspace`、`listCloudSessions`、……）；`src/shared/homeWorkspace.ts` 导出

```ts
export interface HomeWorkspaceDeps {
  findHomeWorkspace(client: SupabaseClient, selfUid: string): Promise<string | null>;
  createWorkspace(client: SupabaseClient, name: string, selfUid: string, kind: "home"): Promise<{ id: string }>;
}
export function ensureHomeWorkspace(deps: HomeWorkspaceDeps, client: SupabaseClient, uid: string): Promise<{ id: string }>;
```

- [ ] **Step 1: 先确认那两份测试是纯的**

Run: `grep -hoE "from \"[^\"]+\"" tests/main/supabaseWorkspacesApi.cloudSessions.test.ts tests/main/supabaseWorkspacesApi.rowCount.test.ts | sort -u`
Expected: 除 `vitest` 与 `../../src/main/supabaseWorkspacesApi.js` 外，只有 `src/shared/*` 或第三方包。若还 import 了别的 `src/main/*`，**不挪那一份测试**（把它从下面的映射里删掉），其余照做。

- [ ] **Step 2: 挪**

`$S/map-ws.json`：

```json
{
  "src/main/supabaseWorkspacesApi.ts": "src/shared/supabaseWorkspacesApi.ts",
  "tests/main/supabaseWorkspacesApi.cloudSessions.test.ts": "tests/shared/supabaseWorkspacesApi.cloudSessions.test.ts",
  "tests/main/supabaseWorkspacesApi.rowCount.test.ts": "tests/shared/supabaseWorkspacesApi.rowCount.test.ts"
}
```

```bash
node $RW $S/map-ws.json
node $RW $S/map-ws.json --apply
git mv src/main/supabaseWorkspacesApi.ts src/shared/supabaseWorkspacesApi.ts
git mv tests/main/supabaseWorkspacesApi.cloudSessions.test.ts tests/shared/supabaseWorkspacesApi.cloudSessions.test.ts
git mv tests/main/supabaseWorkspacesApi.rowCount.test.ts tests/shared/supabaseWorkspacesApi.rowCount.test.ts
```

Dry-run 预期：`src/main/{index,workspaceManager,workspaceSessionShare}.ts`、`tests/main/workspaceManager.test.ts` 改指 `../shared/supabaseWorkspacesApi.js`（按位置）；挪走的文件自己 `../shared/x.js` → `./x.js`。

Run: `npm test`
Expected: 全绿（纯挪，测试总数不变）

```bash
git add -A src/main src/shared tests/main tests/shared
git commit -m "refactor(shared): supabaseWorkspacesApi 挪进 src/shared（#1356）

手机端的名册直连 Supabase 读主场、智能体、聊天清单（spec §5.2），用的正是这份查询。
它本来就只依赖 supabase-js 的类型与 src/shared，挪过去不改一行；桌面三个装配点改 import。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: 写 `ensureHomeWorkspace` 的失败用例**

`tests/shared/homeWorkspace.test.ts`：

```ts
// 主场「有就用、没有就建、两台设备同时建时回头重查」——手机与桌面共用这一段（#1356）。
// 判据是「回头重查」而不是错误码：PostgREST 的 code 在不同版本里挂的位置不一样（#1213）。
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureHomeWorkspace, type HomeWorkspaceDeps } from "../../src/shared/homeWorkspace.js";
import { HOME_WORKSPACE_NAME } from "../../src/shared/workspaces.js";

const client = {} as SupabaseClient;

function deps(o: Partial<HomeWorkspaceDeps>): HomeWorkspaceDeps {
  return {
    findHomeWorkspace: vi.fn(async () => null),
    createWorkspace: vi.fn(async () => ({ id: "made" })),
    ...o,
  };
}

describe("ensureHomeWorkspace", () => {
  it("已经有主场：直接用，不建", async () => {
    const d = deps({ findHomeWorkspace: vi.fn(async () => "home-1") });
    expect(await ensureHomeWorkspace(d, client, "u1")).toEqual({ id: "home-1" });
    expect(d.createWorkspace).not.toHaveBeenCalled();
  });

  it("没有：用 HOME_WORKSPACE_NAME 建一个 home", async () => {
    const d = deps({});
    expect(await ensureHomeWorkspace(d, client, "u1")).toEqual({ id: "made" });
    expect(d.createWorkspace).toHaveBeenCalledWith(client, HOME_WORKSPACE_NAME, "u1", "home");
  });

  it("建的时候撞了（另一台设备先建了）：回头重查，查得到就用它", async () => {
    const find = vi.fn<HomeWorkspaceDeps["findHomeWorkspace"]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("home-raced");
    const d = deps({ findHomeWorkspace: find, createWorkspace: vi.fn(async () => { throw new Error("23505"); }) });
    expect(await ensureHomeWorkspace(d, client, "u1")).toEqual({ id: "home-raced" });
  });

  it("建失败且重查也没有：抛原来那个错", async () => {
    const boom = new Error("rls");
    const d = deps({ createWorkspace: vi.fn(async () => { throw boom; }) });
    await expect(ensureHomeWorkspace(d, client, "u1")).rejects.toBe(boom);
  });

  it("重查本身又失败：仍抛原来那个错（原错误优先）", async () => {
    const boom = new Error("rls");
    const find = vi.fn<HomeWorkspaceDeps["findHomeWorkspace"]>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("network"));
    const d = deps({ findHomeWorkspace: find, createWorkspace: vi.fn(async () => { throw boom; }) });
    await expect(ensureHomeWorkspace(d, client, "u1")).rejects.toBe(boom);
  });
});
```

Run: `npx vitest run tests/shared/homeWorkspace.test.ts`
Expected: FAIL（找不到 `homeWorkspace.js`）

- [ ] **Step 4: 实现**

`src/shared/homeWorkspace.ts`：

```ts
// 个人主场（#1280，ADR-0297）：有就用、没有就建。桌面的 workspaceManager 与手机端的名册
// 共用这一段（#1356）——各写一份的话，「两台设备同时建」那条竞态只会被其中一端接住。
//
// 两台设备同时建时后到的那台撞 `workspaces_one_home_per_owner`。**不看错误码**——PostgREST
// 的 code 在不同版本里挂的位置不一样（#1213 的 23505 那次就踩过），而这里有一个比错误码
// 更硬的判据：回头重查。查得到就是抢输了（对用户来说什么都没发生），查不到才是真失败，
// 原错误优先。

import type { SupabaseClient } from "@supabase/supabase-js";
import { HOME_WORKSPACE_NAME } from "./workspaces.js";

export interface HomeWorkspaceDeps {
  findHomeWorkspace(client: SupabaseClient, selfUid: string): Promise<string | null>;
  createWorkspace(client: SupabaseClient, name: string, selfUid: string, kind: "home"): Promise<{ id: string }>;
}

export async function ensureHomeWorkspace(
  deps: HomeWorkspaceDeps,
  client: SupabaseClient,
  uid: string
): Promise<{ id: string }> {
  const found = await deps.findHomeWorkspace(client, uid);
  if (found !== null) return { id: found };
  try {
    return { id: (await deps.createWorkspace(client, HOME_WORKSPACE_NAME, uid, "home")).id };
  } catch (err) {
    const raced = await deps.findHomeWorkspace(client, uid).catch(() => null);
    if (raced !== null) return { id: raced };
    throw err;
  }
}
```

Run: `npx vitest run tests/shared/homeWorkspace.test.ts`
Expected: PASS

- [ ] **Step 5: 桌面改调它**

`src/main/workspaceManager.ts` 的 `async ensureHome() { … }` 整段换成：

```ts
    async ensureHome() {
      // 判据与竞态处理住在 src/shared/homeWorkspace.ts（#1356：手机端的名册共用这一段）
      return withSession((client, uid) => ensureHomeWorkspace(deps, client, uid));
    },
```

import 段加 `import { ensureHomeWorkspace } from "../shared/homeWorkspace.js";`；若 `HOME_WORKSPACE_NAME` 在这个文件里已没有别的用处，从 `../shared/workspaces.js` 那行 import 里删掉它。

- [ ] **Step 6: 跑门禁并提交**

Run: `npm test`
Expected: 全绿（`tests/main/workspaceManager.test.ts` 的 `ensureHome（#1280）` 五条照旧绿——它们现在经 `ensureHomeWorkspace` 走同一段逻辑）

```bash
git add src/shared/homeWorkspace.ts tests/shared/homeWorkspace.test.ts src/main/workspaceManager.ts
git commit -m "refactor(home): 主场「有就用、没有就建、撞了回头重查」抽进 shared（#1356）

手机端的名册进门时也要建主场（spec §5.2 的进门七态）。这 13 行里最要紧的是竞态那一支：
两台设备同时建时后到的那台撞唯一索引，判据是回头重查而不是错误码（#1213）。各写一份的话
这一支迟早只剩一端接得住。桌面 workspaceManager 改成调它，既有五条用例照旧绿。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 手机端单栈骨架——删三栏 / 投影 / 配对 / 好友，名册占位，精简账号页

**Files:**
- Create: `mobile/src/relay.ts`、`mobile/src/chrome/RoundButton.tsx`、`mobile/src/roster/AccountButton.tsx`、`mobile/src/roster/RosterScreen.tsx`
- Rewrite: `mobile/src/nav/types.ts`、`mobile/src/nav/RootNavigator.tsx`、`mobile/src/account/AccountScreen.tsx`、`mobile/App.tsx`
- Modify: `mobile/src/ui.tsx`
- Delete: `mobile/src/tabs/`、`mobile/src/projects/`、`mobile/src/pair/`、`mobile/src/friends/`、`mobile/src/friends.tsx`、`mobile/src/friendsApi.ts`、`mobile/src/nav/TabBar.tsx`、`mobile/src/nav/AvatarButton.tsx`、`mobile/src/chrome.tsx`、`mobile/src/link.tsx`、`mobile/src/session.ts`、`mobile/src/identity.ts`、`mobile/src/attach.ts`、`mobile/src/devicesApi.ts`、`mobile/src/deviceLabel.ts`、`mobile/src/haptics.ts`、`mobile/src/icons.tsx`

**Interfaces:**
- Consumes: 无（纯手机端）
- Produces（Task 8 与 A1 用）：`RootStackParams = { Roster: undefined; Account: undefined }`；`RoundButton({ children, onPress, label }: { children: ReactNode; onPress: () => void; label: string })`；`RELAY_BASE: string`（`mobile/src/relay.ts`）；`RosterScreen`。

依据：spec §11 第 2 条（维护者拍板删手机端旧代码）、§5.2（名册是根、搜索与 ＋ 在 A1 / A2 才画）。`src/shared/remote/` 里只剩桌面在用的那几份（`mobileBridge.ts`、`pairing.ts`……）**这一步不删**——协议与桌面侧不动，Task 9 开 issue 另判。

- [ ] **Step 1: 删掉用不到的文件**

```bash
git rm -r mobile/src/tabs mobile/src/projects mobile/src/pair mobile/src/friends
git rm mobile/src/friends.tsx mobile/src/friendsApi.ts mobile/src/nav/TabBar.tsx mobile/src/nav/AvatarButton.tsx mobile/src/chrome.tsx mobile/src/link.tsx mobile/src/session.ts mobile/src/identity.ts mobile/src/attach.ts mobile/src/devicesApi.ts mobile/src/deviceLabel.ts mobile/src/haptics.ts mobile/src/icons.tsx
```

- [ ] **Step 2: `mobile/src/relay.ts`**

```ts
// 中继（edge）的根地址。原来住在 session.ts（配对那条中继的装配），#1356 删掉配对之后单独留下：
// 账号页诊断那一行要它，A1 的云会话客户端也要它（role=guest 连 cs 房）。
// RN 里没有 process.env，relayBaseUrl 读的那个 env 传空对象即可 —— 走默认生产地址。
import { relayBaseUrl } from "../../src/shared/edgeConfig.js";

export const RELAY_BASE = relayBaseUrl({} as never);
```

- [ ] **Step 3: `mobile/src/chrome/RoundButton.tsx`**

```tsx
// 浮在内容上的圆钮（demo 的 .rbtn）：44 的毛玻璃圆，按下缩到 .93。名册头上那三颗、聊天页的
// 回退 / 设置都是它（spec §4）。毛玻璃 = expo-blur 一层 + 前景色 10% 叠一层（demo：
// color-mix(fg 10%, glass)）——只有 blur 的话浅色底上它会淡到看不见边。
// 关了动效时，按下的反馈退成变暗——反馈本身不能没有（同 ui.tsx 的 Button）。
import { BlurView } from "expo-blur";
import { useRef, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { PRESS_SPRING, usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";

export const ROUND_BUTTON_SIZE = 44;

export function RoundButton({ children, onPress, label }: {
  children: ReactNode;
  onPress: () => void;
  label: string;
}) {
  const { c, isDark } = usePalette();
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number): void => {
    if (!reduce) Animated.spring(scale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} hitSlop={6}
      onPressIn={() => to(0.93)} onPressOut={() => to(1)} onPress={onPress}
      style={({ pressed }) => [reduce && pressed && { opacity: 0.7 }]}
    >
      <Animated.View style={[styles.disc, { transform: [{ scale }] }]}>
        <BlurView intensity={40} tint={isDark ? "dark" : "light"} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(c.foreground, 0.1) }]} />
        <View style={styles.center}>{children}</View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  disc: {
    width: ROUND_BUTTON_SIZE, height: ROUND_BUTTON_SIZE, borderRadius: ROUND_BUTTON_SIZE / 2, overflow: "hidden",
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
```

（`withAlpha(color: string, alpha: number): string` 来自 `src/shared/color.ts`，经 `theme.ts` 转出。）

- [ ] **Step 4: `mobile/src/roster/AccountButton.tsx`**

```tsx
// 名册左上角那颗：进账号。demo 里它是一颗毛玻璃圆钮、里面是名字的首字（前景色，不是彩色头像）。
// 名字先取 OAuth 带来的 user_metadata，没有就用邮箱（原 nav/AvatarButton.tsx 的取法）。
// 右上角那枚「有应用等你登录」的点在 A5（spec §5.8）——数据源查清之前不画。
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { supabase } from "../supabase.js";
import { usePalette } from "../theme.js";
import { RoundButton } from "../chrome/RoundButton.js";

export function AccountButton({ onPress }: { onPress: () => void }) {
  const { c } = usePalette();
  const [name, setName] = useState("");
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user;
      const meta = (u?.user_metadata ?? {}) as { name?: string; full_name?: string };
      setName(meta.name ?? meta.full_name ?? u?.email ?? "");
    });
  }, []);
  return (
    <RoundButton label="账号" onPress={onPress}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: c.foreground }}>
        {(name.trim() || "·").slice(0, 1).toUpperCase()}
      </Text>
    </RoundButton>
  );
}
```

- [ ] **Step 5: `mobile/src/roster/RosterScreen.tsx`（占位）**

```tsx
// 名册（根）。A0 只立骨架：头上那颗账号钮 + 一句实话的空态。真数据（主场的智能体 + 群，
// 混排按最近一次动静）在 A1 接上（spec §5.2）。搜索与 ＋ 在 A1 / A2 才画——
// 点了什么都不发生的钮是撒谎的勾（#722）。
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { space, usePalette } from "../theme.js";
import { Card, Headline, Hint } from "../ui.js";
import { AccountButton } from "./AccountButton.js";

export function RosterScreen() {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {/* demo 的 .pillnav：状态栏下 8pt、左右 12pt，没有实心导航条 */}
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 12, flexDirection: "row", alignItems: "center" }}>
        <AccountButton onPress={() => navigation.navigate("Account")} />
      </View>
      <View style={{ padding: space.lg, gap: space.md }}>
        <Card>
          <Headline>智能体名册</Headline>
          <Hint>下一步在这里接上真数据：你的智能体和群聊，按最近一次动静排。</Hint>
        </Card>
      </View>
    </View>
  );
}
```

- [ ] **Step 6: 路由表与根导航**

`mobile/src/nav/types.ts`（全文覆盖）：

```ts
// 导航的路由表（#1356）：一个原生栈。第一层只有一个主语——我有哪几只智能体——名册是栈底，
// 其余一律推进来。
export type RootStackParams = {
  Roster: undefined;
  Account: undefined;
};

// 让不带泛型的 useNavigation() 也认得这些屏
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParams {}
  }
}
```

`mobile/src/nav/RootNavigator.tsx`（全文覆盖）：

```tsx
// 导航的根：一个原生栈（#1356，spec §4 / §5）。没有底栏、没有第二个根——一个只回答
// 「我有哪几只智能体」的 App 不需要第二个根。推入 / 返回 / 左缘右划都是系统的
// （react-native-screens = UINavigationController），天然可打断（ADR-0293 决定 2 原样成立）。
import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { usePalette } from "../theme.js";
import { RosterScreen } from "../roster/RosterScreen.js";
import { AccountScreen } from "../account/AccountScreen.js";
import type { RootStackParams } from "./types.js";

const Root = createNativeStackNavigator<RootStackParams>();

/** 导航的配色从 theme.ts 取：返回键是点缀色、导航栏底色就是地面 */
function useNavTheme(): Theme {
  const { c, isDark } = usePalette();
  const base = isDark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: c.brand, background: c.background, card: c.background,
      text: c.foreground, border: c.border, notification: c.brand,
    },
  };
}

export function RootNavigator() {
  const theme = useNavTheme();
  return (
    <NavigationContainer theme={theme}>
      <Root.Navigator>
        {/* 名册自己画浮在内容上的圆钮（demo 的 .pillnav），不要原生导航条 */}
        <Root.Screen name="Roster" component={RosterScreen} options={{ headerShown: false }} />
        <Root.Screen name="Account" component={AccountScreen} options={{ title: "账号", headerBackTitle: "返回" }} />
      </Root.Navigator>
    </NavigationContainer>
  );
}
```

- [ ] **Step 7: 精简账号页**

`mobile/src/account/AccountScreen.tsx`（全文覆盖）：

```tsx
// 账号页（A0 精简版，#1356）。完整的账号页——额度两扇窗、订阅、这周用了多少、它们共用的一台
// 电脑、设置——在 A5（spec §5.8）。原来的「好友」「配对的电脑」「记录与用量」随投影一起删了
// （spec §11 第 2 条）：那些数要电脑在线才算得出，而这个 App 从此不连自己的电脑。
//
// 形状是 iOS 的分组列表：邮箱与退出登录都属于账号，但退出登录单独一组、居中、红字——
// 破坏性动作不跟只读信息同一块板。
import { useEffect, useState } from "react";
import { View } from "react-native";
import { authNoticeOf, type AuthNotice } from "../../../src/shared/authError.js";
import { RELAY_BASE } from "../relay.js";
import { supabase } from "../supabase.js";
import { space } from "../theme.js";
import { Group, Page, Row } from "../ui.js";
import { NoticeLine } from "../gate/NoticeLine.js";
// 版本号只有一个事实来源：打包时用的就是这份 app.json 里的 expo.version
import appJson from "../../app.json";

export function AccountScreen() {
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null));
  }, []);

  // 登出之后回登录页由 App 那层的 onAuthStateChange 接住，这一屏不用管。
  // 但登出会失败：断网而 access token 又过期时，supabase 刷新不了 session，就原样留着本地那份、
  // 也不发 SIGNED_OUT——这时必须说出来，否则按钮转一下又回来，什么都没发生
  const [signOutNotice, setSignOutNotice] = useState<AuthNotice | null>(null);
  const signOut = (): void => {
    void (async () => {
      setBusy(true);
      setSignOutNotice(null);
      try {
        const { error } = await supabase.auth.signOut();
        if (error) setSignOutNotice(authNoticeOf(error.message));
      } catch (e: unknown) {
        setSignOutNotice(authNoticeOf(e instanceof Error ? e.message : String(e)));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Page>
      <View style={{ gap: space.lg }}>
        <Group header="账号">
          <Row label="邮箱" value={email ?? "读取中…"} />
        </Group>

        <Group>
          <Row
            label={busy ? "退出中…" : "退出登录"}
            align="center" tone="destructive"
            disabled={busy} onPress={signOut}
          />
        </Group>
        {signOutNotice ? <NoticeLine notice={signOutNotice} /> : null}

        {/* 纯诊断信息——不做成按钮，长按能选中拷走就够了 */}
        <Group header="连接" footer="出问题时把这两行长按拷下来一起发过来。">
          <Row label="中继" value={RELAY_BASE} mono />
          <Row label="版本" value={appJson.expo.version} mono />
        </Group>
      </View>
    </Page>
  );
}
```

（`Row` 的 `align` / `tone` / `mono` / `disabled` 这几个 prop 与原文件用法一致；tsc 会核。）

- [ ] **Step 8: App.tsx 去掉配对身份那一步**

`mobile/App.tsx` 的改动（其余一字不动）：
- 删掉这些 import：`import type { PinnedPeerStore } from "../src/shared/remote/devices.js";`、`import { openStore } from "./src/session.js";`、`import { LinkProvider } from "./src/link.js";`
- 文件头第 1 行改成：`// 手机端的入口：开屏 → 进门 → 名册（单栏，#1356）。`；第 5 行里的「三栏的导航在 src/nav/（ADR-0293）」改成「导航在 src/nav/（一个原生栈，#1356）」
- `/** 冷启动的步数：身份库、读 session。…*/ const BOOT_STEPS = 2;` 改成：

```ts
/** 冷启动的步数：读 session。进度条的「真实」那一半按它数（配对身份那一步随投影一起删了，#1356） */
const BOOT_STEPS = 1;
```

- 删掉 `const [store, setStore] = useState<PinnedPeerStore | null>(null);`
- 启动 effect 里删掉开头两行 `setStore(await openStore());` 与紧跟的 `setDone((n) => n + 1);`（保留读 session 之后的那一次 `setDone`）
- `gateView({ booted: store !== null && done >= BOOT_STEPS, … })` 改成 `gateView({ booted: done >= BOOT_STEPS, … })`
- `if (view === "app" && store) { … <LinkProvider store={store}><RootNavigator /></LinkProvider> … }` 改成：

```tsx
  if (view === "app") {
    return (
      <SafeAreaProvider>
        <RootNavigator />
      </SafeAreaProvider>
    );
  }
```

- 注释「状态栏字色:开屏 / 闸门 / 三栏都归这一处管」里的「三栏」改成「名册」

- [ ] **Step 9: ui.tsx 摘掉页签栏让位与两块只给删掉的屏用的组件**

`mobile/src/ui.tsx`：
- 删掉 `import { useTabInset } from "./chrome.js";`
- `Page` 里删掉 `const tabInset = useTabInset();` 与它上面那行注释，`paddingBottom: space.xl + tabInset` 改成 `paddingBottom: space.xl`
- 删掉 `export function CodeTiles(…)`（配对安全码，连同它上面的文档注释）与 `export function FolderIcon(…)`（项目组头，连同上面那段「文件夹」注释块）——只有删掉的屏用它们

其余通用组件（`Card` / `Note` / `Dot` / `Meta` / `Hint` / `Headline` / `Spinner` / `Button` / `Group` / `Row` / `Page` / `Avatar` / `Field` / `DetailBar` / `StatusLine` / `Tile` …）留着——A1 起会用到其中不少。

- [ ] **Step 10: 核对没有悬空引用**

Run: `grep -rnE "(session|link|chrome|identity|attach|devicesApi|deviceLabel|haptics|icons|friends|friendsApi)\.js\"|TabBar|AvatarButton|ProjectsRoot|TasksRoot|TeamsRoot|PairScreen|FriendsScreen|useLink|useTabInset" mobile/src mobile/App.tsx`
Expected: 没有输出

- [ ] **Step 11: 跑门禁并提交**

Run: `npm test`
Expected: 全绿（手机 tsc 在里面；Task 1 的「mobile 只 import shared」照旧绿）

```bash
git add -A mobile
git commit -m "feat(mobile): 导航换成单栈、根是名册占位；删掉三栏 / 投影 / 配对 / 好友（#1356）

维护者原话：手机 App 取消之前所有设定，不需要任务、项目和团队（#1321）。第一层只回答一句
「我有哪几只智能体」，所以没有底栏、没有第二个根：名册是栈底，账号推进来。
项目投影、扫码配对、好友、账号页里的电脑统计随之删掉（spec §11 第 2 条，git 里留着）；
src/shared/remote 的协议与桌面侧不动，桌面「配对手机」入口另开 issue 判。
名册在 A0 是一句实话的空态；搜索与 ＋ 在 A1 / A2 才画——点了什么都不发生的钮是撒谎的勾。
手机端依赖一个没删：这个 worktree 的 mobile/node_modules 是指向主 checkout 的软链。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 手机端 `<Face>` + 共用的钟 + 开发用陈列馆

**Files:**
- Create: `mobile/src/face/clock.ts`、`mobile/src/face/Face.tsx`、`mobile/src/dev/FaceGallery.tsx`
- Modify: `mobile/src/nav/types.ts`、`mobile/src/nav/RootNavigator.tsx`、`mobile/src/roster/RosterScreen.tsx`

**Interfaces:**
- Consumes: Task 3 的 `createFaceArtCache`、`faceArtKey`、`faceBox`、`FaceTier`、`facePhase`、`firstSlotOf`；Task 2 的 `faceAnimates`、`FaceState`、`GRID_W`、`GRID_H`、`DISC_COLOR`、`FACE_PACKS`、`FACE_STATE_LIST`、`FACE_STATES`；Task 7 的路由表
- Produces（A1 起用）：

```ts
export const Face: React.MemoExoticComponent<(p: {
  slot: number;
  state?: FaceState;      // 缺省 "plain"
  tier?: FaceTier;        // 缺省 "m"
  phase?: number;         // 毫秒偏移，名册用 facePhase(agentId)
  label?: string;         // 给读屏的一句话；不给就对读屏隐藏
  ringColor?: string;     // 角标外环的颜色，缺省 palette.background
}) => JSX.Element>;
export function subscribeFaceClock(fn: (now: number) => void): () => void;
```

A0 里没有任何一屏会画真智能体的脸（真数据在 A1）；陈列馆只在开发构建里出现，是在模拟器上对着 demo 核画法的唯一入口（同桌面 `scripts/build-face-gallery.mjs` 的用途）。

- [ ] **Step 1: `mobile/src/face/clock.ts`**

```ts
// 一口共用的钟（#1356）：会动的脸订阅它，25fps 一拍。有订阅者才跑、App 进后台就停——
// 每张脸各起一个定时器的话，一墙十几张脸就是十几个定时器各打各的。
// 25fps 不是省电的借口：这些位移全是整格的，60fps 里一多半帧与上一帧逐像素相同。
import { AppState } from "react-native";

type Tick = (now: number) => void;

const FPS = 25;
const subs = new Set<Tick>();
let timer: ReturnType<typeof setInterval> | null = null;
let active = AppState.currentState === "active";

function start(): void {
  if (timer !== null || !active || subs.size === 0) return;
  timer = setInterval(() => {
    const now = Date.now();
    for (const f of subs) f(now);
  }, 1000 / FPS);
}

function stop(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

AppState.addEventListener("change", (s) => {
  active = s === "active";
  if (active) start();
  else stop();
});

/** 订阅；立刻回调一次「此刻」，之后每拍一次。返回退订函数 */
export function subscribeFaceClock(fn: Tick): () => void {
  subs.add(fn);
  fn(Date.now());
  start();
  return () => {
    subs.delete(fn);
    if (subs.size === 0) stop();
  };
}
```

- [ ] **Step 2: `mobile/src/face/Face.tsx`**

```tsx
// Face —— 智能体的像素脸（#1356，spec §3.1）。判断全在 src/shared/ottoFace/（纯函数，进 vitest），
// 这里只把算好的几层画成 SVG：每种颜色一条 Path，viewBox 就是网格本身，缩放交给 SVG。
//
// · **盒子按脸的真实尺寸给**（网格 × 档位），不裁、不加圆底——demo 里被裁过三次。
// · 深色底上多画一圈浅色描边：这批脸的头发是纯黑的，贴在 #000 上整颗头会糊成一团。
// · 角标画在右上角：一个圆点 + 外圈一道 ringColor 的环，把它与头发隔开（桌面画在圆盘右下，
//   手机没有圆盘）。角标 = 声称，所以只有状态表里带角标的那几档才画。
// · **动不动由状态自己说**（faceAnimates），不另给开关；系统「减弱动态效果」开着时一律静止一帧。
//   会动的脸订阅一口共用的 25fps 钟，每拍只算 motion 键，键没变就不重画。
import { memo, useEffect, useState } from "react";
import { View } from "react-native";
import Svg, { Circle, G, Path } from "react-native-svg";
import { DISC_COLOR, GRID_H, GRID_W, faceAnimates, type FaceState } from "../../../src/shared/ottoFace/index.js";
import { createFaceArtCache, faceArtKey, faceBox, type FaceTier } from "../../../src/shared/ottoFace/art.js";
import { usePalette } from "../theme.js";
import { useReduceMotion } from "../ui.js";
import { subscribeFaceClock } from "./clock.js";

const artOf = createFaceArtCache();

/** 角标半径（格）、它离右上角的系数、外环倍数——比例口径同桌面 paint.ts（BADGE_R / INSET / RING） */
const BADGE_R = GRID_H * 0.14;
const BADGE_INSET = 1.1;
const BADGE_RING = 1.42;
/** 离线那一档整张脸压到这个透明度（同 paint.ts 的 DIM_ALPHA） */
const DIM_ALPHA = 0.45;

export const Face = memo(function Face({ slot, state = "plain", tier = "m", phase = 0, label, ringColor }: {
  slot: number;
  state?: FaceState;
  tier?: FaceTier;
  phase?: number;
  label?: string;
  ringColor?: string;
}) {
  const { c, isDark } = usePalette();
  const reduce = useReduceMotion();
  const animated = faceAnimates(state) && !reduce;
  const [t, setT] = useState(0);

  useEffect(() => {
    if (!animated) return;
    let last = "";
    return subscribeFaceClock((now) => {
      const at = now + phase;
      const k = faceArtKey(slot, state, at);
      if (k === last) return;
      last = k;
      setT(at);
    });
  }, [animated, slot, state, phase]);

  const art = artOf(slot, state, animated ? t : 0);
  const { w, h } = faceBox(tier);
  const cx = GRID_W - BADGE_R * BADGE_INSET;
  const cy = BADGE_R * BADGE_INSET;

  return (
    <View
      style={{ width: w, height: h }}
      {...(label === undefined
        ? { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const }
        : { accessible: true, accessibilityRole: "image" as const, accessibilityLabel: label })}
    >
      <Svg width={w} height={h} viewBox={`0 0 ${GRID_W} ${GRID_H}`}>
        {isDark && art.rim !== "" ? <Path d={art.rim} fill={DISC_COLOR} /> : null}
        <G opacity={art.dim ? DIM_ALPHA : 1}>
          {art.layers.map((l) => <Path key={l.tone} d={l.d} fill={l.color} />)}
        </G>
        {art.badge !== null ? (
          <G>
            <Circle cx={cx} cy={cy} r={BADGE_R * BADGE_RING} fill={ringColor ?? c.background} />
            <Circle cx={cx} cy={cy} r={BADGE_R} fill={art.badge} />
          </G>
        ) : null}
      </Svg>
    </View>
  );
});
```

- [ ] **Step 3: `mobile/src/dev/FaceGallery.tsx`**

```tsx
// 形象陈列馆——**只在开发构建里出现**（#1356 A0）。A1 之前手机上没有任何一屏会画真智能体的脸，
// 这一屏是在模拟器上对着 demo 核一遍画法的唯一入口：11 张脸、全部表情、三档尺寸、深浅两套底
// （切系统外观看描边）。同桌面 scripts/build-face-gallery.mjs 的用途，不是产品的一部分。
import { ScrollView, Text, View } from "react-native";
import {
  FACE_PACKS,
  FACE_STATE_LIST,
  FACE_STATES,
  firstSlotOf,
} from "../../../src/shared/ottoFace/index.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import { space, type as t, usePalette } from "../theme.js";
import { Face } from "../face/Face.js";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { c } = usePalette();
  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ ...t.footnote, color: c.mutedForeground }}>{title}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "flex-end" }}>
        {children}
      </View>
    </View>
  );
}

function Caption({ children }: { children: string }) {
  const { c } = usePalette();
  return <Text style={{ ...t.footnote, fontSize: 10.5, color: c.mutedForeground, textAlign: "center" }}>{children}</Text>;
}

export function FaceGallery() {
  const specs = firstSlotOf("specs") ?? 0;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      <Section title="11 个角色 · alive · m 档（错开相位，不该一起眨眼）">
        {FACE_PACKS.map((p) => (
          <Face key={p.id} slot={firstSlotOf(p.id) ?? 0} state="alive" tier="m" phase={facePhase(p.id)} label={p.name} />
        ))}
      </Section>
      <Section title="全部表情 · specs · m 档">
        {FACE_STATE_LIST.map((s) => (
          <View key={s} style={{ alignItems: "center", gap: 4 }}>
            <Face slot={specs} state={s} tier="m" />
            <Caption>{FACE_STATES[s].zh}</Caption>
          </View>
        ))}
      </Section>
      <Section title="三档 · working（s / m / l）">
        <Face slot={specs} state="working" tier="s" />
        <Face slot={specs} state="working" tier="m" />
        <Face slot={specs} state="working" tier="l" />
      </Section>
    </ScrollView>
  );
}
```

- [ ] **Step 4: 开发构建里挂上它**

`mobile/src/nav/types.ts` 的 `RootStackParams` 加一行 `FaceGallery: undefined;`。

`mobile/src/nav/RootNavigator.tsx`：import `import { FaceGallery } from "../dev/FaceGallery.js";`，在 `Account` 那一行下面加：

```tsx
        {/* 形象陈列馆：只在开发构建里有（#1356 A0，见 dev/FaceGallery.tsx 头注） */}
        {__DEV__ ? (
          <Root.Screen name="FaceGallery" component={FaceGallery} options={{ title: "形象陈列馆", headerBackTitle: "返回" }} />
        ) : null}
```

`mobile/src/roster/RosterScreen.tsx`：import 里加 `Button`（`from "../ui.js"`），在 `</Card>` 之后加：

```tsx
        {__DEV__ ? (
          <Button variant="quiet" label="形象陈列馆（开发用）" onPress={() => navigation.navigate("FaceGallery")} />
        ) : null}
```

（`Button` 收 `label` 字符串，不收子元素——见 `mobile/src/ui.tsx` 的 `export function Button(props: { label: string; … })`。）

- [ ] **Step 5: 跑门禁并提交**

Run: `npm test`
Expected: 全绿（手机 tsc 核 Face / clock / 陈列馆；Task 1 的断言核 import 面）

```bash
git add mobile/src/face mobile/src/dev mobile/src/nav mobile/src/roster
git commit -m "feat(mobile): 智能体的像素脸画进手机——react-native-svg，每种颜色一条 Path（#1356）

判断全在 src/shared/ottoFace（Task 3 的行程 / 描边 / 画好的几层），这里只画 SVG：
viewBox 就是网格，盒子按脸的真实尺寸给、不裁不加圆底（demo 被裁过三次）；深色底多一圈
浅色描边代替桌面的圆盘；角标在右上角。会动的脸订阅一口共用的 25fps 钟、每拍只算 motion 键，
键没变就不重画——一墙脸不会各起一个定时器。
陈列馆只在开发构建里出现：A1 之前没有任何一屏画真智能体的脸，这是在模拟器上核画法的唯一入口。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 文档——ADR、README、AGENTS.md 索引、spec 回写、两条 issue

**Files:**
- Create: `docs/adr/0317-手机端改成智能体单栏-形象用SVG画-云会话客户端挪进shared.md`
- Modify: `mobile/README.md`、`AGENTS.md`（只动 Where to find things）、`docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md`（§10 末尾追加）

**Interfaces:**
- Consumes: Task 1–8 的全部产物
- Produces: 文档；两条 GitHub issue 编号（写进 ADR 与 PR 正文）

- [ ] **Step 1: 开 issue（先开，ADR 要引用它的编号）**

```bash
gh issue create --title "手机端改成智能体单栏之后：桌面「配对手机」没有对端、手机依赖与投影协议的手机那一半待清" --body "#1356 A0 删掉了手机端的项目投影、扫码配对与好友（spec 2026-09-23 §11 第 2 条，维护者拍板）。留下三件事，都不在 A0 里做：

1. **桌面「配对手机」入口从此没有对端**：桌面设置里还能生成配对码、remoteBridge 还在等手机连进来，而手机上已经没有扫码 / 配对的屏。要么收起桌面那个入口，要么给手机一条新的用途——维护者定。
2. **手机端没用上的依赖**：expo-camera（连同 app.json 里那条相机权限插件）、expo-image-picker、expo-image-manipulator、expo-file-system、expo-device、expo-secure-store、@noble/{ciphers,curves,hashes}。A0 没删，因为 worktree 的 mobile/node_modules 是指向主 checkout 的软链，在那里 npm uninstall 会改到所有 lane 共用的那一份——要在一份独立安装里做。
3. **src/shared/remote 里只剩桌面一侧在用的手机那一半**（mobileBridge.ts 等）：协议是否整体收掉，跟第 1 条一起判。"
```

记下返回的 issue 号，下面记作 `#P`。

```bash
gh issue comment 1254 --body "#1321 / #1356 把手机端重做成「智能体」单栏（维护者：不需要任务、项目和团队），手机任务栏这一条在新架构里不再做。spec：docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md（§2、§11）。是否关闭这条由维护者定。"
```

- [ ] **Step 2: 写 ADR**

先确认编号：`ls docs/adr | tail -3`，取 `max + 1`（起草时是 0317；合并前 Task 10 会再核一次）。

`docs/adr/0317-手机端改成智能体单栏-形象用SVG画-云会话客户端挪进shared.md`：

```markdown
# ADR-0317：手机端改成智能体单栏；形象在 RN 上用 SVG 画；云会话客户端挪进 shared

- 日期：2026-09-23
- 状态：已接受
- Task issue：#1356（上游 #1321：demo 已过）
- 关系：**推翻 ADR-0293 决定 1**（三栏）与决定 5（配对不再是进门的一步——配对整个删了）；决定 2（原生栈）、3（依赖只取 Expo Go 自带）、4（图标经 react-native-svg）、6（进门判据两端共用）、7（表单与确认用居中弹窗）原样成立。**ADR-0094「手机端是第三个投影窗口」的手机那一半作废**，桌面侧不动（#P）。spec `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md`；plan `docs/superpowers/plans/2026-09-23-mobile-agents-a0-foundation.md`

## 背景

维护者原话（#1321）：「手机 App 里面取消之前所有设定，不需要任务、项目和团队。手机 App 模仿 Grokbot，只需要实现桌面端的智能体功能。」demo 过了之后要实现，先有三块未知：像素脸在 RN 上怎么画、手机端没有云会话客户端、名字能不能空着（维护者选了必填）。

## 决定

1. **一个原生栈，名册是栈底**。第一层只回答「我有哪几只智能体」，所以没有底栏、没有第二个根。任务 / 项目 / 团队三栏、项目投影、扫码配对、好友、账号页里的电脑统计在手机端删掉（git 里留着）。
2. **像素脸用 react-native-svg 画**：一帧拆成横向行程，每种颜色一条 `<Path>`，`viewBox` 就是网格。纯层（角色、状态表、`composeFrame`）挪进 `src/shared/ottoFace/`，两端同一份源；手机端只剩画 SVG 的一层和一口共用的 25fps 钟，按 motion 键去重。否决 skia（新原生依赖，SVG 已经够用）、expo-gl（一墙脸就是十几个 GL 上下文，App Store 版 Expo Go 真机缺它）、预渲染 PNG 序列（丢掉同一份源，状态表一改就过期）。
3. **新增 `alive` 一档**：眨眼 + 呼吸、没有角标。名册那一墙要「活着但不声称任何事」——名册查不到谁在跑（#722 / #1282），而角标在这套东西里是「声称」。这是 ADR-0316「会动的那几档都画了角标」唯一的例外，那条断言改成显式列出 `plain` 与 `alive`。
4. **手机不画圆盘**：盒子按脸的真实尺寸给（demo「不许裁」）；深色底上多画一圈浅色描边，代替桌面圆盘解决「纯黑头发贴黑底」的那件事；角标画在右上。
5. **云会话客户端、workspaces API、时间线那批纯函数挪进 `src/shared/`**，手机端做第二个客户端。客户端运行时本来就只依赖 `src/shared/remote`、传输 / 令牌 / 推送全是注入的；会话列表那一行（要 better-sqlite3 那层的 `SessionSummary`）拆到 `src/main/cloudSessionFleet.ts` 留在桌面。否决手机端抄一份（协议状态机抄两份必然分家）与手机跨目录 import 渲染层。
6. **两条新架构断言**：`src/shared` 不 import `src/main` / `src/renderer`；`mobile/` 在自身之外只 import `src/shared/**` 与 `MOBILE_SAFE` 那几份 `src/session/` 文件。

## 后果

- 桌面回归面：客户端、workspaces API、ottoFace 纯层、十三个渲染层纯函数搬了家；靠「只挪不改断言」与门禁兜。
- 桌面「配对手机」入口从此没有对端，手机端没用上的依赖还装着（#P）。
- 手机上没有好友了。
- `alive` 在桌面暂无消费方（陈列馆脚本多画一格）。
- 手机上 s 档（每格 0.5 点）在 @3x 屏上是每格 1.5 个物理像素，边缘可能有半像素的混色；真机与模拟器上核过再定要不要换档位（spec §12 第 5 条）。
- 真机一次没跑过。
```

（把正文里的 `#P` 换成 Step 1 拿到的真实编号。）

- [ ] **Step 3: mobile/README.md**

读一遍 `mobile/README.md`，把描述「任务 / 项目 / 团队三栏」「配对电脑」「看时间线 + 审批」的句子改成下面这段意思（保留原有的「怎么跑」「Expo Go」「prebuild」段落，改掉与现状不符的：`mobile/` 的类型检查**已经**在根门禁里——ADR-0294；邮箱密码登录**在前面**不是折叠的）：

```markdown
手机端是「智能体」单栏（#1321 / #1356，ADR-0317）：第一层只回答「我有哪几只智能体」——一个原生栈，名册是栈底。
每只智能体一条永久的私聊线，几只可以拉成一个群；它们跑在你账号的云端电脑上（个人主场），手机和桌面是同一个云会话的两个客户端。
A0 只立了基座（名册是占位，真数据在 A1）；进度见 spec `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md` §8。

纯逻辑一律住 `src/shared/`、测试在 `tests/shared/`；手机端在自身之外只 import `src/shared/**`（`tests/architecture.test.ts` 有断言）。
`mobile/` 的类型检查在根门禁里（ADR-0294）：跑门禁前先 `npm --prefix mobile ci` 一次。
```

- [ ] **Step 4: AGENTS.md 索引里的旧路径**

先确认要改的行：`grep -nE "src/renderer/src/lib/(ottoFace|agentAvatarSlot|agentAvatar|chatBubbles|cloudStreaming|dayLabel|systemNote|proxyShare|workspaceView|billingView|cloudTimeline|workspaceAccess|agentRoster|agentMentionInput)|src/main/(cloudSessionClient|supabaseWorkspacesApi)\.ts" AGENTS.md`。

用下面的脚本做逐字替换（在仓库根目录跑）：

```bash
python3 - <<'PY'
import re
p = "AGENTS.md"
s = open(p, encoding="utf-8").read()
libs = ["agentAvatarSlot","agentAvatar","chatBubbles","cloudStreaming","dayLabel","systemNote","proxyShare",
        "workspaceView","billingView","cloudTimeline","workspaceAccess","agentRoster","agentMentionInput"]
n0 = len(s)
for name in libs:
    s = s.replace(f"src/renderer/src/lib/{name}.ts", f"src/shared/{name}.ts")
    s = s.replace(f"`lib/{name}.ts`", f"`src/shared/{name}.ts`")
s = s.replace("src/renderer/src/lib/ottoFace/", "src/shared/ottoFace/")
s = s.replace("`lib/ottoFace/`", "`src/shared/ottoFace/`")
s = s.replace("src/main/cloudSessionClient.ts", "src/shared/remote/cloudSessionClient.ts")
s = s.replace("src/main/supabaseWorkspacesApi.ts", "src/shared/supabaseWorkspacesApi.ts")
open(p, "w", encoding="utf-8").write(s)
print("done", n0, len(s))
PY
grep -cE "src/renderer/src/lib/(ottoFace|agentAvatarSlot|agentAvatar|chatBubbles|cloudStreaming|dayLabel|systemNote|proxyShare|workspaceView|billingView|cloudTimeline|workspaceAccess|agentRoster|agentMentionInput)|src/main/(cloudSessionClient|supabaseWorkspacesApi)\.ts" AGENTS.md
```

Expected: 最后一行输出 `0`

再手改四条手机端条目（行号以 grep 为准）：

(a) `- \`mobile/src/nav/\` / \`mobile/src/gate/\` / \`src/shared/mobileGate.ts\` — 手机端三栏壳与进门（ADR-0293，#1237）：每一栏一个原生栈，账号 / 好友 / 配对在根栈；配对不再是进门的一步；` 这一段开头改成：

```
- `mobile/src/nav/` / `mobile/src/gate/` / `src/shared/mobileGate.ts` — 手机端的栈与进门：**一个原生栈、名册是栈底**（#1356，ADR-0317 推翻 ADR-0293 的三栏）；
```

（该条目后面讲进门判据的内容原样保留。）

(b) `- \`mobile/src/friends.tsx\` / \`mobile/src/friendsApi.ts\` / \`src/shared/friendsQuery.ts\` — 手机端好友：…` 整条换成：

```
- `src/shared/friendsQuery.ts` — 好友的纯查询逻辑（桌面在用）。手机端的好友屏 #1356 随单栏重做删掉了（ADR-0317）
```

(c) `src/shared/remote/` / `src/main/remoteBridge.ts` 那一条与 `src/shared/remote/pairing.ts` 那一条末尾各加一句：`手机那一半 #1356 删了（ADR-0317），桌面侧入口待 #P 判。`

(d) 在 `- \`src/shared/ottoFace/\` / \`characters/\` / …`（上面替换后的 ottoFace 条目）**之后**加一条：

```
- `src/shared/ottoFace/{runs,art}.ts` / `mobile/src/face/{Face.tsx,clock.ts}` — **手机端画像素脸**（#1356，ADR-0317）：一帧拆成横向行程、每种颜色一条 react-native-svg 的 `<Path>`，`viewBox` 就是网格；盒子按脸的真实尺寸给（s / m / l = 每格 0.5 / 1 / 2 点），**不画圆盘**（demo「不许裁」），深色底上一圈浅色描边（`faceRim`）代替桌面的圆盘，角标在右上。会动的脸订阅一口共用的 25fps 钟，按 `frameMotion` 的键去重——同一个 motion 画出来的帧逐格相同（有断言）。名册那一墙用 `alive`：眨眼 + 呼吸、没有角标，是「会动的都画角标」唯一的例外。开发构建里名册有一个入口进形象陈列馆（`mobile/src/dev/FaceGallery.tsx`）
```

- [ ] **Step 5: spec §10 回写 A0 期间的偏离**

在 `docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md` 的 §10 那行「（写 plan / 实现期间的偏离追加在这里。）」**之前**追加：

```markdown
15. **A0 没删手机端依赖**：worktree 的 `mobile/node_modules` 是指向主 checkout 的软链，在那里装卸会改到所有 lane 共用的那一份；没用上的依赖另开 issue 清（ADR-0317 后果第 2 条）。
16. **开发构建里多一屏形象陈列馆**：A1 之前没有任何一屏画真智能体的脸，这是在模拟器上核画法的唯一入口；生产构建里没有（`__DEV__`）。
17. **`ui.tsx` 只摘了两个专属组件**（配对安全码、项目文件夹图标）：其余通用组件留着给 A1 用。
```

（若 Task 1–8 执行中还有别的偏离，一并按序号追加。）

- [ ] **Step 6: 跑门禁并提交**

Run: `npm test`
Expected: 全绿（`tests/docs/adrNumbers.test.ts` 核 ADR 编号唯一且不跳号）

```bash
git add docs/adr mobile/README.md AGENTS.md docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md
git commit -m "docs: A0 的 ADR、手机端 README、索引路径跟上搬家（#1356）

ADR-0317 记三件事：手机端改成智能体单栏（推翻 ADR-0293 的三栏、ADR-0094 的手机那一半）、
像素脸在 RN 上用 SVG 画（含 alive 是「会动都画角标」唯一例外的理由）、云会话客户端与时间线
纯函数挪进 shared。AGENTS.md 只动 Where to find things（L2）：十几条索引的路径跟着搬家改，
手机端那几条改写，加一条手机端画脸的入口。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 收尾——门禁、模拟器冒烟、PR

**Files:** 无新增（只在冒烟发现问题时回到对应 Task 修）

- [ ] **Step 1: 全量门禁**

Run: `npm test > $S/a0-gate.log 2>&1; echo "GATE_EXIT=$?" >> $S/a0-gate.log; tail -6 $S/a0-gate.log`
Expected: `Test Files … passed`、`GATE_EXIT=0`

- [ ] **Step 2: 模拟器冒烟（Expo Go）**

在 `mobile/` 下起 Metro：`npx expo start --ios`（后台跑）。在 iOS 模拟器里逐项核：
1. 冷启动 → 登录卡（进门那几屏与改动前一样）；登录后落在**名册占位**（左上一颗毛玻璃圆钮、下面一张「智能体名册」卡）。
2. 点左上圆钮 → 账号页只有「邮箱 / 退出登录 / 中继 · 版本」三组；左缘右划能返回。
3. 名册上「形象陈列馆（开发用）」→ 11 张脸各自在眨眼呼吸、**不同时眨**；全部表情那一排里 `working` / `searching` / `solving` 在动、`queued` / `plain` 不动、`waiting` 横着摆、`frozen` 灰掉；三档 s / m / l 大小对。
4. 切系统外观（Settings → Developer → Dark Appearance，或 `xcrun simctl ui booted appearance dark`）→ 深色底上每张脸外有一圈浅色描边、头发不糊进底色；角标外环跟着底色走。
5. 放大截图看 s 档：边缘若有明显的半像素混色，把现象记进 PR 正文与 spec §12 第 5 条（不在 A0 里改档位）。
6. 退出登录 → 回到登录卡。

模拟器或 Expo Go 起不来（例如 Xcode 许可证拦住 simctl）：照实写进 PR 正文「模拟器冒烟没跑成：<原因>」，不跳过也不假装跑过。

- [ ] **Step 3: 推送并开 PR**

```bash
git fetch origin
git log --oneline origin/main -1
ls docs/adr | tail -3
```

若 main 上已经有了 `0317-*`：把本分支的 ADR 改号成 `max + 1`，文件顶部加一行 `原为 ADR-0317`，全仓引用（AGENTS.md、spec §10、ADR 自身、commit 之后的文档）一起改（项目 ADR-0074），**不要全局替换**——只改指向这条 ADR 的引用，改完 `git grep -n "0317"` 逐条核。

```bash
git push -u origin claude/elated-bohr-d2f4de
gh pr create --title "feat(mobile): 智能体单栏 A0——基座（共享层搬家、手机画像素脸、单栈导航）" --body "$(cat <<'EOF'
Task issue: #1356（A0，spec §8）。Spec：`docs/superpowers/specs/2026-09-23-mobile-agents-app-design.md`；plan：`docs/superpowers/plans/2026-09-23-mobile-agents-a0-foundation.md`；ADR-0317。

## 做了什么
- **共享层搬家（桌面改 import，测试只挪不改断言）**：ottoFace 纯层、云会话客户端（会话列表那一行拆到 `src/main/cloudSessionFleet.ts` 留在桌面）、`supabaseWorkspacesApi`、十三个时间线 / 名册纯函数 → `src/shared/`；主场那 13 行抽成 `ensureHomeWorkspace` 两端共用。
- **ottoFace 新增**：`alive` 态（眨眼 + 呼吸、无角标——「会动都画角标」唯一的例外）、`frameMotion` / `motionKey`（帧去重）、`faceLayers` / `runsPath` / `faceRim`、`createFaceArtCache` / `faceBox` / `facePhase`、`firstSlotOf`。
- **手机端**：一个原生栈、名册是栈底（A0 是占位）；`<Face>`（react-native-svg，每色一条 Path，不画圆盘，深色描边，右上角标）+ 一口共用的 25fps 钟；开发构建里的形象陈列馆；删掉三栏 / 项目投影 / 配对 / 好友（维护者拍板，spec §11）。
- **两条新架构断言**：shared 不反指 main / renderer；mobile 只 import shared。

## 没做 / 另开
- 桌面「配对手机」入口没有对端、手机端没用上的依赖、投影协议的手机那一半：#P。
- 名册真数据、私聊、智能体设置：A1。

## 验证
- `npm test`：<贴 Test Files / Tests 那两行与 GATE_EXIT>
- 模拟器冒烟：<逐项结果，或「没跑成：原因」>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

（把 `#P` 与两处尖括号换成真实内容。）

- [ ] **Step 4: 等 CI 绿、合并、收尾**

CI 绿之后（`gh pr checks <PR号>`；零 check 时它会秒退，按 sha 自己轮询）用 **merge commit** 合并：`gh pr merge <PR号> --merge`。合并后：
- `git fetch origin && git ls-tree origin/main docs/adr | grep 0317` 再核一次编号没被同时合并的别的 PR 占掉（占了就开一个改号 PR，同 Step 3 的改法）。
- 在 #1356 上评论 A0 已合（PR 号、ADR 号、#P），并写明下一步是 A1 的 plan。
