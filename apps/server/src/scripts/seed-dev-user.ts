// Seed 腳本：建立固定的本機開發測試帳號。
// 語意：email 不存在時建立一筆新帳號（密碼經 bcrypt 雜湊）；
// email 已存在則單純略過，不做 upsert、不更新密碼（見 design.md 決策）。

import { fileURLToPath } from "node:url";

import { db, users } from "@fastify_drizzle_todolist/db";
import { env } from "@fastify_drizzle_todolist/env/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";

const BCRYPT_ROUNDS = 10;

export type SeedDevUserOverrides = {
  email?: string;
  password?: string;
};

/**
 * 若指定 email 尚無帳號則建立一筆（密碼經 bcrypt 雜湊，非明文）；
 * 若該 email 已存在帳號則略過，不拋出例外。
 * 未帶 overrides 時使用 env.SEED_USER_EMAIL / env.SEED_USER_PASSWORD 的預設值。
 */
export async function seedDevUser(overrides?: SeedDevUserOverrides): Promise<void> {
  const email = overrides?.email ?? env.SEED_USER_EMAIL;
  const password = overrides?.password ?? env.SEED_USER_PASSWORD;

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) {
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await db.insert(users).values({ email, password: passwordHash });
}

async function main(): Promise<void> {
  // seedDevUser() 回傳 void，這裡先查一次是否已存在，只為了 log 出「建立成功／
  // 略過已存在」的結果，不影響 seedDevUser 本身的核心邏輯。
  const email = env.SEED_USER_EMAIL;
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  await seedDevUser();

  if (existing.length > 0) {
    console.log(`[seed-dev-user] 略過已存在：${email}`);
  } else {
    console.log(`[seed-dev-user] 建立成功：${email}`);
  }
}

// 只有直接執行本檔（tsx src/scripts/seed-dev-user.ts）才跑 main，
// 被測試檔 import 時不觸發（避免單元測試連到 DB）。
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  void main();
}
