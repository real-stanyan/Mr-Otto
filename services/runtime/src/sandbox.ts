// 沙箱编排 — 每工作区一容器一卷，dockerode 直管（ADR-0199）。
// 命名约定 `otto-ws-<workspaceId>`：容器名与卷名共用同一个字符串，
// ensure/destroy/reconcile 都靠它按名找容器，不额外维护一张 workspaceId→containerId 表。
//
// 孤儿回收两阶段：reconcile 第一次见到"标签里的 workspace 不在 validIds 里"的容器只记一笔
// markedTs（内存 + 注入的 orphans 存取器落盘），过 orphanGraceMs（默认 7 天）才真删——
// 宽限期是留给"workspace 记录还没同步过来"这种误判空间，不是立刻判死刑。

import type { ContainerLike } from "../../../src/world/dockerWorld.js";

/** dockerode 顶层句柄的最小注入面 */
export interface DockerLike {
  listContainers(opts: {
    all: boolean;
    filters: string;
  }): Promise<{ Id: string; Names: string[]; State: string; Labels: Record<string, string> }[]>;
  getContainer(id: string): {
    start(): Promise<void>;
    stop(): Promise<void>;
    remove(opts: { force: boolean }): Promise<void>;
    update(opts: Record<string, unknown>): Promise<void>;
  } & ContainerLike;
  createContainer(opts: Record<string, unknown>): Promise<{ id: string }>;
  listVolumes(opts: { filters: string }): Promise<{ Volumes: { Name: string; Labels: Record<string, string> | null }[] }>;
  getVolume(name: string): { remove(): Promise<void> };
}

/** 孤儿标记表的存取——测试给内存假货，daemon 给 `/var/lib/otto-runtime/orphans.json` 的文件版 */
export interface OrphansStore {
  load(): Record<string, number>;
  save(m: Record<string, number>): void;
}

export interface Sandbox {
  ensure(workspaceId: string): Promise<ContainerLike>;
  markActive(workspaceId: string): void; // 每条 turn 起跑时打点
  sweepIdle(runningWorkspaces: ReadonlySet<string>): Promise<string[]>; // 停掉的 workspaceId 列表；跑着 turn 的不停
  reconcile(validWorkspaceIds: ReadonlySet<string>): Promise<{ marked: string[]; removed: string[] }>;
  destroy(workspaceId: string): Promise<void>; // 容器+卷一起删（工作区删除级联）
}

const DEFAULT_IMAGE = "otto-sandbox";
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const WORKSPACE_LABEL = "mrotto.workspace";

function containerName(workspaceId: string): string {
  return `otto-ws-${workspaceId}`;
}

function memoryOrphansStore(): OrphansStore {
  let data: Record<string, number> = {};
  return {
    load: () => ({ ...data }),
    save: (m: Record<string, number>) => {
      data = { ...m };
    },
  };
}

export function createSandbox(
  docker: DockerLike,
  opts?: { image?: string; idleMs?: number; orphanGraceMs?: number; now?: () => number; orphans?: OrphansStore },
): Sandbox {
  const image = opts?.image ?? DEFAULT_IMAGE;
  const idleMs = opts?.idleMs ?? DEFAULT_IDLE_MS;
  const orphanGraceMs = opts?.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const now = opts?.now ?? (() => Date.now());
  const orphansStore = opts?.orphans ?? memoryOrphansStore();

  const lastActive = new Map<string, number>();

  function markActive(workspaceId: string): void {
    lastActive.set(workspaceId, now());
  }

  /** 按名查容器——docker 的 Names 带前导斜杠（"/otto-ws-x"），两种形式都认 */
  async function findByName(name: string) {
    const list = await docker.listContainers({ all: true, filters: JSON.stringify({ name: [name] }) });
    return list.find((c) => c.Names.some((n) => n === name || n === `/${name}`));
  }

  async function ensure(workspaceId: string): Promise<ContainerLike> {
    const name = containerName(workspaceId);
    const found = await findByName(name);

    let id: string;
    if (!found) {
      const created = await docker.createContainer({
        name,
        Image: image,
        Cmd: ["sleep", "infinity"],
        Labels: { [WORKSPACE_LABEL]: workspaceId },
        HostConfig: {
          Memory: 2 * 1024 ** 3,
          NanoCpus: 2e9,
          PidsLimit: 512,
          Mounts: [{ Type: "volume", Source: name, Target: "/work" }],
        },
      });
      id = created.id;
      const container = docker.getContainer(id);
      await container.start();
      markActive(workspaceId);
      return container;
    }

    id = found.Id;
    const container = docker.getContainer(id);
    if (found.State !== "running") {
      await container.start();
    }
    markActive(workspaceId);
    return container;
  }

  async function sweepIdle(runningWorkspaces: ReadonlySet<string>): Promise<string[]> {
    const stopped: string[] = [];
    for (const [workspaceId, t] of lastActive) {
      if (runningWorkspaces.has(workspaceId)) continue;
      if (now() - t <= idleMs) continue;

      const found = await findByName(containerName(workspaceId));
      if (found && found.State === "running") {
        await docker.getContainer(found.Id).stop();
        stopped.push(workspaceId);
      }
    }
    return stopped;
  }

  async function reconcile(validWorkspaceIds: ReadonlySet<string>): Promise<{ marked: string[]; removed: string[] }> {
    const marked: string[] = [];
    const removed: string[] = [];
    const orphans = orphansStore.load();

    const list = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [WORKSPACE_LABEL] }),
    });

    for (const c of list) {
      const workspaceId = c.Labels[WORKSPACE_LABEL];
      if (!workspaceId) continue;
      if (validWorkspaceIds.has(workspaceId)) continue; // 不是孤儿

      const markedAt = orphans[workspaceId];
      if (markedAt === undefined) {
        orphans[workspaceId] = now();
        marked.push(workspaceId);
        continue;
      }

      if (now() - markedAt > orphanGraceMs) {
        await docker.getContainer(c.Id).remove({ force: true }); // 先删容器
        await docker.getVolume(containerName(workspaceId)).remove(); // 卷被容器占用，顺序反了会失败
        delete orphans[workspaceId];
        removed.push(workspaceId);
      }
    }

    orphansStore.save(orphans);
    return { marked, removed };
  }

  async function destroy(workspaceId: string): Promise<void> {
    const name = containerName(workspaceId);
    const found = await findByName(name);
    if (found) {
      await docker.getContainer(found.Id).remove({ force: true }); // 先删容器
    }
    await docker.getVolume(name).remove(); // 容器不存在时只走这一步，不炸
  }

  return { ensure, markActive, sweepIdle, reconcile, destroy };
}
