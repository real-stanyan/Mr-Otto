// 测试用 HS256 签名（与 jwt.test.ts 里那份同构；抽出来给 pxRoutes 复用）
import { createHmac } from "node:crypto";

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

export function signTestJwt(secret: string, payload: Record<string, unknown>): string {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
