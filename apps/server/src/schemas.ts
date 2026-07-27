import { z } from "zod";

/**
 * 共用：路徑參數中的數字 id（正整數；字串會被 coerce 成 number）。
 * 供 /todos/:id、/admin/users/:id、/staging-sync/runs/:id 等端點共用，
 * 避免每個路由各自重寫同一份 id 驗證而漂移。
 */
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});
