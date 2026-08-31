import { describe, it, expect } from "vitest";
import { createSandbox, type DockerLike } from "../../services/runtime/src/sandbox.js";

interface FakeContainer {
  id: string;
  name: string;
  state: string; // "running" | "exited" | ...
  labels: Record<string, string>;
}

function makeFakeDocker(initial: FakeContainer[] = []) {
  const containers = new Map<string, FakeContainer>(initial.map((c) => [c.id, c]));
  const volumes = new Set<string>(initial.map((c) => c.name));
  const calls: string[] = [];
  let nextId = 1;

  function listContainers(opts: { all: boolean; filters: string }) {
    calls.push(`listContainers:${opts.filters}`);
    const filters = JSON.parse(opts.filters) as { name?: string[]; label?: string[] };
    let list = [...containers.values()];
    if (filters.name) {
      const names = filters.name;
      list = list.filter((c) => names.includes(c.name));
    }
    if (filters.label) {
      const labelKeys = filters.label.map((l) => l.split("=")[0]);
      list = list.filter((c) => labelKeys.every((k) => k !== undefined && k in c.labels));
    }
    return Promise.resolve(
      list.map((c) => ({ Id: c.id, Names: [`/${c.name}`], State: c.state, Labels: c.labels })),
    );
  }

  function getContainer(id: string) {
    return {
      start: async () => {
        calls.push(`start:${id}`);
        const c = containers.get(id);
        if (c) c.state = "running";
      },
      stop: async () => {
        calls.push(`stop:${id}`);
        const c = containers.get(id);
        if (c) c.state = "exited";
      },
      remove: async (opts: { force: boolean }) => {
        calls.push(`remove:${id}:${opts.force}`);
        containers.delete(id);
      },
      update: async (_opts: Record<string, unknown>) => {},
      exec: async () => {
        throw new Error("not used in sandbox tests");
      },
      modem: { demuxStream: () => {} },
    };
  }

  async function createContainer(opts: Record<string, unknown>) {
    calls.push(`createContainer:${JSON.stringify(opts)}`);
    const id = `c${nextId++}`;
    const name = String(opts["name"]);
    const labels = (opts["Labels"] ?? {}) as Record<string, string>;
    containers.set(id, { id, name, state: "created", labels });
    volumes.add(name);
    return { id };
  }

  function listVolumes(opts: { filters: string }) {
    calls.push(`listVolumes:${opts.filters}`);
    return Promise.resolve({ Volumes: [...volumes].map((name) => ({ Name: name, Labels: null })) });
  }

  function getVolume(name: string) {
    return {
      remove: async () => {
        calls.push(`volumeRemove:${name}`);
        if (!volumes.has(name)) throw new Error("no such volume");
        volumes.delete(name);
      },
    };
  }

  const docker: DockerLike = { listContainers, getContainer, createContainer, listVolumes, getVolume };
  return { docker, calls, containers, volumes };
}

