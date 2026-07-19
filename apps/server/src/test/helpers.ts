import { db } from "@fastify_drizzle_todolist/db";
import { sql } from "drizzle-orm";

import { buildApp } from "../app";

/**
 * 建立測試用 app 實例。呼叫端負責在用完後 app.close()。
 */
export function createTestApp() {
  return buildApp();
}

/**
 * 清空資料表，確保每個測試互不污染。
 * 表尚未建立時（RED 階段 schema 還沒 push）忽略錯誤。
 */
export async function resetDb() {
  // 分別 truncate：某張表在 RED 階段可能尚未建立，單獨包 try 避免整批失敗
  // （否則一張表不存在會導致另一張也沒被清空，測試互相污染）
  try {
    await db.execute(sql`TRUNCATE TABLE todos RESTART IDENTITY CASCADE`);
  } catch {
    // todos 尚未建立，忽略
  }
  try {
    await db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
  } catch {
    // users 尚未建立，忽略
  }
}

/**
 * 以 register 端點建立使用者並回傳其 token，供需要登入態的測試使用。
 */
export async function registerAndGetToken(
  app: ReturnType<typeof buildApp>,
  email: string,
  password = "password123",
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password },
  });
  return res.json().token as string;
}
