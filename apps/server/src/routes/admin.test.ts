import { db, users } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestApp, registerAndGetToken, resetDb } from "../test/helpers";

const app = createTestApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await app.close();
});

/** 註冊使用者、直接在 DB 升為 admin，回傳其 token。 */
async function registerAdminAndGetToken(email: string): Promise<string> {
  const token = await registerAndGetToken(app, email);
  await db.update(users).set({ role: "admin" }).where(eq(users.email, email));
  return token;
}

/** 依 email 取出使用者 id。 */
async function getUserId(email: string): Promise<number> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return row!.id;
}

describe("requireRole preHandler（透過 GET /admin/users）", () => {
  it("rejects_unauthenticated_with_401", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/users" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects_non_admin_with_403", async () => {
    const token = await registerAndGetToken(app, "user@example.com"); // 預設 role=user
    const res = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows_admin_with_200_and_lists_users", async () => {
    const token = await registerAdminAndGetToken("admin@example.com");
    const res = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ email: string; role: string }>;
    expect(rows.some((u) => u.email === "admin@example.com" && u.role === "admin")).toBe(true);
  });
});

describe("PATCH /admin/users/:id/role（角色變更即時生效）", () => {
  it("admin_promotes_member_and_same_old_token_immediately_gains_access", async () => {
    const adminToken = await registerAdminAndGetToken("boss@example.com");
    const memberToken = await registerAndGetToken(app, "member@example.com");

    // member 一開始無權存取 admin 路由
    const before = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(before.statusCode).toBe(403);

    // admin 把 member 升為 admin
    const memberId = await getUserId("member@example.com");
    const promote = await app.inject({
      method: "PATCH",
      url: `/admin/users/${memberId}/role`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: "admin" },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().role).toBe("admin");

    // 關鍵：member 沿用「同一顆舊 token」立刻擁有 admin 權限（角色從 DB 即時讀取）
    const after = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(after.statusCode).toBe(200);
  });

  it("non_admin_cannot_change_role_403", async () => {
    const userToken = await registerAndGetToken(app, "plain@example.com");
    const selfId = await getUserId("plain@example.com");

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/users/${selfId}/role`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { role: "admin" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns_404_when_target_user_missing", async () => {
    const adminToken = await registerAdminAndGetToken("root@example.com");
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/users/999999/role",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: "user" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects_invalid_role_or_id_with_400", async () => {
    const adminToken = await registerAdminAndGetToken("validator@example.com");
    const id = await getUserId("validator@example.com");

    // 不在列舉內的角色
    const badRole = await app.inject({
      method: "PATCH",
      url: `/admin/users/${id}/role`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: "superuser" },
    });
    expect(badRole.statusCode).toBe(400);

    // 非數字 id
    const badId = await app.inject({
      method: "PATCH",
      url: "/admin/users/not-a-number/role",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: "user" },
    });
    expect(badId.statusCode).toBe(400);
  });
});
