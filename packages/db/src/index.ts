import { env } from "@fastify_drizzle_todolist/env/server";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema/index";

export const db = drizzle(env.DATABASE_URL, { schema });

// 底層 pg Pool 實例（與 db 共用同一條連線池，而非另開一份連線設定）。
// staging-sync 的 advisory lock 需要釘住單一 client（session）整個流程，
// 一般 db 操作走的 query 介面無法保證同一條連線，因此需要從 pool 額外 `connect()`
// 取得專用 client（見 apps/server/src/staging-sync/mutex.ts）。
export const pool = db.$client;

// 讓使用端可直接 `import { db, users, todos } from "@fastify_drizzle_todolist/db"`
export * from "./schema/index";
