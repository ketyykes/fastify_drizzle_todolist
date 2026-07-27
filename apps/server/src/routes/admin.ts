import { db, USER_ROLES, users } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireRole } from "../rbac";
import { idParamSchema } from "../schemas";

const updateRoleSchema = z.object({
  // 直接沿用 schema 的角色清單，與 DB enum 保持單一真實來源
  role: z.enum(USER_ROLES),
});

/**
 * RBAC 示範路由：兩個端點都只允許 admin。
 * preHandler 順序固定為 [authenticate, requireRole(...)]：
 * 先確認有登入（否則 401），再確認角色足夠（否則 403）。
 */
export async function adminRoutes(app: FastifyInstance) {
  // 本群組所有 /admin 端點都需先登入、再具 admin 角色（順序：先 401 後 403）
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", requireRole("admin"));

  // 列出全部使用者
  app.get("/admin/users", async () => {
    return db
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .orderBy(users.id);
  });

  // 變更他人角色；因為 requireRole 每次都讀 DB，改完立即生效
  app.patch("/admin/users/:id/role", async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    const body = updateRoleSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid input" });
    }
    const targetId = params.data.id;
    const nextRole = body.data.role;

    // 在單一交易內完成「檢查 → 更新」，避免把最後一位 admin 降級而導致
    // 系統再無任何 admin 可管理（zero-admin lockout）。
    const result = await db.transaction(async (tx) => {
      // 先鎖定所有現任 admin 列（單一查詢、掃描順序一致 → 無死結風險）。
      // 併發的降級請求會在此序列化，計數才不會出現撕裂。
      const admins = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, "admin"))
        .for("update");

      const [target] = await tx
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1);
      if (!target) {
        return { kind: "not_found" as const };
      }

      // 只有「把現任 admin 降成非 admin」才有 lockout 風險
      const isDemotingAdmin = target.role === "admin" && nextRole !== "admin";
      if (isDemotingAdmin && admins.length <= 1) {
        return { kind: "last_admin" as const };
      }

      const [updated] = await tx
        .update(users)
        .set({ role: nextRole })
        .where(eq(users.id, targetId))
        .returning({ id: users.id, email: users.email, role: users.role });
      return { kind: "ok" as const, updated: updated! };
    });

    if (result.kind === "not_found") {
      return reply.code(404).send({ error: "User not found" });
    }
    if (result.kind === "last_admin") {
      return reply.code(409).send({ error: "Cannot demote the last admin" });
    }
    return reply.send(result.updated);
  });
}
