import { db, syncRuns } from "@fastify_drizzle_todolist/db";
import { and, eq, getTableColumns, getTableName, sql } from "drizzle-orm";

import { STAGING_CHUNK_SIZE, SYNC_RUN_PHASE } from "./constants";
import { FenceLostError } from "./errors";
import type { SyncRunFence } from "./fence";
import { templateCatalogManifest, type TemplateCatalogManifestEntry } from "./manifest";
import type { SyncRunTx } from "./run-manager";
import type { PageBuffers } from "./types";

// staging-writer：Phase 1（逐頁抓取）把「一頁」轉換好的 buffer 寫進 staging 表。
//
// 核心紀律（呼應設計簡報「分批的是記憶體，不是 commit」）：**每頁一個短交易**。
// 每次呼叫 writePage 只處理眼前這一頁的資料，交易結束就提交，不會累積多頁在
// 同一個交易或記憶體內；就算來源有數十萬筆，記憶體用量也只跟「單頁大小」成正比。
//
// 交易內容固定三步驟：
//   1. `SELECT ... FOR UPDATE` 鎖住 sync_runs 該列，手動比對 fence
//      （phase='fetching' ＋ owner_token ＋ lease_version），不符直接拋
//      FenceLostError（交易連帶 rollback，本頁的 staging 寫入也一併回滾）。
//   2. 依 manifest 逐表把 buffer 分塊（STAGING_CHUNK_SIZE）upsert 進 staging 表：
//      `ON CONFLICT (sync_run_id, 業務鍵...) DO UPDATE`——跨頁重複合法（overlap
//      漂移情境），採 last-row-wins，連同除錯用的 sourcePage/sourceRow 一併覆蓋。
//   3. 同一交易內 fenced 更新 checkpoint（lastOffset/pageCount/sourceCount/
//      heartbeatAt/peakMemoryBytes）。**checkpoint 的每個欄位都是呼叫端給的絕對
//      值**，本函式不做任何累加——呼叫端（orchestrator）才知道目前處理到第幾頁、
//      目前記憶體峰值等全域狀態。
//
// 即使三個 buffer 都是空陣列（例如某頁恰好沒有任何資料），也必須完整走過上述
// fence 驗證與 checkpoint 更新——呼叫端才能穩定地追蹤進度，不因為某頁碰巧沒資料
// 就跳過心跳與 last_offset 前進。

export interface WritePageCheckpoint {
  lastOffset: number;
  pageCount: number;
  sourceCount: number;
  heartbeatAt: Date;
  peakMemoryBytes: number;
}

/**
 * 取出 drizzle table 欄位 map 中，指定 JS 屬性名（camelCase）對應的實際 DB
 * 欄位名稱（snake_case）。manifest 上宣告的欄名一律是 JS 屬性名，這裡負責轉換
 * 成組 raw SQL 需要的實際欄名；欄名對不上（manifest 與 schema 不一致）視為
 * 設定錯誤，直接拋錯而非靜默略過。
 */
function dbColumnName(table: TemplateCatalogManifestEntry["stagingTable"], key: string): string {
  const column = getTableColumns(table)[key];
  if (!column) {
    throw new Error(`資料表缺少欄位 ${key}（manifest 設定與 schema 不一致）`);
  }
  return column.name;
}

/**
 * 依 manifest entry 名稱，從 PageBuffers 取出對應的 buffer 陣列。回傳型別刻意
 * 抹平成 Record（見下方 upsertStagingChunk 的說明）：manifest 是三張表共用的
 * 泛用結構，但 PageBuffers（types.ts，介面契約不可更動）用的是具名欄位
 * （lists/items/tags），兩邊天生無法用同一個型別串接，只能在這個轉接點做
 * 一次型別抹平。
 */
function bufferRowsFor(
  entry: TemplateCatalogManifestEntry,
  buffers: PageBuffers,
): Array<Record<string, unknown>> {
  switch (entry.name) {
    case "template_lists":
      return buffers.lists as unknown as Array<Record<string, unknown>>;
    case "template_items":
      return buffers.items as unknown as Array<Record<string, unknown>>;
    case "template_item_tags":
      return buffers.tags as unknown as Array<Record<string, unknown>>;
    default:
      throw new Error(`未知的 manifest entry：${entry.name}`);
  }
}

/**
 * 針對單一 staging 表做「chunk upsert」：INSERT ... ON CONFLICT (sync_run_id,
 * 業務鍵...) DO UPDATE。manifest 各表的欄位形狀不同（見 manifest.ts），因此改用
 * raw SQL 依 manifest 動態組欄位清單，而不是逐表手刻 drizzle query builder——
 * 這樣新增第四張表時只需要改 manifest，不必在這裡再加一份幾乎重複的程式碼。
 *
 * 每批最多 STAGING_CHUNK_SIZE 列，逐批依序執行（皆在呼叫端交易 tx 內，仍是
 * 同一個交易的一部分——分批的只是「一次 INSERT 語句的列數」，不是交易邊界）。
 */
