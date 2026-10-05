// build_app —— 应用专员把沙箱里写好的一个目录变成一版应用（#1591，spec §3.3）：
// 读目录 → 清单与文件表过静态检查（src/shared/apps.ts）→ 逐个文件上传到 Storage → 记 apps / app_versions → 对话里落一张应用卡。
// 不打 zip（plan 小修 1）：手机按文件表逐个下载。文件从容器里读走 base64（world.fs.read 不是二进制安全的）。
// 只依赖注入的回调（硬规则「工具只依赖接口」）：不知道 docker、不知道 supabase。
import { createHash } from "node:crypto";
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import {
  APP_FILE_BYTES_MAX, APP_FILES_MAX, APP_MANIFEST_FILE, APP_WORK_ROOT, BUILD_APP_TOOL_NAME, appObjectPath, checkAppFiles, contentTypeOf,
  isTextExtension, parseAppManifest, safeRelPath, type AppFileEntry,
} from "../../../src/shared/apps.js";
import type { AppStore } from "./appStore.js";
import { APP_BRIDGE_JS } from "../../../src/shared/appBridge.js";

/** 沙箱里跑的那段检查（jsdom）：每一页开一遍、等 1.5 秒，收脚本报错；桥用一个假的（storage 回空）。
    退出码 4 = 页面报错（stdout 是 JSON 数组）；别的非零 = 检查本身没跑起来（不拦，回执里说一句） */
export const APP_CHECK_JS = `
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs"), path = require("path");
const [dir, ...pages] = process.argv.slice(2);
const BRIDGE = ${JSON.stringify(APP_BRIDGE_JS)};
const errs = [];
(async () => {
  for (const p of pages) {
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => errs.push(p + "：" + String((e && e.detail && e.detail.message) || (e && e.message) || e)));
    const file = path.join(dir, p);
    const dom = new JSDOM(fs.readFileSync(file, "utf8"), {
      url: "file://" + file, runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(w) {
        w.ReactNativeWebView = { postMessage(raw) { try { const m = JSON.parse(raw); if (m && m.id) setTimeout(() => w.__ottoReply && w.__ottoReply(m.id, true, ["storage.list", "room.list", "room.rooms"].includes(m.method) ? [] : null), 5); } catch (_) {} } };
        w.eval(BRIDGE);
      },
    });
    await new Promise((r) => setTimeout(r, 1500));
    dom.window.close();
  }
  if (errs.length > 0) { console.log(JSON.stringify(errs.slice(0, 5))); process.exit(4); }
  console.log("ok");
})().catch((e) => { console.error(String(e)); process.exit(3); });
`;

/** 装一次 jsdom（缓存在 /work/.otto/appcheck），把检查脚本落盘，跑每一页 */
export function appCheckScript(dir: string, pages: readonly string[]): string {
  const b64 = Buffer.from(APP_CHECK_JS, "utf8").toString("base64");
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    "set -e",
    "CK=/work/.otto/appcheck",
    'mkdir -p "$CK" && cd "$CK"',
    '[ -d node_modules/jsdom ] || { npm init -y >/dev/null 2>&1; npm i jsdom@24 --no-audit --no-fund --silent >/dev/null 2>&1 || exit 5; }',
    `echo ${b64} | base64 -d > check.js`,
    `node check.js ${q(`/work/${dir}`)} ${pages.map(q).join(" ")}`,
  ].join("\n");
}

