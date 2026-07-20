import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    CORS_ORIGIN: z.url(),
    JWT_SECRET: z.string().min(1),
    // 伺服器監聽埠；預設 3000（Docker 內部埠）
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    // outbox 送出目標（mock 外部 webhook 服務端點）
    OUTBOX_WEBHOOK_URL: z.url().default("http://localhost:7529/mock-external/notifications"),
    // worker 輪詢 sweeper 的間隔（毫秒）
    OUTBOX_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
    // 送出單筆 outbox 訊息的 HTTP 逾時（毫秒）
    OUTBOX_SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    // seed 用測試帳號的 email（僅供本機開發測試，正式環境務必覆寫或移除）
    SEED_USER_EMAIL: z.email().default("dev@example.com"),
    // seed 用測試帳號的密碼（僅供本機開發測試，正式環境務必覆寫或移除）
    SEED_USER_PASSWORD: z.string().min(8).default("dev12345"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
