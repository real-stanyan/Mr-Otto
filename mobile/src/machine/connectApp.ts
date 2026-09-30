// 接入编排的手机端接线（spec §3）：判据与两步顺序在 src/shared/connectFlow.ts（进 vitest），这里只递真依赖。
import * as WebBrowser from "expo-web-browser";
import {
  disconnectWith, lendToTeamWith, type ConnectDeps, type TeamDeps,
} from "../../../src/shared/connectFlow.js";
import { deleteConnectorRow, upsertConnectorRow } from "../../../src/shared/supabaseWorkspacesApi.js";
import { supabase } from "../supabase.js";
import { removeApp, setGrant, startConnect } from "./connectorsApi.js";

// ConnectOutcome 的注意事项（serverId 只是信号、要重拉视图）写在它的定义处
export { runConnect, type ConnectDeps, type ConnectOutcome } from "../../../src/shared/connectFlow.js";

export const realConnectDeps: ConnectDeps = {
  startConnect,
  openAuth: (url, redirect) => WebBrowser.openAuthSessionAsync(url, redirect),
};

const teamDeps: TeamDeps = {
  setGrant,
  removeApp,
  upsertRow: (row) => upsertConnectorRow(supabase, row),
  deleteRow: (workspaceId, hostUid, serverId) => deleteConnectorRow(supabase, workspaceId, hostUid, serverId),
};

export function lendToTeam(o: { serverId: string; workspaceId: string; on: boolean; label: string; uid: string }): Promise<void> {
  return lendToTeamWith(teamDeps, o);
}

export function disconnect(o: { serverId: string; uid: string; workspaceIds: readonly string[] }): Promise<void> {
  return disconnectWith(teamDeps, o);
}
