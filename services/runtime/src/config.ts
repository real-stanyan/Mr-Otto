// config —— 云 runtime 的环境变量装配（ADR-0199）。
// 缺任何一个必需变量 = 启动即失败（fail fast）：那种「缺了某个 key 才在
// 第一次用到时才炸」的失败模式，比直接拒绝启动更难查、更晚暴露。
//
// 纯核心（resolveConfig）+ 薄的 side-effecting 壳（loadConfig）分层：
// 前者可以单测（给一份假 env，断言缺了哪些键），后者才碰 process.exit。

export interface RuntimeConfig {
  runtimeSecret: string;
  supabaseJwtSecret: string;
  supabaseUrl: string;
  supabaseServiceKey: string;
  edgeBase: string;
  relayBase: string;
  /** 默认 /var/lib/otto-runtime——唯一有默认值的一个，其余全部必填 */
  dataDir: string;
}

const REQUIRED_KEYS = [
  "RUNTIME_SECRET",
  "SUPABASE_JWT_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "EDGE_BASE",
  "RELAY_BASE",
] as const;

// MODEL_BASE_URL / MODEL_API_KEY / MODEL_ID **故意不在这份清单里**（issue #844，
// 推翻 ADR-0199 决策⑥）：模型 key 跟着工作区走，由 owner 自己配，runtime 这个
// 进程不持有任何模型 key。也**不做 env 兜底**——有兜底就等于"忘了配的工作区
// 默默烧维护者的钱"，而那正是这一版要消灭的东西。没配 key 的工作区里 @Agent
// 会得到一条看得见的话，不是一个静默扣费的 turn。

const DEFAULT_DATA_DIR = "/var/lib/otto-runtime";

export class MissingConfigError extends Error {
  constructor(public readonly missing: readonly string[]) {
    super(`runtime 缺少环境变量：${missing.join(", ")}`);
    this.name = "MissingConfigError";
  }
}

/** 纯函数：给一份 env，装出配置或者报告缺了哪些必需键。不碰 process.exit——
    side effect 留给 loadConfig，这里可以直接喂假 env 单测 */
export function resolveConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const missing = REQUIRED_KEYS.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new MissingConfigError(missing);
  }
  const dataDir = env.DATA_DIR && env.DATA_DIR.length > 0 ? env.DATA_DIR : DEFAULT_DATA_DIR;
  return {
    runtimeSecret: env.RUNTIME_SECRET!,
    supabaseJwtSecret: env.SUPABASE_JWT_SECRET!,
    supabaseUrl: env.SUPABASE_URL!,
    supabaseServiceKey: env.SUPABASE_SERVICE_KEY!,
    edgeBase: env.EDGE_BASE!,
    relayBase: env.RELAY_BASE!,
    dataDir,
  };
}

/** 装配入口：读 process.env，缺了列出缺哪几个再 exit(1)。daemon.ts 唯一调用处 */
export function loadConfig(): RuntimeConfig {
  try {
    return resolveConfig(process.env);
  } catch (err) {
    if (err instanceof MissingConfigError) {
      console.error(`[otto-runtime] 缺少必需的环境变量：${err.missing.join(", ")}`);
      process.exit(1);
    }
    throw err;
  }
}
