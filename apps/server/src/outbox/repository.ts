import { db, outboxMessages } from "@fastify_drizzle_todolist/db";
import { and, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";

import { computeNextAttemptAt } from "./backoff";
import { OUTBOX_STATUS, STALE_PROCESSING_MINUTES } from "./constants";

// db.transaction 回呼參數的型別，供呼叫端在自己的交易內呼叫 enqueueOutbox。
export type OutboxTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OutboxMessageRow = typeof outboxMessages.$inferSelect;

/**
 * 入隊一筆 outbox 訊息。**必須在呼叫端交易內執行**，讓「寫業務資料」與
 * 「寫待送出意圖」原子提交（transactional outbox 核心）。
 */
export async function enqueueOutbox(
  tx: OutboxTx,
  params: { topic: string; refId: number; action?: string },
): Promise<number> {
  const [inserted] = await tx
    .insert(outboxMessages)
    .values({
      topic: params.topic,
      refId: params.refId,
      action: params.action ?? "sync",
    })
    .returning({ id: outboxMessages.id });
  if (!inserted) {
    throw new Error("寫入 outbox 訊息失敗");
  }
  return inserted.id;
}

/**
 * 認領一批到期的 pending 訊息：交易內用 FOR UPDATE SKIP LOCKED 避免多個
 * worker 並行搶到同一列，認領後立刻轉為 processing 並記錄 locked_at。
 */
export async function claimDueBatch(limit: number): Promise<OutboxMessageRow[]> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const candidates = await tx
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.status, OUTBOX_STATUS.PENDING),
          lte(outboxMessages.nextAttemptAt, now),
        ),
      )
      .orderBy(outboxMessages.id)
      .limit(limit)
      .for("update", { skipLocked: true });

    if (candidates.length === 0) {
      return [];
    }

    const ids = candidates.map((row) => row.id);
    return tx
      .update(outboxMessages)
      .set({ status: OUTBOX_STATUS.PROCESSING, lockedAt: now })
      .where(inArray(outboxMessages.id, ids))
      .returning();
  });
}

/**
 * 卡住回收：processing 超過 STALE_PROCESSING_MINUTES（worker 處理中 crash）
 * 自動退回 pending，清除 locked_at。回傳被回收的筆數。
 */
export async function recoverStaleProcessing(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MINUTES * 60_000);
  const recovered = await db
    .update(outboxMessages)
    .set({ status: OUTBOX_STATUS.PENDING, lockedAt: null })
    .where(
      and(eq(outboxMessages.status, OUTBOX_STATUS.PROCESSING), lt(outboxMessages.lockedAt, cutoff)),
    )
    .returning({ id: outboxMessages.id });
  return recovered.length;
}

/**
 * 標記為送出成功（含 ref 已刪的 skipped 情況）。
 */
export async function markDone(id: number): Promise<void> {
  await db
    .update(outboxMessages)
    .set({ status: OUTBOX_STATUS.DONE, lockedAt: null })
    .where(eq(outboxMessages.id, id));
}

// markFailed 的處理結果：轉為死信、或退回 pending 待重試。
export type MarkFailedOutcome = "retried" | "dead";

/**
 * 標記為送出失敗：attempts+1；達上限轉 dead 並記錄 [outbox-dead] 告警 log，
 * 否則退回 pending 並依查表計算下次重送時間。回傳結果供呼叫端統計，
 * 避免呼叫端自行重算一次「是否會轉死信」而與這裡的判斷邏輯重複。
 */
export async function markFailed(
  row: OutboxMessageRow,
  errorMessage: string,
): Promise<MarkFailedOutcome> {
  const newAttempts = row.attempts + 1;
  const now = new Date();

  if (newAttempts >= row.maxAttempts) {
    await db
      .update(outboxMessages)
      .set({
        status: OUTBOX_STATUS.DEAD,
        attempts: newAttempts,
        lastError: errorMessage,
        lockedAt: null,
      })
      .where(eq(outboxMessages.id, row.id));
    // 死信告警：來源系統寫入專用告警表，本範例改為結構化 error log
    console.error(
      `[outbox-dead] id=${row.id} topic=${row.topic} refId=${row.refId} attempts=${newAttempts} error=${errorMessage}`,
    );
    return "dead";
  }

  await db
    .update(outboxMessages)
    .set({
      status: OUTBOX_STATUS.PENDING,
      attempts: newAttempts,
      lastError: errorMessage,
      nextAttemptAt: computeNextAttemptAt(newAttempts, now),
      lockedAt: null,
    })
    .where(eq(outboxMessages.id, row.id));
  return "retried";
}

/**
 * 人工救援：把 dead 訊息重新排回 pending 並重置嘗試次數等欄位。
 * 省略 ids 時處理全部 dead 訊息；回傳實際被重排的筆數。
 */
export async function requeueDead(ids?: number[]): Promise<number> {
  const condition =
    ids && ids.length > 0
      ? and(eq(outboxMessages.status, OUTBOX_STATUS.DEAD), inArray(outboxMessages.id, ids))
      : eq(outboxMessages.status, OUTBOX_STATUS.DEAD);

  const requeued = await db
    .update(outboxMessages)
    .set({
      status: OUTBOX_STATUS.PENDING,
      attempts: 0,
      lastError: null,
      nextAttemptAt: new Date(),
      lockedAt: null,
    })
    .where(condition)
    .returning({ id: outboxMessages.id });
  return requeued.length;
}

/**
 * 清理保留天數外已完成的訊息。只硬刪 done，dead/pending/processing 一律保留。
 */
export async function pruneDone(retentionDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const pruned = await db
    .delete(outboxMessages)
    .where(and(eq(outboxMessages.status, OUTBOX_STATUS.DONE), lt(outboxMessages.updatedAt, cutoff)))
    .returning({ id: outboxMessages.id });
  return pruned.length;
}

export interface OutboxStats {
  counts: {
    pending: number;
    processing: number;
    done: number;
    dead: number;
  };
  recent: OutboxMessageRow[];
}

/**
 * 各狀態計數與最近 20 列（id desc），供 outbox 管理端點使用。
 */
export async function getOutboxStats(): Promise<OutboxStats> {
  const grouped = await db
    .select({ status: outboxMessages.status, count: sql<number>`count(*)::int` })
    .from(outboxMessages)
    .groupBy(outboxMessages.status);

  const counts: OutboxStats["counts"] = { pending: 0, processing: 0, done: 0, dead: 0 };
  for (const row of grouped) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] = row.count;
    }
  }

  const recent = await db.select().from(outboxMessages).orderBy(desc(outboxMessages.id)).limit(20);

  return { counts, recent };
}
