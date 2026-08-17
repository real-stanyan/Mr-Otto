// 本地手搓密钥生成脚本 —— 只打印到 stdout,不落盘、不进 git。
// 用法: node deploy/otto-auth/gen-keys.mjs
// 输出复制粘贴进服务器上的 ~/otto-supabase/docker/.env,用完清空终端history。
import { randomBytes, createHmac } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const jwt = (payload, secret) => {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify(payload));
  const s = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
};

const now = Math.floor(Date.now() / 1000);
const exp = now + 10 * 365 * 24 * 3600; // 10 年
const jwtSecret = randomBytes(32).toString("hex");
const claims = (role) => ({ role, iss: "supabase", iat: now, exp });

console.log("POSTGRES_PASSWORD=" + randomBytes(24).toString("hex"));
console.log("JWT_SECRET=" + jwtSecret);
console.log("ANON_KEY=" + jwt(claims("anon"), jwtSecret));
console.log("SERVICE_ROLE_KEY=" + jwt(claims("service_role"), jwtSecret));
console.log("DASHBOARD_PASSWORD=" + randomBytes(16).toString("hex"));
