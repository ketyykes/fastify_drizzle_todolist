import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

// 範本目錄（template catalog）目標資料表：staging-sync 範例的「事實」落地表，
// 由 staging 暫存表在單一交易內以 mark-and-sweep 方式全量刷新（見 staging-sync.ts）。
//
// 教學重點：template_items.sourceListId 刻意以「來源業務鍵」關聯
// template_lists.sourceListId，不使用本地 id 外鍵——全量刷新每次都可能整批
// 換一輪本地 PK 世代，若用本地 PK join 會在刷新後產生大量對不上的孤兒。

export const templateLists = pgTable("template_lists", {
  id: serial("id").primaryKey(),
  // 來源系統的業務鍵；全量刷新 upsert 的 conflict target
  sourceListId: integer("source_list_id").notNull().unique("uq_template_lists_source"),
  title: varchar("title", { length: 200 }).notNull(),
  description: text("description"),
  // mark-and-sweep：merge 前整批設 false，merge 命中（來源仍存在）的列設回 true，
  // 沒被命中（來源已刪除）的列維持 false
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const templateItems = pgTable("template_items", {
  id: serial("id").primaryKey(),
  sourceItemId: integer("source_item_id").notNull().unique("uq_template_items_source"),
  // 刻意用來源業務鍵關聯 templateLists.sourceListId，不用本地 id 外鍵（見檔頭說明）
  sourceListId: integer("source_list_id").notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  priority: integer("priority").notNull().default(0),
  // 衍生欄位：同一清單內依 priority 由高到低重新編排的名次，
  // Phase 2 merge 交易內以 window function 全量重算（見 merger.ts）
  position: integer("position").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const templateItemTags = pgTable(
  "template_item_tags",
  {
    id: serial("id").primaryKey(),
    sourceItemId: integer("source_item_id").notNull(),
    tag: varchar("tag", { length: 100 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // 複合 conflict key 示範：同一項目下同一標籤只能有一列
    unique("uq_template_item_tags_source").on(table.sourceItemId, table.tag),
  ],
);
