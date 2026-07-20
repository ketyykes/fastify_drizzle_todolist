import { env } from "@fastify_drizzle_todolist/env/server";

export interface OutboxConfig {
  // 送出目標端點（mock 外部 webhook 服務）
  webhookUrl: string;
  // 單筆送出的 HTTP 逾時（毫秒）
  timeoutMs: number;
}

// 測試覆寫用；非 null 時優先於 env
let testOverride: OutboxConfig | null = null;

/**
 * 讀取 outbox 設定。測試以 setOutboxConfigForTest 覆寫時優先回傳覆寫值。
 */
export function getOutboxConfig(): OutboxConfig {
  if (testOverride) {
    return testOverride;
  }
  return {
    webhookUrl: env.OUTBOX_WEBHOOK_URL,
    timeoutMs: env.OUTBOX_SEND_TIMEOUT_MS,
  };
}

/**
 * 測試專用：覆寫 outbox 設定（例如把 webhookUrl 指到 ephemeral port 的 mock server）。
 * 傳入 null 清除覆寫，還原成讀 env。
 */
export function setOutboxConfigForTest(config: OutboxConfig | null): void {
  testOverride = config;
}