describe("createSandbox", () => {
  it("① ensure 不存在 → createContainer 全形状断言 + start", async () => {
    const { docker, calls } = makeFakeDocker([]);
    const sandbox = createSandbox(docker);

    const container = await sandbox.ensure("abc");

    const createCall = calls.find((c) => c.startsWith("createContainer:"));
    expect(createCall).toBeDefined();
    const args = JSON.parse(createCall!.slice("createContainer:".length));
    expect(args).toMatchObject({
      name: "otto-ws-abc",
      Image: "otto-sandbox",
      Cmd: ["sleep", "infinity"],
      Labels: { "mrotto.workspace": "abc" },
      HostConfig: {
        Memory: 2 * 1024 ** 3,
        NanoCpus: 2e9,
        PidsLimit: 512,
        Mounts: [{ Type: "volume", Source: "otto-ws-abc", Target: "/work" }],
      },
    });
    expect(calls.some((c) => c === "start:c1")).toBe(true);
    expect(container).toBeDefined();
  });

  it("② ensure 已停 → 只 start 不 create", async () => {
    const { docker, calls } = makeFakeDocker([
      { id: "c1", name: "otto-ws-x", state: "exited", labels: { "mrotto.workspace": "x" } },
    ]);
    const sandbox = createSandbox(docker);

    await sandbox.ensure("x");

    expect(calls.some((c) => c.startsWith("createContainer:"))).toBe(false);
    expect(calls.some((c) => c === "start:c1")).toBe(true);
  });

  it("③ sweepIdle 尊重 runningWorkspaces", async () => {
    let t = 0;
    const { docker, calls } = makeFakeDocker([
      { id: "c1", name: "otto-ws-a", state: "running", labels: { "mrotto.workspace": "a" } },
      { id: "c2", name: "otto-ws-b", state: "running", labels: { "mrotto.workspace": "b" } },
    ]);
    const sandbox = createSandbox(docker, { now: () => t, idleMs: 1000 });

    await sandbox.ensure("a"); // marks active @ t=0
    await sandbox.ensure("b"); // marks active @ t=0
    t = 2000; // both idle > 1000ms

    const stopped = await sandbox.sweepIdle(new Set(["a"])); // a 正跑着 turn

    expect(stopped).toEqual(["b"]);
    expect(calls.some((c) => c === "stop:c2")).toBe(true);
    expect(calls.some((c) => c === "stop:c1")).toBe(false);
  });

  it("④ reconcile 首见孤儿只标记不删，越过 grace 后 remove(force)+卷删", async () => {
    let t = 0;
    const { docker, calls, volumes } = makeFakeDocker([
      { id: "c1", name: "otto-ws-orphan", state: "running", labels: { "mrotto.workspace": "orphan" } },
    ]);
    let store: Record<string, number> = {};
    const orphans = {
      load: () => ({ ...store }),
      save: (m: Record<string, number>) => {
        store = { ...m };
      },
    };
    const sandbox = createSandbox(docker, { now: () => t, orphanGraceMs: 1000, orphans });

    const r1 = await sandbox.reconcile(new Set(["other"])); // orphan 不在 validIds

    expect(r1.marked).toEqual(["orphan"]);
    expect(r1.removed).toEqual([]);
    expect(store).toEqual({ orphan: 0 });
    expect(calls.some((c) => c.startsWith("remove:"))).toBe(false);

    t = 2000; // 越过 grace

    const r2 = await sandbox.reconcile(new Set(["other"]));

    expect(r2.marked).toEqual([]);
    expect(r2.removed).toEqual(["orphan"]);
    expect(calls.some((c) => c === "remove:c1:true")).toBe(true);
    expect(volumes.has("otto-ws-orphan")).toBe(false);
    expect(store).toEqual({});

    const removeIdx = calls.indexOf("remove:c1:true");
    const volRemoveIdx = calls.indexOf("volumeRemove:otto-ws-orphan");
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(volRemoveIdx).toBeGreaterThan(removeIdx);
  });

  it("⑤ destroy 容器与卷都删；容器不存在时只删卷、不炸", async () => {
    const { docker, calls, volumes } = makeFakeDocker([
      { id: "c1", name: "otto-ws-y", state: "running", labels: { "mrotto.workspace": "y" } },
    ]);
    const sandbox = createSandbox(docker);

    await sandbox.destroy("y");

    expect(calls.some((c) => c === "remove:c1:true")).toBe(true);
    expect(volumes.has("otto-ws-y")).toBe(false);
    const removeIdx = calls.indexOf("remove:c1:true");
    const volRemoveIdx = calls.indexOf("volumeRemove:otto-ws-y");
    expect(volRemoveIdx).toBeGreaterThan(removeIdx);

    // 容器不存在（比如已经手动删过）：只删卷，不炸
    volumes.add("otto-ws-z");
    await expect(sandbox.destroy("z")).resolves.toBeUndefined();
    expect(volumes.has("otto-ws-z")).toBe(false);
    expect(calls.some((c) => c.startsWith("remove:") && c.endsWith(":true") && c.includes("z"))).toBe(false);
  });
});
