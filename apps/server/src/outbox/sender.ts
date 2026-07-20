import { db, todos } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";

import type { OutboxConfig } from "./config";
import type { OutboxMessageRow } from "./repository";

export type SendOutboxMessageResult = { skipped: boolean };

/**
 * 送出一筆 outbox 訊息：依 refId 重抓「最新」業務資料現組 payload
 * （不回放入隊當下的舊資料，避免送出過期狀態）。
 *
 * - 對應的 todo 已不存在 → 回傳 { skipped: true }，呼叫端視同成功（markDone）。
 * - 送出後非 2xx 或網路錯誤/逾時 → throw，呼叫端視為失敗（markFailed）。
 */
export async function sendOutboxMessage(
  row: OutboxMessageRow,
  config: OutboxConfig,
): Promise<SendOutboxMessageResult> {
  const [todo] = await db.select().from(todos).where(eq(todos.id, row.refId)).limit(1);
  if (!todo) {
    return { skipped: true };
  }

  const payload = {
    topic: row.topic,
    refId: row.refId,
    action: row.action,
    todo,
    sentAt: new Date().toISOString(),
  };

  const response = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`outbox 送出失敗：HTTP ${response.status}`);
  }

  return { skipped: false };
}
