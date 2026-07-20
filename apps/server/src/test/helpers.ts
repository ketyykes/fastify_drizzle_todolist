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
 * 執行期防呆（第二道防線，搭配 test/setup.ts 的第一道）：
 * 在做任何 TRUNCATE 之前，直接向連線中的資料庫確認庫名以 _test 結尾，
 * 否則中止。避免 DATABASE_URL 被誤設而在開發／正式庫上清資料。
 */
async function assertConnectedToTestDatabase() {
  const result = await db.execute<{ current: string }>(sql`SELECT current_database() AS current`);
  const current = result.rows[0]?.current ?? "";
  if (!current.endsWith("_test")) {
    throw new Error(`拒絕在非測試庫「${current}」上執行 resetDb（資料庫名稱必須以 _test 結尾）`);
  }
}

/**
 * 清空資料表，確保每個測試互不污染。
 * 表尚未建立時（RED 階段 schema 還沒 push）忽略錯誤。
 */
export async function resetDb() {
  await assertConnectedToTestDatabase();

  // 分別 truncate：某張表在 RED 階段可能尚未建立，單獨包 try 避免整批失敗
  // （否則一張表不存在會導致另一張也沒被清空，測試互相污染）
  try {
    await db.execute(sql`TRUNCATE TABLE outbox_messages RESTART IDENTITY CASCADE`);
  } catch {
    // outbox_messages 尚未建立，忽略
  }
  // staging-sync：staging 表先於 sync_runs（無外鍵，但依邏輯順序清理較直覺）
  try {
    await db.execute(sql`TRUNCATE TABLE template_lists_staging RESTART IDENTITY CASCADE`);
  } catch {
    // template_lists_staging 尚未建立，忽略
  }
  try {
    await db.execute(sql`TRUNCATE TABLE template_items_staging RESTART IDENTITY CASCADE`);
  } catch {
    // template_items_staging 尚未建立，忽略
  }
  try {
    await db.execute(sql`TRUNCATE TABLE template_item_tags_staging RESTART IDENTITY CASCADE`);
  } catch {
    // template_item_tags_staging 尚未建立，忽略
  }
  try {
    await db.execute(sql`TRUNCATE TABLE sync_runs RESTART IDENTITY CASCADE`);
  } catch {
    // sync_runs 尚未建立，忽略
  }
  // staging-sync：3 張目標表
  try {
    await db.execute(sql`TRUNCATE TABLE template_item_tags RESTART IDENTITY CASCADE`);
  } catch {
    // template_item_tags 尚未建立，忽略
  }
  try {
    await db.execute(sql`TRUNCATE TABLE template_items RESTART IDENTITY CASCADE`);
  } catch {
    // template_items 尚未建立，忽略
  }
  try {
    await db.execute(sql`TRUNCATE TABLE template_lists RESTART IDENTITY CASCADE`);
  } catch {
    // template_lists 尚未建立，忽略
  }
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
