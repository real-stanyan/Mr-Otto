// 三把 Git 刀（#1105，ADR 见 spec 决策 5）：`clone_repo` / `git_push` /
// `create_repo`。
//
// **三把全部 `requiresApproval: true`。** 这就是「团队开着免审也管不到它们」
// 的落地方式，而且是**由构造保证**的：`sessionService` 的 `policyApprover` 只对
// `tool === bashTool || tool === writeFileTool` 放行（按工具身份比，不按名字，
// ADR-0231），新刀天然不在射程里。
//
// **凭据不进水獭那台容器**（ADR-0200 决策②）：要 token 的两步（clone、push 前
// 查默认分支、push 本身）全部跑在一次性旁路容器里；不要 token 的那一步（探目标
// 目录）跑在团队容器上，它只读。
//
// 三把刀的**任何**输出都过 `sanitizeCloneText`——git 经常把整条带 userinfo 的
// URL 原样回显进 stderr，而这些话会进日志、进群聊。

import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import {
  CLONE_REPO_TOOL_NAME, CREATE_REPO_TOOL_NAME, GIT_PUSH_TOOL_NAME,
  cloneTargetState, parseCloneArgs, parseCreateRepoArgs, parsePushArgs, pushesDefaultBranch,
} from "../../../src/shared/gitTools.js";
import { hostOfRepoUrl } from "../../../src/shared/remote/gitHost.js";
import { validateRepoUrl } from "../../../src/shared/remote/cloudSession.js";
import {
  buildCloneProbeScript, buildDefaultBranchScript, buildPushScript,
  parseCloneProbe, parseDefaultBranch, parsePushOutput,
} from "./gitScripts.js";

