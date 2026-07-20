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
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
