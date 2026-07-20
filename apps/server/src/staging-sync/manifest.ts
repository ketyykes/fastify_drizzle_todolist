import {
  templateItemTags,
  templateItemTagsStaging,
  templateItems,
  templateItemsStaging,
  templateLists,
  templateListsStaging,
} from "@fastify_drizzle_todolist/db";
import type { AnyPgTable } from "drizzle-orm/pg-core";

// 範本目錄的「3 表 manifest」：staging-writer（逐頁寫入 staging）、merger
// （mark-and-sweep 原子切換）、測試（manifest.test.ts）共用的單一事實來源。
// 新增或調整欄位只需要改這裡，不必到處對欄名——這正是本檔存在的目的。
//
// 三個欄位陣列的語意：
// - stagingConflictColumns：staging 表 upsert 的 conflict key（含 syncRunId，
//   做到「run 隔離＋跨頁重複 last-row-wins」，見 staging-writer.ts）
// - targetConflictColumns：目標表 merge 的 conflict key（純業務鍵，刻意不含本地
//   id／sync_run_id——全量刷新每次都可能整批換一輪本地 PK 世代，用本地 id join
//   會在刷新後產生大量對不上的孤兒，見設計簡報 §13 教學重點 5）
// - payloadColumns：從 staging 帶到目標表、且 mark-and-sweep 命中時要覆蓋更新的
//   欄位；不含 conflict key（值本來就相等，不必再 SET 一次）、不含
//   is_active/position（狀態與衍生欄位只在目標表計算，見下方個別說明）、
//   也不含 timestamps（updated_at 由 $onUpdate 自動維護）
export interface TemplateCatalogManifestEntry {
  readonly name: string;
  readonly stagingTable: AnyPgTable;
  readonly targetTable: AnyPgTable;
  readonly stagingConflictColumns: readonly string[];
  readonly targetConflictColumns: readonly string[];
  readonly payloadColumns: readonly string[];
}

export const templateListsManifestEntry: TemplateCatalogManifestEntry = {
  name: "template_lists",
  stagingTable: templateListsStaging,
  targetTable: templateLists,
  stagingConflictColumns: ["syncRunId", "sourceListId"],
  targetConflictColumns: ["sourceListId"],
  payloadColumns: ["title", "description"],
};

export const templateItemsManifestEntry: TemplateCatalogManifestEntry = {
  name: "template_items",
  stagingTable: templateItemsStaging,
  targetTable: templateItems,
  stagingConflictColumns: ["syncRunId", "sourceItemId"],
  targetConflictColumns: ["sourceItemId"],
  // 注意：position 刻意不在 payload 內——它是衍生欄位，由 merger.ts 的
  // recomputePositions() 在同一交易內以 window function 全量重算，不是從
  // staging 原樣搬過去的（見設計簡報 §7）。
  payloadColumns: ["sourceListId", "title", "priority"],
};

export const templateItemTagsManifestEntry: TemplateCatalogManifestEntry = {
  name: "template_item_tags",
  stagingTable: templateItemTagsStaging,
  targetTable: templateItemTags,
  // 複合 conflict key 示範：業務鍵本身就是 (source_item_id, tag)
  stagingConflictColumns: ["syncRunId", "sourceItemId", "tag"],
  targetConflictColumns: ["sourceItemId", "tag"],
  // 這張表沒有額外的 payload 欄位——conflict key 就是全部的業務資料
  payloadColumns: [],
};

export const templateCatalogManifest: readonly TemplateCatalogManifestEntry[] = [
  templateListsManifestEntry,
  templateItemsManifestEntry,
  templateItemTagsManifestEntry,
];
