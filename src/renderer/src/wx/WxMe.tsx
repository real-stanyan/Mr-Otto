// WxMe —— 桌面微信式布局（#1386）「我」那一栏的主区：个人信息、订阅与额度、它们共用的一台电脑
// （文件 / 应用 / 记忆 / 这周谁用得多）、设置。
//
// 能复用的一律复用：个人信息 = `ProfileCard`（换头像、改名字，与首登引导同一份 ProfileEditor）；
// 订阅与额度 = `BillingSettings`（账号页那一整块，价目 / 额度 / checkout / Portal 的判据都在里面）；
// 电脑那四格 = 团队设置里那四格（传主场的快照，WorkspacePage 给主场留的正是这四格）。
// 这一层只管每一页的标题、一句说明和居中的那一列。

import { useEffect, useState, type ReactNode } from "react";
import { NavStack, type NavScreen } from "@/components/ui/nav-stack.js";
import { Check, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { InsetGroup, InsetNote, InsetRow } from "@/components/ui/inset-list.js";
import { cn } from "@/lib/utils.js";
import { useChat } from "../store.js";
import { ProfileCard } from "../components/ProfileCard.js";
import { BillingSettings } from "../components/BillingSettings.js";
import { WorkspaceFilesTab } from "../components/WorkspaceFilesTab.js";
import { WorkspaceConnectorsTab } from "../components/WorkspaceConnectorsTab.js";
import { WorkspaceWikiTab } from "../components/WorkspaceWikiTab.js";
import { WorkspaceUsageTab } from "../components/WorkspaceUsageTab.js";
import { themeController, type ThemePref } from "../theme.js";
import { WxIconButton } from "./ui.js";
import { useWxDialog } from "./WxDialogs.js";
import { homeOf } from "../../../shared/agentRoster.js";

export type MeSection = "profile" | "quota" | "files" | "apps" | "memory" | "usage" | "settings";

const TITLES: Record<MeSection, { title: string; lead: string }> = {
  profile: { title: "个人信息", lead: "名字和头像朋友、群里的人都看得到。邮箱是登录用的，这里改不了。" },
  quota: { title: "订阅与额度", lead: "额度按周算，每周一 00:00 刷新。" },
  files: { title: "文件", lead: "智能体干活的那台电脑，你的几只共用一个文件夹。" },
  apps: { title: "应用", lead: "智能体能替你用的外部账号。授权一次，几只共用。" },
  memory: { title: "记忆", lead: "它们一起记着的事，一页一页的。你也能改——存了之后，它们下一次开口就按新的来。" },
  usage: { title: "这周谁用得多", lead: "每只占了你本周额度的多少。" },
  settings: { title: "设置", lead: "" },
};

export function MePane({ section, onBack }: { section: MeSection; onBack: () => void }) {
  const { title, lead } = TITLES[section];
  const wide = section === "files" || section === "quota";
  // 整页是一个 NavStack：「应用」里的添加主机、「记忆」里的编辑页是**推进来**的二级页（那几格
  // 本来就是为团队设置的推入式导航写的，`useNav()` 离了 NavStack 直接抛错）。根页的导航条不写字，
  // 大标题照 demo 画在正文里（20px，不用 NavStack 那枚 27px 的 largeTitle）；窄窗时导航条左边是返回
  const root: NavScreen = {
    key: `me:${section}`,
    title: "",
    leading: (
      <WxIconButton title="返回" onClick={onBack} className="hidden max-[560px]:grid">
        <ChevronLeft className="size-5" aria-hidden />
      </WxIconButton>
    ),
    render: () => (
      <div className="flex flex-col gap-[18px] px-2 pt-1">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">{title}</h2>
          {lead !== "" && <p className="m-0 text-[13px] leading-[1.6] text-muted-foreground">{lead}</p>}
        </div>
        <MeBody section={section} />
      </div>
    ),
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* key = section：NavStack 只在挂载那一刻读 root，换一格要整棵栈重挂（上一格推进去的二级页跟着走） */}
      <NavStack
        key={section}
        root={root}
        dragBar
        contentClassName={cn("mx-auto", wide ? "w-[min(760px,100%)]" : "w-[min(560px,100%)]")}
      />
    </div>
  );
}

