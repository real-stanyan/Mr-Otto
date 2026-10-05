// 发起一个群，带上某位朋友（#1393）：朋友资料页的「拉进群聊」、朋友私聊 ⊕ 里的「拉人建群」共用这一张。
// 底下就是 PickAgentsDialog（只挑朋友那一段），这里只多管「建」那一下：建成了先刷名册、再把新群的 id 交出去
// （名册里还没有它时推进去是一页「已经不在了」）。群建在我的个人主场里。
// #1682（ADR-0376）起新群只拉朋友：每个人带着自己的管理员进来，不再挑智能体（runtime 也不看帧里的 agentIds）。
import { useMemo, useState } from "react";
import { mixedGroupName } from "../../../src/shared/chatGuests.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { useFriends } from "../friends/friendsStore.js";
import { refreshHomeAfterWrite } from "../home/homeStore.js";
import { PickAgentsDialog } from "./PickAgentsDialog.js";
import { friendPeople } from "./people.js";

export function NewGroupDialog({ visible, ws, selfUid, title, lead, presetPeople = [], onClose, onCreated, onExited }: {
  visible: boolean;
  /** 我的个人主场 */
  ws: WorkspaceSnapshot;
  selfUid: string;
  title: string;
  lead: string;
  presetPeople?: readonly string[];
  onClose: () => void;
  /** 建成了、名册也刷过了：交出新群的 id（调用方先收弹窗，退场放完再推那一页） */
  onCreated: (sessionId: string) => void;
  onExited?: () => void;
}) {
  const friends = useFriends();
  const people = useMemo(() => friendPeople(friends.rows, new Set([selfUid])), [friends.rows, selfUid]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <PickAgentsDialog
      visible={visible}
      ws={ws}
      title={title}
      lead={lead}
      options={[]}
      min={1}
      people={people}
      presetPeople={presetPeople}
      okLabel="建群"
      withName
      busy={busy}
      error={error}
      onOk={(_picked, name, pickedPeople) => {
        setBusy(true);
        setError(null);
        const named = people.filter((p) => pickedPeople.includes(p.uid)).map((p) => ({ name: p.name }));
        cloudClient
          .create(ws.id, {
            kind: "group",
            name: mixedGroupName(ws, [], named, name),
            agentIds: [],
            humans: pickedPeople,
          })
          .then(async (r) => {
            if (!r.ok) throw new Error(r.message);
            await refreshHomeAfterWrite();
            onCreated(r.value.sessionId);
          })
          .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }}
      onClose={onClose}
      {...(onExited === undefined ? {} : { onExited })}
    />
  );
}
