import { db, users } from "@fastify_drizzle_todolist/db";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { resetDb } from "../test/helpers";
import { seedDevUser } from "./seed-dev-user";

beforeEach(async () => {
  await resetDb();
});

describe("seedDevUser", () => {
  it("seed_creates_user_when_absent", async () => {
    const email = "seed-absent@example.com";
    const password = "seed-password123";

    await seedDevUser({ email, password });

    const result = await db.execute(sql`select password from users where email = ${email}`);
    expect(result.rows.length).toBe(1);

    const stored = result.rows[0]?.password as string;
    expect(stored).not.toBe(password);
    expect(await bcrypt.compare(password, stored)).toBe(true);
  });

  it("seed_skips_when_already_exists", async () => {
    const email = "seed-existing@example.com";
    const existingPasswordHash = "existing-hash-not-to-be-touched";

    // 預先建立一筆該 email 的帳號，模擬「帳號已存在」的情境
    await db.insert(users).values({ email, password: existingPasswordHash });

    await expect(seedDevUser({ email, password: "new-password123" })).resolves.toBeUndefined();

    const result = await db.execute(sql`select password from users where email = ${email}`);
    expect(result.rows.length).toBe(1);
    // 不更新密碼：仍是原本插入的雜湊值，不是依新明文密碼重新雜湊出來的值
    expect(result.rows[0]?.password).toBe(existingPasswordHash);
  });
});
