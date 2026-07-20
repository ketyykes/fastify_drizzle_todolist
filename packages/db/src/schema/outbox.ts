import { index, integer, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

// transactional outbox 訊息表：交易內只寫「待送出意圖」，不存 payload，
// 送出時依 refId 重抓最新業務資料現組 payload（見 docs/outbox/design.md）。
export const outboxMessages = pgTable(
  "outbox_messages",
  {
    id: serial("id").primaryKey(),
    // 事件類型，本範例為 todo.completed
    topic: varchar("topic", { length: 50 }).notNull(),
    // 業務主鍵（todos.id）
    refId: integer("ref_id").notNull(),
    // 事件動作別；同一 ref 允許多筆
    action: varchar("action", { length: 30 }).notNull().default("sync"),
    // pending / processing / done / dead
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    // 下次可重送時間（退避），入隊時預設為 now
    nextAttemptAt: timestamp("next_attempt_at").defaultNow().notNull(),
    lastError: text("last_error"),
    // 認領時間（配合 FOR UPDATE SKIP LOCKED 與卡住回收）
    lockedAt: timestamp("locked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // sweeper 撈件：依狀態與到期時間查詢
    index("idx_outbox_status_next").on(table.status, table.nextAttemptAt),
    // 依 ref 查詢；刻意不設唯一索引，同一 ref 可有多筆不同事件
    index("idx_outbox_topic_ref").on(table.topic, table.refId),
  ],
);
