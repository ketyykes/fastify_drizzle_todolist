// outbox 狀態字面量集中於此，避免散落各處打錯字（見 docs/outbox/design.md §2 差異五）。
export const OUTBOX_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  DONE: "done",
  DEAD: "dead",
} as const;

export type OutboxStatus = (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS];

// sweeper 單輪最多認領筆數
export const BATCH_LIMIT = 100;

// processing 超過此分鐘數視為卡住（worker 處理中 crash），自動退回 pending
export const STALE_PROCESSING_MINUTES = 15;
