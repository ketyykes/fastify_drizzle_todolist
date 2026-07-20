import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// staging-sync 範例：大量外部資料「逐頁抓取 → staging 暫存表 → 單一交易原子
// 切換（mark-and-sweep）」的核心協調表。核心原則：分批的是記憶體，不是 commit。
//
// sync_runs 是整個同步流程的狀態機與協調中樞：
//   fetching → staged → swapping → done
//                 └──────────────→ abandoned（人工放棄，僅限 staged）
//   fetching → fetch_failed（Phase 1 失敗）
//   swapping 失敗會退回 staged（見 merger.ts 的 returnSwapToStaged）
//
// owner_token / lease_version 是 fencing 憑證：advisory lock 綁 session，
// session 斷線鎖會自動釋放，但舊 worker 可能還活著繼續寫；
// fencing token 讓每次狀態轉移都帶著「上一輪憑證」比對，擋下 stale writer。

export const syncRunPhaseEnum = pgEnum("sync_run_phase", [
  "fetching",
  "staged",
  "swapping",
  "done",
  "fetch_failed",
  "abandoned",
]);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: serial("id").primaryKey(),
    syncType: varchar("sync_type", { length: 50 }).notNull(),
    phase: syncRunPhaseEnum("phase").notNull(),
    // fencing 憑證：搭配 leaseVersion 防止舊 worker（stale writer）在鎖失效後繼續寫
    ownerToken: uuid("owner_token"),
    leaseVersion: integer("lease_version").notNull().default(0),
    // 持鎖連線的 pg_backend_pid，觀測用（可對照 pg_stat_activity 排查卡鎖）
    lockBackendPid: integer("lock_backend_pid"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    lastOffset: integer("last_offset"),
    pageCount: integer("page_count"),
    sourceCount: integer("source_count"),
    // { lists: n, items: n, tags: n }
    stagedCounts: jsonb("staged_counts"),
    peakMemoryBytes: bigint("peak_memory_bytes", { mode: "number" }),
    fetchSeconds: numeric("fetch_seconds", { precision: 12, scale: 4 }),
    swapSeconds: numeric("swap_seconds", { precision: 12, scale: 4 }),
    swapAttempts: integer("swap_attempts").notNull().default(0),
    // success | no_data | fetch_failed | swap_failed | abandoned
    resultCode: varchar("result_code", { length: 30 }),
    lastErrorPhase: varchar("last_error_phase", { length: 50 }),
    // 消毒過的錯誤訊息：只存「錯誤類別: 訊息前 300 字」，禁止存完整 response body/payload/token
    errorMessage: text("error_message"),
    abandonedBy: varchar("abandoned_by", { length: 100 }),
    abandonedReason: text("abandoned_reason"),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    stagedAt: timestamp("staged_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // 持久 invariant（最後防線）：同一 sync_type 同時只能有一個進行中（未達終態）的
    // run，即使繞過 advisory lock 也擋得住第二個 run；insert 撞 23505 由呼叫端
    // 轉譯成 ActiveSyncRunError。
    uniqueIndex("uq_sync_runs_active")
      .on(table.syncType)
      .where(sql`phase IN ('fetching','staged','swapping')`),
  ],
);

// 三張 staging 暫存表，皆以 (sync_run_id, 業務鍵) 為 UNIQUE conflict key。
// 規則：staging 不含 is_active/position（狀態與衍生欄位只在目標表計算與儲存）；
// conflict key 欄一律 NOT NULL；staging 不存目標表的本地 id。
// sourcePage/sourceRow 僅供除錯用，刻意不進唯一鍵。

export const templateListsStaging = pgTable(
  "template_lists_staging",
  {
    id: serial("id").primaryKey(),
    syncRunId: integer("sync_run_id").notNull(),
    sourcePage: integer("source_page").notNull().default(0),
    sourceRow: integer("source_row").notNull().default(0),
    sourceListId: integer("source_list_id").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
  },
  (table) => [
    index("idx_stg_template_lists_run").on(table.syncRunId),
    // run 隔離＋跨頁重複冪等：同一 run 同一來源業務鍵只能有一列（last-row-wins upsert）
    unique("uq_stg_template_lists").on(table.syncRunId, table.sourceListId),
  ],
);

export const templateItemsStaging = pgTable(
  "template_items_staging",
  {
    id: serial("id").primaryKey(),
    syncRunId: integer("sync_run_id").notNull(),
    sourcePage: integer("source_page").notNull().default(0),
    sourceRow: integer("source_row").notNull().default(0),
    sourceItemId: integer("source_item_id").notNull(),
    sourceListId: integer("source_list_id").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    priority: integer("priority").notNull(),
  },
  (table) => [
    index("idx_stg_template_items_run").on(table.syncRunId),
    unique("uq_stg_template_items").on(table.syncRunId, table.sourceItemId),
  ],
);

export const templateItemTagsStaging = pgTable(
  "template_item_tags_staging",
  {
    id: serial("id").primaryKey(),
    syncRunId: integer("sync_run_id").notNull(),
    sourcePage: integer("source_page").notNull().default(0),
    sourceRow: integer("source_row").notNull().default(0),
    sourceItemId: integer("source_item_id").notNull(),
    tag: varchar("tag", { length: 100 }).notNull(),
  },
  (table) => [
    index("idx_stg_template_item_tags_run").on(table.syncRunId),
    // 複合 conflict key 示範：同一 run 內同一項目同一標籤只能有一列
    unique("uq_stg_template_item_tags").on(table.syncRunId, table.sourceItemId, table.tag),
  ],
);
