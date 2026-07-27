import { db, USER_ROLES, users } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireRole } from "../rbac";

const userIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

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
    const params = userIdParamSchema.safeParse(request.params);
    const body = updateRoleSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid input" });
    }

    const [updated] = await db
      .update(users)
      .set({ role: body.data.role })
      .where(eq(users.id, params.data.id))
      .returning({ id: users.id, email: users.email, role: users.role });

    if (!updated) {
      return reply.code(404).send({ error: "User not found" });
    }
    return reply.send(updated);
  });
}
