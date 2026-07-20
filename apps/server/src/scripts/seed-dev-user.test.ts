import { db, users } from "@fastify_drizzle_todolist/db";
import { env } from "@fastify_drizzle_todolist/env/server";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestApp, resetDb } from "../test/helpers";
import { seedDevUser } from "./seed-dev-user";

const app = createTestApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await app.close();
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

  it("seed_uses_provided_overrides", async () => {
    // 用明顯不同於預設值（dev@example.com）的自訂 email，確認覆寫值確實被採用
    const email = "custom@example.com";
    const password = "custom1234";

    await seedDevUser({ email, password });

    const result = await db.execute(sql`select email from users where email = ${email}`);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.email).toBe(email);
  });

  it("seed_uses_default_when_no_overrides", async () => {
    // 不帶任何 overrides，應 fallback 到 packages/env 的預設值
    await seedDevUser();

    const result = await db.execute(
      sql`select email from users where email = ${env.SEED_USER_EMAIL}`,
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.email).toBe(env.SEED_USER_EMAIL);
  });

  it("seeded_account_can_login_via_auth_login", async () => {
    // 端到端驗證：seedDevUser 產生的密碼雜湊要能被既有 POST /auth/login 的
    // bcrypt.compare 認可，且回傳的 token 要能實際用於 GET /auth/me。
    const email = "seed-login@example.com";
    const password = "seed-login-password123";

    await seedDevUser({ email, password });

    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password },
    });
    expect(loginRes.statusCode).toBe(200);
    const { token } = loginRes.json();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    const meRes = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().email).toBe(email);
  });
});
