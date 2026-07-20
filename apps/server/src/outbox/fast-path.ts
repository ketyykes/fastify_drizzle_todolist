import { db, outboxMessages } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";

import { getOutboxConfig } from "./config";
import { markDone, markFailed } from "./repository";
import { sendOutboxMessage } from "./sender";

/**
 * 交易 commit 後立即 best-effort 試送一次（fast-path）。正常情況下同步近即時完成，
 * outbox 只是保險；失敗留給 sweeper 背景重試。
 *
 * 成功或 ref 已刪（skipped）→ markDone；
 * 失敗 → 直接重用 markFailed（attempts 0→1、依查表退避、status 維持 pending，
 * 語意正好吻合設計文件「fast-path 失敗留在 pending」）。
 *
 * 全程 try/catch，任何失敗都只記錄警告，不拋出、不影響已提交的更新回應。
 */
export async function flushOutboxFastPath(outboxId: number): Promise<void> {
  try {
    const [row] = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, outboxId))
      .limit(1);
    if (!row) {
      return;
    }

    try {
      await sendOutboxMessage(row, getOutboxConfig());
      await markDone(row.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markFailed(row, message);
    }
  } catch (unexpectedError) {
    console.warn(`[outbox] fast-path id=${outboxId} 發生非預期錯誤`, unexpectedError);
  }
}