export interface BuildAppDeps {
  agentId: string;
  workspaceId: string;
  ownerUid: string;
  /** 在工作区容器里跑一段 shell（同 git 那几把刀的 execInWorkspace） */
  exec: (script: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** 传一个对象到 otto-apps 桶 */
  upload: (path: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  store: AppStore;
  /** 落一张应用卡（app_card 事件） */
  card: (e: { appId: string; version: number; name: string; icon: string; note: string }) => void;
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function createBuildAppTool(deps: BuildAppDeps): Tool {
  return {
    def: {
      name: BUILD_APP_TOOL_NAME,
      description:
        `把你写在 /work/${APP_WORK_ROOT}/<slug>/ 下的应用打成一版交给主人。目录里要有 ${APP_MANIFEST_FILE}（name / slug / icon / entry / capabilities / ` +
        `description / design）和入口页；多页用相对路径互链。没有外网：不要外链脚本、不要 fetch，要数据走 window.otto。` +
        `每次调用出一个新版本（同一个 slug 就是同一个应用的下一版）。打完主人聊天里会出一张卡，点开就能用。` +
        `要和好友一起玩 / 一起记的，清单 capabilities 加 room，用 otto.room：current()（不在房间回 null）/ create({title}) / invite()（弹好友选择）/ rooms() / open(id) / leave()；` +
        `共享数据 get(key) / list(prefix) / set(key, value, {ifRev}) → {ok, rev} 或 {ok:false, rev, value}（回合制落子带 ifRev 防抢写，0 = 只在还没有时写）/ remove(key)；` +
        `即时消息 send(msg)（≤ 4 KB、每秒 ≤ 20 条）；ping(text) 推给其他成员（轮到谁了）；事件 otto.on('room.change' | 'room.message' | 'room.members' | 'room.closed', cb)。个人的东西仍放 otto.storage。`,
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: `目录，形如 ${APP_WORK_ROOT}/<slug>（相对 /work）` },
          note: { type: "string", description: "这一版改了什么，一句话" },
        },
        required: ["dir"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld) {
      const a = (args ?? {}) as Record<string, unknown>;
      const dir = typeof a.dir === "string" ? a.dir.trim().replace(/^\/?work\//, "").replace(/\/+$/, "") : "";
      if (dir === "" || !safeRelPath(dir) || !dir.startsWith(`${APP_WORK_ROOT}/`)) throw new Error(`dir 要是 ${APP_WORK_ROOT}/<slug> 这样的相对目录`);
      const note = typeof a.note === "string" ? a.note.replace(/\s+/g, " ").trim().slice(0, 200) : "";
      // ① 列文件（路径 \t 字节数），只要常规文件
      const ls = await deps.exec(`cd /work/${shq(dir)} 2>/dev/null || exit 3; find . -type f -printf '%P\\t%s\\n' | head -n ${APP_FILES_MAX + 1}`);
      if (ls.exitCode === 3) throw new Error(`/work/${dir} 不存在——先把文件写进去`);
      if (ls.exitCode !== 0) throw new Error(`列目录失败：${ls.stderr.trim() || ls.stdout.trim()}`);
      const listed = ls.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "").map((l) => {
        const [path, size] = l.split("\t");
        return { path: path ?? "", size: Number(size ?? "0") };
      });
      if (listed.length > APP_FILES_MAX) throw new Error(`文件太多（超过 ${APP_FILES_MAX} 个）——把没用的删掉`);
      const tooBig = listed.find((f) => f.size > APP_FILE_BYTES_MAX);
      if (tooBig !== undefined) throw new Error(`${tooBig.path} 太大（单文件最多 ${APP_FILE_BYTES_MAX / 1024} KB）`);
      // ② 逐个读走（base64：world 的读法不是二进制安全的）
      const files: { path: string; size: number; bytes: Uint8Array; text: string | null }[] = [];
      for (const f of listed) {
        if (!safeRelPath(f.path)) throw new Error(`路径不合规：${f.path}`);
        const r = await deps.exec(`base64 -w0 -- /work/${shq(`${dir}/${f.path}`)}`);
        if (r.exitCode !== 0) throw new Error(`读不了 ${f.path}：${r.stderr.trim()}`);
        const bytes = new Uint8Array(Buffer.from(r.stdout.trim(), "base64"));
        files.push({ path: f.path, size: bytes.length, bytes, text: isTextExtension(f.path) ? Buffer.from(bytes).toString("utf8") : null });
      }
      // ③ 清单 + 静态检查
      const mf = files.find((f) => f.path === APP_MANIFEST_FILE);
      if (mf === undefined || mf.text === null) throw new Error(`目录里要有 ${APP_MANIFEST_FILE}`);
      let manifestRaw: unknown;
      try {
        manifestRaw = JSON.parse(mf.text);
      } catch {
        throw new Error(`${APP_MANIFEST_FILE} 不是合法的 JSON`);
      }
      const manifest = parseAppManifest(manifestRaw);
      const problem = checkAppFiles({ manifest, files });
      if (problem !== null) throw new Error(problem);
      // ③½ 在沙箱里 headless 开一遍每一页（spec §3.3 ②；真机 2026-10-05：日历记事本 bind() 里用了没缓存的 el.prev，
      // 一打开就 TypeError、月历一格都没画——静态检查看不出来）。页面报错就不打包；检查本身没跑起来不拦，回执里说一句
      const pages = files.filter((f) => f.path.endsWith(".html")).map((f) => f.path);
      const check = await deps.exec(appCheckScript(dir, pages));
      let checkNote = "";
      if (check.exitCode === 4) {
        let errs: string[] = [];
        try { errs = JSON.parse(check.stdout.trim().split("\n").at(-1) ?? "[]") as string[]; } catch { errs = [check.stdout.trim().slice(0, 500)]; }
        throw new Error(`页面一打开就报错，没打包：\n${errs.map((e) => `- ${e}`).join("\n")}\n改好再调 build_app。`);
      }
      if (check.exitCode !== 0) checkNote = "（这次没能在沙箱里试开页面，打开后要是不对劲就跟主人说一声）";
      // ④ 找 / 建应用行，定版本号
      const existing = await deps.store.findBySlug(deps.workspaceId, manifest.slug);
      const app = existing ?? (await deps.store.create({
        workspaceId: deps.workspaceId, ownerUid: deps.ownerUid, slug: manifest.slug, name: manifest.name, icon: manifest.icon,
        description: manifest.description, createdByAgent: deps.agentId,
      }));
      const version = app.currentVersion + 1;
      // ⑤ 上传（先传文件、再记版本：记了版本手机就会去下，文件得先在）
      const entries: AppFileEntry[] = [];
      for (const f of files) {
        await deps.upload(appObjectPath(deps.ownerUid, app.id, version, f.path), f.bytes, contentTypeOf(f.path));
        entries.push({ path: f.path, size: f.size, sha256: createHash("sha256").update(f.bytes).digest("hex") });
      }
      await deps.store.recordVersion({ appId: app.id, version, manifest, files: entries, builtByAgent: deps.agentId, note, name: manifest.name, icon: manifest.icon, description: manifest.description });
      deps.card({ appId: app.id, version, name: manifest.name, icon: manifest.icon, note });
      return `「${manifest.name}」v${version} 已打好（${files.length} 个文件，每一页都在沙箱里试开过${checkNote === "" ? "、没报错" : ""}）。主人聊天里有一张卡，点开就能用；要改就改文件再调一次 build_app。${checkNote}`;
    },
  };
}
