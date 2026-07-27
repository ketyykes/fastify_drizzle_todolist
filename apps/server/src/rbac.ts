import { db, users, type UserRole } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import type { preHandlerHookHandler } from "fastify";

/**
 * 產生「要求特定角色」的 Fastify preHandler。
 *
 * 使用方式：接在 app.authenticate 之後，例如
 *   { preHandler: [app.authenticate, requireRole("admin")] }
 *
 * 設計取捨：角色是「每次請求即時從 DB 讀取」，而非塞進 JWT。
 * 好處是變更角色後立即生效，不必等使用者重新登入換新 token；
 * 代價是每個受保護請求多一次 SELECT（對多數應用可忽略）。
 * 若追求零 DB 讀取，可改成登入時把 role 簽進 JWT，但需接受角色異動有延遲。
 */
export function requireRole(...allowedRoles: UserRole[]): preHandlerHookHandler {
  return async function requireRolePreHandler(request, reply) {
    // authenticate 已於前一個 preHandler 驗證並填入 request.user；
    // 這裡沿用相同慣例直接取用（本 preHandler 必須排在 authenticate 之後）。
    const { userId } = request.user;

    const [row] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    // token 有效但使用者已不存在（例如被刪除）
    if (!row) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    // 已登入但角色不足 → 403（與「未登入 401」明確區分）
    if (!allowedRoles.includes(row.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
  };
}