/** 三把刀共用的执行面。`sessionService` 在装配时接上真身，测试给假货 */
export interface GitToolDeps {
  workspaceId: string;
  /** 这台主机有没有存过 token（`null` = 没有）。**取 token 的唯一入口** */
  tokenFor: (host: string) => string | null;
  /** 在团队容器里跑一段只读脚本（探目标目录）。不碰凭据 */
  execInWorkspace: (script: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** 在一次性旁路容器里跑一段要凭据的脚本。`repoUrl`/`pat` 只到那台容器为止 */
  execInSidecar: (
    cfg: { repoUrl: string; pat?: string },
    script: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** 直接把一个仓库 clone 进 `/work/<dest>`（旁路容器 + 凭据，`cloneWithSidecar`） */
  clone: (cfg: { repoUrl: string; pat?: string }, dest: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 擦掉任何输出里的凭据（`sanitizeCloneText`） */
  sanitize: (text: string, cfg: { repoUrl: string; pat?: string }) => string;
  /** 此刻这一轮是谁点起来的（`currentInitiator`）+ 他此刻的显示名。`null` =
      查不到。**async**：名字要现查（改名之后下一次提交就是新名字） */
  initiator: () => Promise<{ uid: string; label: string } | null>;
  /** GitHub REST。抽成 dep 是为了单测能在 HTTP 层打假、不去打真 GitHub */
  githubApi: (
    path: string,
    init: { method: string; token: string; body?: unknown },
  ) => Promise<{ status: number; json: unknown }>;
}

/** `create_repo` 只做 GitHub。别家 provider 的建仓 API 各不相同，做抽象层是在
    没有第二个消费方的时候先付抽象的钱；凭据模型按 host 分派，加一家不改形状 */
const GITHUB_HOST = "github.com";

export function createGitTools(deps: GitToolDeps): Tool[] {
  return [cloneRepoTool(deps), gitPushTool(deps), createRepoTool(deps)];
}

function cloneRepoTool(deps: GitToolDeps): Tool {
  return {
    def: {
      name: CLONE_REPO_TOOL_NAME,
      description:
        "把一个 Git 仓库 clone 进工作文件夹的某个子目录。会弹审批卡请用户确认仓库与落地路径。" +
        "私有仓库需要团队在「连接器 → 代码仓库」里存过这台主机的访问令牌；令牌不会经过你，也不会进这个容器。" +
        "目标目录非空且不是同一个仓库时会被拒绝——换一个路径，不要试图先删掉它。",
      parameters: {
        type: "object",
        properties: {
          repo_url: { type: "string", description: "https 仓库地址，例如 https://github.com/acme/widgets.git" },
          dest: { type: "string", description: "工作文件夹里的相对子目录，例如 code/widgets（不能是根目录）" },
        },
        required: ["repo_url", "dest"],
      },
    },
    exposure: "direct",
    requiresApproval: true,
    async run(raw: unknown, _world: ExecutionWorld) {
      const args = parseCloneArgs(raw);
      const valid = validateRepoUrl(args.repoUrl);
      if (!valid.ok) throw new Error(valid.message);

      const host = hostOfRepoUrl(valid.url);
      const pat = host === null ? null : deps.tokenFor(host);
      const cfg = pat === null ? { repoUrl: valid.url } : { repoUrl: valid.url, pat };

      // ① 探目标目录。只读，不要凭据，跑在团队容器上
      const probeOut = await deps.execInWorkspace(buildCloneProbeScript(args.dest));
      const probe = parseCloneProbe(probeOut.stdout);
      if (probe.kind === "denied") throw new Error(`dest 解析之后落在了工作文件夹外面：${args.dest}`);
      if (probe.kind === "notdir") throw new Error(`${args.dest} 已经是一个文件，不是目录`);
      if (probe.kind === "unparsable") {
        // **认不出来就停手**，不当成空目录往里 clone（同 ADR-0200 决策③）
        throw new Error(`探不清 ${args.dest} 此刻是什么，先别 clone：${deps.sanitize(probe.detail, cfg)}`);
      }

      // ② 三态。**任何一条都不删文件**
      const state = cloneTargetState({ entries: probe.entries, origin: probe.origin }, valid.url);
      if (state === "same-repo") return `${args.dest} 里已经是这个仓库了，没有重新 clone。`;
      if (state === "occupied") {
        throw new Error(
          `${args.dest} 里已经有东西了（${probe.entries} 个条目），没有动它。换一个空目录，或者先让用户确认那里可以清掉。`
        );
      }

      // ③ clone。凭据只到旁路容器为止
      const r = await deps.clone(cfg, args.dest);
      if (!r.ok) throw new Error(`clone 失败：${r.reason}`);
      return `已经 clone 到 ${args.dest}。`;
    },
  };
}

function gitPushTool(deps: GitToolDeps): Tool {
  return {
    def: {
      name: GIT_PUSH_TOOL_NAME,
      description:
        "把某个子目录里的改动提交并推到远端的一条分支。会弹审批卡请用户确认仓库、分支、改了几个文件和提交信息。" +
        "**不能推默认分支（main/master 那条），也不能强推**——要合进主干请用户自己去开 PR。" +
        "提交的作者记的是这一轮的发起人，不是你。" +
        "推永远要凭据（公开仓库也一样）：团队得先在「团队设置 → 连接器 → 代码仓库」存过这台主机的访问令牌，没存过会直接告诉你去哪儿加。",
      parameters: {
        type: "object",
        properties: {
          dest: { type: "string", description: "clone 下来的那个子目录，例如 code/widgets" },
          branch: { type: "string", description: "要推到的分支名，例如 otto/fix-checkout。不能是默认分支" },
          message: { type: "string", description: "提交信息，说清楚改了什么" },
        },
        required: ["dest", "branch", "message"],
      },
    },
    exposure: "direct",
    requiresApproval: true,
    async run(raw: unknown, _world: ExecutionWorld) {
      const args = parsePushArgs(raw);

      // 作者 = 点火的那个人（spec §4.2 不给 agent 发伪身份）。查不到就拒绝，不伪造
      const who = await deps.initiator();
      if (who === null) throw new Error("查不到这次是谁发起的，无法署名提交；请让发起人再 @ 我一次");

      // 仓库地址从目标目录现查——push 的对象是那个工作副本已经绑定的 origin，
      // 让模型再传一遍地址只会多一个能填错的地方
      const probeOut = await deps.execInWorkspace(buildCloneProbeScript(args.dest));
      const probe = parseCloneProbe(probeOut.stdout);
      if (probe.kind !== "ok" || probe.origin === "") {
        throw new Error(`${args.dest} 不是一个连着远端的 Git 工作副本，推不了。`);
      }
      const host = hostOfRepoUrl(probe.origin);
      const pat = host === null ? null : deps.tokenFor(host);
      // 推**永远**要凭据（公开仓也一样；clone 那把不需要，所以两把的判据不同）。
      // 没存 token 时不进旁路容器让 git 撞 `could not read Username`——模型读到那句
      // 只会说「沙箱不允许推」（#1206 真机原话），在起容器之前就把人指到那一页。
      // 措辞与 create_repo 逐字同一条路径
      if (pat === null) {
        throw new Error(
          `这个团队还没有存 ${host ?? "这台主机"} 的访问令牌——请团队所有者去「团队设置 → 连接器 → 代码仓库」加一台。`
        );
      }
      const cfg = { repoUrl: probe.origin, pat };

      // 默认分支现查。**查不到也拒绝**（ADR-0243：没有任何输入能让这一轮更松）
      const headOut = await deps.execInSidecar(cfg, buildDefaultBranchScript(args.dest));
      const defaultBranch = parseDefaultBranch(headOut.stdout);
      if (pushesDefaultBranch(args.branch, defaultBranch)) {
        throw new Error(
          defaultBranch === null
            ? "查不到这个仓库的默认分支，所以这一次不推——查不到的时候按最坏情况算。稍后再试，或让用户自己推。"
            : `不能推默认分支 ${defaultBranch}。换一条分支（例如 otto/xxx），再让用户去开 PR。`
        );
      }

      const out = await deps.execInSidecar(
        cfg,
        buildPushScript({
          dest: args.dest,
          branch: args.branch,
          message: args.message,
          authorName: who.label,
          // 不用真邮箱——我们手上没有，编一个更糟。这个地址是诚实的：
          // 它指认得出人，又不假装是他的信箱
          authorEmail: `${who.uid}@users.noreply.mrotto.app`,
        })
      );
      const result = parsePushOutput(out.stdout + "\n" + out.stderr);
      if (!result.pushed) throw new Error(`push 失败：${deps.sanitize(result.detail, cfg)}`);
      return result.committed
        ? `已提交并推到 ${args.branch}。`
        : `没有新的改动可提交，已经把当前内容推到 ${args.branch}。`;
    },
  };
}

function createRepoTool(deps: GitToolDeps): Tool {
  return {
    def: {
      name: CREATE_REPO_TOOL_NAME,
      description:
        "在 GitHub 上新建一个空仓库。会弹审批卡请用户确认——**仓库建在存放令牌的那个 GitHub 账号名下**，" +
        "不是发起人名下。建完只回地址，要不要拉进工作文件夹是下一步的事（用 clone_repo）。只支持 GitHub。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "仓库名，字母数字加 - _ ." },
          private: { type: "boolean", description: "是否私有，默认 true" },
        },
        required: ["name"],
      },
    },
    exposure: "direct",
    requiresApproval: true,
    async run(raw: unknown, _world: ExecutionWorld) {
      const args = parseCreateRepoArgs(raw);
      const token = deps.tokenFor(GITHUB_HOST);
      if (token === null) {
        throw new Error(
          "这个团队还没有存 github.com 的访问令牌——请团队所有者去「团队设置 → 连接器 → 代码仓库」加一台。"
        );
      }

      const res = await deps.githubApi("/user/repos", {
        method: "POST",
        token,
        body: { name: args.name, private: args.private, auto_init: false },
      });
      if (res.status < 200 || res.status >= 300) {
        // 照 humanizeMcpError 的规矩：只翻认得出的，认不出的原样留
        const message = githubErrorText(res.status, res.json);
        throw new Error(`建仓库失败：${message}`);
      }
      const url = readString(res.json, "clone_url") ?? readString(res.json, "html_url");
      const owner = readString(readObject(res.json, "owner"), "login");
      if (url === null) throw new Error("GitHub 说建好了，但没回仓库地址——去 GitHub 上确认一下。");
      return `已在 ${owner === null ? "令牌所属账号" : `@${owner}`} 名下建好${args.private ? "私有" : "公开"}仓库：${url}`;
    },
  };
}

/** GitHub 的错误只翻认得出的三种；其余原样带回（同 `humanizeMcpError` 的规矩：
    认不出的原样留着比翻译成一句笼统的话有用） */
function githubErrorText(status: number, json: unknown): string {
  const raw = readString(json, "message") ?? "";
  if (status === 401) return "令牌无效或已过期，请所有者换一把。";
  if (status === 403 && raw.includes("scope")) return `令牌权限不够（缺 repo scope）：${raw}`;
  if (status === 422 && raw.includes("already exists")) return "同名仓库已经存在了，换个名字。";
  return raw === "" ? `HTTP ${status}` : `${raw}（HTTP ${status}）`;
}

function readObject(v: unknown, key: string): unknown {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;
}

function readString(v: unknown, key: string): string | null {
  const got = readObject(v, key);
  return typeof got === "string" && got !== "" ? got : null;
}
