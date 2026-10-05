// 群聊模拟（#1682）的执行面：每个模拟用户一台真的 otto-sandbox 容器（WSL 里的 docker，断网，只有 /work）。
// 智能体动手是真的跑命令、读写真文件——比「假容器回一段固定字」更接近线上。只给 *.live.test.ts 用，默认不跑。
import { spawn } from "node:child_process";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";

const DISTRO = process.env.OTTO_SIM_DISTRO ?? "Ubuntu-24.04";
const IMAGE = process.env.OTTO_SIM_IMAGE ?? "otto-sandbox:latest";

function run(args: string[], input?: string, timeoutMs = 90_000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const p = spawn("wsl", ["-d", DISTRO, "-e", "sudo", "-n", "docker", ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
    if (input !== undefined) p.stdin.end(input, "utf8");
    else p.stdin.end();
  });
}

export interface SimBox {
  name: string;
  world: ExecutionWorld;
  seed(files: Record<string, string>): Promise<void>;
  /** 这台容器里此刻 /work 下的文件（报告里列） */
  files(): Promise<string[]>;
  destroy(): Promise<void>;
}

const abs = (path: string): string => (path.startsWith("/") ? path : `/work/${path}`);
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export async function createSimBox(name: string): Promise<SimBox> {
  await run(["rm", "-f", name]);
  const started = await run(["run", "-d", "--name", name, "--network", "none", "-w", "/work", "--entrypoint", "sleep", IMAGE, "infinity"]);
  if (started.exitCode !== 0) throw new Error(`起不来沙箱 ${name}：${started.stderr}`);
  await run(["exec", name, "mkdir", "-p", "/work"]);
  const write = async (path: string, content: string): Promise<void> => {
    const p = abs(path);
    const r = await run(["exec", "-i", name, "sh", "-c", `mkdir -p "$(dirname ${q(p)})" && cat > ${q(p)}`], content);
    if (r.exitCode !== 0) throw new Error(r.stderr || `写不进 ${p}`);
  };
  const postJsonWithHeaders = async (url: string, body: unknown, o?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<{ body: unknown; headers: Record<string, string> }> => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...o?.headers }, body: JSON.stringify(body), ...(o?.signal ? { signal: o.signal } : {}) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { body: (await res.json()) as unknown, headers: Object.fromEntries(res.headers.entries()) };
  };
  const world: ExecutionWorld = {
    fs: {
      read: async (path) => {
        const r = await run(["exec", name, "cat", abs(path)]);
        if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `读不到 ${path}`);
        return r.stdout;
      },
      write,
      // 二进制（#1683 文件）：docker exec 的输入输出都是字符串，过一道 base64（同 DockerWorld）
      readBytes: async (path) => {
        const r = await run(["exec", name, "base64", "-w0", abs(path)]);
        if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `读不到 ${path}`);
        return new Uint8Array(Buffer.from(r.stdout.trim(), "base64"));
      },
      writeBytes: async (path, data) => {
        const p = abs(path);
        const r = await run(["exec", "-i", name, "sh", "-c", `mkdir -p "$(dirname ${q(p)})" && base64 -d > ${q(p)}`], Buffer.from(data).toString("base64"));
        if (r.exitCode !== 0) throw new Error(r.stderr || `写不进 ${p}`);
      },
    },
    exec: async (cmd) => {
      const r = await run(["exec", "-w", "/work", name, "bash", "-lc", cmd]);
      return { stdout: r.stdout.slice(0, 60_000), stderr: r.stderr.slice(0, 20_000), exitCode: r.exitCode };
    },
    // 同 DockerWorld：http 走主机的 fetch（联网搜索、出图是 runtime 替沙箱外呼，不过容器的 --network none）
    http: {
      postJson: async (url, body, o) => (await postJsonWithHeaders(url, body, o)).body,
      postJsonWithHeaders,
    },
  };
  return {
    name,
    world,
    async seed(files) {
      for (const [p, c] of Object.entries(files)) await write(p, c);
    },
    async files() {
      const r = await run(["exec", name, "sh", "-c", "cd /work && find . -type f | grep -v '^./wiki/' | sort | head -80"]);
      return r.stdout.split("\n").filter((l) => l !== "");
    },
    async destroy() {
      await run(["rm", "-f", name]);
    },
  };
}