async function upsertStagingChunk(
  tx: SyncRunTx,
  entry: TemplateCatalogManifestEntry,
  runId: number,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  const tableName = getTableName(entry.stagingTable);
  // 插入欄位順序：conflict key（含 syncRunId）＋ 除錯欄位（sourcePage/sourceRow）＋ payload 欄位
  const insertKeys = [
    ...entry.stagingConflictColumns,
    "sourcePage",
    "sourceRow",
    ...entry.payloadColumns,
  ];
  // 跨頁重複時要覆蓋的欄位：payload 欄位＋sourcePage/sourceRow（last-row-wins，
  // 見設計簡報 §5）；不含 conflict key 本身（值本來就相等，不必再 SET 一次）
  const updateKeys = ["sourcePage", "sourceRow", ...entry.payloadColumns];

  const insertColumnIdentifiers = insertKeys.map((key) =>
    sql.identifier(dbColumnName(entry.stagingTable, key)),
  );
  const conflictColumnIdentifiers = entry.stagingConflictColumns.map((key) =>
    sql.identifier(dbColumnName(entry.stagingTable, key)),
  );
  const updateAssignments = updateKeys.map((key) => {
    const dbName = dbColumnName(entry.stagingTable, key);
    return sql`${sql.identifier(dbName)} = excluded.${sql.identifier(dbName)}`;
  });

  for (let offset = 0; offset < rows.length; offset += STAGING_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + STAGING_CHUNK_SIZE);

    const valueTuples = chunk.map((row) => {
      const rowWithRunId: Record<string, unknown> = { ...row, syncRunId: runId };
      const values = insertKeys.map((key) => {
        if (!(key in rowWithRunId)) {
          throw new Error(`buffer row 缺少欄位 ${key}（manifest 設定與 buffer 形狀不一致）`);
        }
        return rowWithRunId[key];
      });
      return sql`(${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )})`;
    });

    await tx.execute(sql`
      INSERT INTO ${sql.identifier(tableName)} (${sql.join(insertColumnIdentifiers, sql`, `)})
      VALUES ${sql.join(valueTuples, sql`, `)}
      ON CONFLICT (${sql.join(conflictColumnIdentifiers, sql`, `)})
      DO UPDATE SET ${sql.join(updateAssignments, sql`, `)}
    `);
  }
}

/**
 * 交易內第一步：鎖住 sync_runs 該列並比對 fence（phase 必須是 fetching）。
 * 不符直接拋 FenceLostError——交易尚未做任何 staging 寫入，rollback 後
 * 資料庫完全不受影響。
 */
async function assertFetchingFence(tx: SyncRunTx, fence: SyncRunFence): Promise<void> {
  const [locked] = await tx
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.id, fence.runId))
    .for("update")
    .limit(1);

  if (
    !locked ||
    locked.phase !== SYNC_RUN_PHASE.FETCHING ||
    locked.ownerToken !== fence.ownerToken ||
    locked.leaseVersion !== fence.leaseVersion
  ) {
    throw new FenceLostError({
      runId: fence.runId,
      expectedPhase: SYNC_RUN_PHASE.FETCHING,
      ownerToken: fence.ownerToken,
      leaseVersion: fence.leaseVersion,
      operation: "writePage",
    });
  }
}

/**
 * 寫入一頁資料到 staging 表，並在同一交易內推進 checkpoint。
 *
 * @param fence 呼叫端目前持有的 fencing 憑證（必須是 phase='fetching'）
 * @param checkpoint 呼叫端算好的**絕對值**進度快照，本函式原樣寫入、不做累加
 * @param buffers 這一頁轉換好的 staging buffer（見 page-transformer.ts）
 * @throws {FenceLostError} fence 對不上（stale owner_token/lease_version，
 *   或 phase 已不是 fetching）——整個交易 rollback，staging 零寫入
 */
export async function writePage(
  fence: SyncRunFence,
  checkpoint: WritePageCheckpoint,
  buffers: PageBuffers,
): Promise<void> {
  await db.transaction(async (tx) => {
    await assertFetchingFence(tx, fence);

    for (const entry of templateCatalogManifest) {
      const rows = bufferRowsFor(entry, buffers);
      await upsertStagingChunk(tx, entry, fence.runId, rows);
    }

    const updated = await tx
      .update(syncRuns)
      .set({
        lastOffset: checkpoint.lastOffset,
        pageCount: checkpoint.pageCount,
        sourceCount: checkpoint.sourceCount,
        heartbeatAt: checkpoint.heartbeatAt,
        peakMemoryBytes: checkpoint.peakMemoryBytes,
      })
      .where(
        and(
          eq(syncRuns.id, fence.runId),
          eq(syncRuns.phase, SYNC_RUN_PHASE.FETCHING),
          eq(syncRuns.ownerToken, fence.ownerToken),
          eq(syncRuns.leaseVersion, fence.leaseVersion),
        ),
      )
      .returning({ id: syncRuns.id });

    if (updated.length !== 1) {
      throw new FenceLostError({
        runId: fence.runId,
        expectedPhase: SYNC_RUN_PHASE.FETCHING,
        ownerToken: fence.ownerToken,
        leaseVersion: fence.leaseVersion,
        operation: "writePage(checkpoint)",
      });
    }
  });
}
