import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

import { resolveTestDatabaseUrl } from "./src/test-db";

dotenv.config({
  path: "../../apps/server/.env",
});

const baseUrl = process.env.DATABASE_URL || "";
// 設 DRIZZLE_TEST=1（db:push:test 指令）時，推送 schema 到獨立測試庫（<db>_test），
// 供建立／更新測試庫用；否則照常推送到開發庫。
const url = process.env.DRIZZLE_TEST === "1" ? resolveTestDatabaseUrl(baseUrl) : baseUrl;

export default defineConfig({
  schema: "./src/schema",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url,
  },
});
