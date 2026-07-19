import { env } from "@fastify_drizzle_todolist/env/server";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema/index";

export const db = drizzle(env.DATABASE_URL, { schema });

// 讓使用端可直接 `import { db, users, todos } from "@fastify_drizzle_todolist/db"`
export * from "./schema/index";