function MeBody({ section }: { section: MeSection }) {
  const selfUid = useChat((s) => s.account.id);
  // 主场从 store 现读、不从 props 进：NavStack 只在挂载那一刻拿 root，闭包里捕获的快照会一直停在那一刻
  const home = useChat((s) => homeOf(s.workspaceGroups));
  // 电脑那四格要主场；没订阅（或主场还没建起来）的人点不到这几行，这里再兜一次
  const needsHome = section === "files" || section === "apps" || section === "memory" || section === "usage";
  if (needsHome && home === null) {
    return <p className="m-0 text-[13px] text-muted-foreground">订阅之后才有自己的智能体和它们的电脑。</p>;
  }
  switch (section) {
    case "profile":
      return <ProfileSection />;
    case "quota":
      return <BillingSettings />;
    case "files":
      return home === null ? null : <WorkspaceFilesTab key={home.id} ws={home} />;
    case "apps":
      return home === null ? null : <WorkspaceConnectorsTab ws={home} selfUid={selfUid} backLabel="应用" />;
    case "memory":
      return home === null ? null : <WorkspaceWikiTab key={home.id} ws={home} />;
    case "usage":
      return home === null ? null : <WorkspaceUsageTab ws={home} />;
    case "settings":
      return <SettingsSection />;
  }
}

function ProfileSection() {
  const openDialog = useWxDialog();
  return (
    <>
      <div className="rounded-[12px] bg-card p-[18px]">
        <ProfileCard signOut={false} />
      </div>
      <InsetGroup>
        <InsetRow title="密码" chevron trailing="改密码" onClick={() => openDialog({ kind: "password" })} />
      </InsetGroup>
    </>
  );
}

const THEMES: { value: ThemePref; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

function SettingsSection() {
  const [pref, setPref] = useState<ThemePref>(() => themeController().pref());
  const updater = useChat((s) => s.updater);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (updater?.phase !== "checking") setChecking(false);
  }, [updater?.phase]);
  const pick = (p: ThemePref): void => {
    themeController().setPref(p);
    setPref(p);
  };
  const check = async (): Promise<void> => {
    setChecking(true);
    try {
      await window.otter.updaterCheckNow();
    } finally {
      setChecking(false);
    }
  };
  const version = updater?.currentVersion ?? "";
  let updateLine: ReactNode = null;
  if (updater !== null) {
    switch (updater.phase) {
      case "available":
        updateLine = (
          <Button size="sm" onClick={() => void window.otter.updaterStartDownload()}>
            下载 {updater.version}
          </Button>
        );
        break;
      case "downloading":
        updateLine = `正在下载 ${updater.version}…`;
        break;
      case "ready":
        updateLine = (
          <Button size="sm" onClick={() => void window.otter.updaterInstallAndRestart()}>
            重启并更新到 {updater.version}
          </Button>
        );
        break;
      case "manual":
        updateLine = (
          <Button variant="secondary" size="sm" onClick={() => void window.otter.updaterOpenReleasePage()}>
            去下载 {updater.version}
          </Button>
        );
        break;
      case "error":
        updateLine = <span className="text-err">{updater.message}</span>;
        break;
      case "disabled":
        updateLine = updater.reason;
        break;
      default:
        updateLine = (
          <Button variant="secondary" size="sm" disabled={checking || updater.phase === "checking"} onClick={() => void check()}>
            {checking || updater.phase === "checking" ? "正在检查…" : "检查更新"}
          </Button>
        );
    }
  }
  return (
    <>
      <div>
        <div className="px-1 pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">外观</div>
        <InsetGroup>
          {THEMES.map((t) => (
            <InsetRow
              key={t.value}
              title={t.label}
              onClick={() => pick(t.value)}
              trailing={pref === t.value ? <Check className="size-4 text-brand" aria-hidden /> : null}
            />
          ))}
        </InsetGroup>
      </div>
      <div>
        <div className="px-1 pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">版本</div>
        <InsetGroup>
          <InsetRow title={version !== "" ? `Mr Otto ${version}` : "Mr Otto"} trailing={updateLine} />
        </InsetGroup>
        <InsetNote>智能体和聊天记录都在云上，换一台电脑登录还在。</InsetNote>
      </div>
    </>
  );
}
