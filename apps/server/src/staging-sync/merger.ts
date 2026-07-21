import { db, syncRuns } from "@fastify_drizzle_todolist/db";
import { eq, getTableColumns, getTableName, sql } from "drizzle-orm";

import { SYNC_RUN_PHASE } from "./constants";
import { FenceLostError } from "./errors";
import type { SyncRunFence } from "./fence";
import { templateCatalogManifest, type TemplateCatalogManifestEntry } from "./manifest";
import {
  claimForSwap,
  completeInsideTransaction,
  returnSwapToStaged,
  type SyncRunTx,
} from "./run-manager";

// merger：Phase 2（原子切換）。整個模組只有一個對外入口 swap()，把 staging
// 表的內容以「mark-and-sweep」方式一次性 merge 回三張目標表，並在**同一個交易**
// 內把 sync_runs 轉成 done——這正是本範例的核心：分批的是記憶體（Phase 1 逐頁
// 寫 staging），不是最終切換的 commit（Phase 2 永遠是單一交易）。
//
// mark-and-sweep 三步驟（皆在同一交易內）：
//   1. mark：三張目標表整批 `UPDATE SET is_active=false`。
//   2. merge：三張表各自 `INSERT ... SELECT FROM staging WHERE sync_run_id=$
//      ON CONFLICT (業務鍵) DO UPDATE SET 業務鍵=excluded.業務鍵..., is_active=true`——
//      staging 裡有的業務鍵「復活」（is_active 設回 true），staging 沒有的
//      （代表來源已經沒有這筆資料）維持 mark 階段設的 false，不會被刪除。
//   3. recomputePositions：template_items.position 全量重算（見設計簡報 §7）。
//
// 任何一步失敗，整個交易 rollback，目標表回到 swap 前的狀態；run 退回 staged
// （見 returnSwapToStaged），staging 資料完整保留，下次呼叫 swap() 可以直接
// 重播，不必重新 fetch。

export interface SwapOptions {
  // 測試專用：在每個關鍵時間點呼叫一次，模擬「merge 交易中途崩潰」。
  // 傳入的 hook 名稱固定為 `after_mark:<table>`、`after_merge:<table>`、
  // `after_positions` 三種；若這個 callback 拋錯，會讓整個 merge 交易失敗
  // rollback（正式流程不會傳入這個選項）。
  failureInjector?: (hook: string) => void;
}

export interface SwapSummary {
  runId: number;
  swapSeconds: number;
}

/**
 * 取出 drizzle table 欄位 map 中，指定 JS 屬性名（camelCase）對應的實際 DB
 * 欄位名稱（snake_case）。用法與 staging-writer.ts 的同名 helper 相同，各自
 * 獨立一份（兩個模組刻意保持無互相依賴，各自都是小檔案、單一職責）。
 */
function dbColumnName(
  table: TemplateCatalogManifestEntry["targetTable"] | TemplateCatalogManifestEntry["stagingTable"],
  key: string,
): string {
  const column = getTableColumns(table)[key];
  if (!column) {
    throw new Error(`資料表缺少欄位 ${key}（manifest 設定與 schema 不一致）`);
  }
  return column.name;
}

/**
 * mark 階段：單一目標表整批 `UPDATE SET is_active=false`（只更新目前還是
 * true 的列，效果等價於無條件整批 UPDATE，但少改動一些已經是 false 的列）。
 */
async function markTableInactive(
  tx: SyncRunTx,
  entry: TemplateCatalogManifestEntry,
): Promise<void> {
  const tableName = getTableName(entry.targetTable);
  const isActiveColumn = dbColumnName(entry.targetTable, "isActive");

  await tx.execute(sql`
    UPDATE ${sql.identifier(tableName)}
    SET ${sql.identifier(isActiveColumn)} = false
    WHERE ${sql.identifier(isActiveColumn)} = true
  `);
}

/**
 * merge 階段：單一表的 `INSERT ... SELECT FROM staging WHERE sync_run_id=$
 * ON CONFLICT (業務鍵) DO UPDATE`。staging 沒有 is_active 欄位，merge 進目標表
 * 一律設 true（來源仍存在的資料才會被 merge，設 true 代表「復活」）。
 */
async function mergeTableFromStaging(
  tx: SyncRunTx,
  entry: TemplateCatalogManifestEntry,
  runId: number,
): Promise<void> {
  const targetTableName = getTableName(entry.targetTable);
  const stagingTableName = getTableName(entry.stagingTable);
  const isActiveColumn = dbColumnName(entry.targetTable, "isActive");

  // 這張表要搬過去的欄位：業務鍵（conflict key）＋ payload（不含 sync_run_id／
  // 除錯欄位／is_active／position——position 是衍生欄位，由 recomputePositions
  // 另外重算，不從 staging 原樣搬移，見 manifest.ts 註解）。
  const carriedKeys = [...entry.targetConflictColumns, ...entry.payloadColumns];
  const targetInsertColumns = [...carriedKeys, "isActive"].map((key) =>
    sql.identifier(dbColumnName(entry.targetTable, key)),
  );
  const stagingSelectColumns = carriedKeys.map((key) =>
    sql.identifier(dbColumnName(entry.stagingTable, key)),
  );
  const conflictColumns = entry.targetConflictColumns.map((key) =>
    sql.identifier(dbColumnName(entry.targetTable, key)),
  );
  // SET 子句：payload 欄位 excluded 覆蓋＋is_active 設回 true＋updated_at 手動
  // 打卡（raw SQL 繞過 drizzle 的 $onUpdate 客端預設，需要自己補上）。
  const payloadAssignments = entry.payloadColumns.map((key) => {
    const dbName = dbColumnName(entry.targetTable, key);
    return sql`${sql.identifier(dbName)} = excluded.${sql.identifier(dbName)}`;
  });
  const setAssignments = [
    ...payloadAssignments,
    sql`${sql.identifier(isActiveColumn)} = true`,
    sql`updated_at = now()`,
  ];

  await tx.execute(sql`
    INSERT INTO ${sql.identifier(targetTableName)} (${sql.join(targetInsertColumns, sql`, `)})
    SELECT ${sql.join(stagingSelectColumns, sql`, `)}, true
    FROM ${sql.identifier(stagingTableName)}
    WHERE sync_run_id = ${runId}
    ON CONFLICT (${sql.join(conflictColumns, sql`, `)})
    DO UPDATE SET ${sql.join(setAssignments, sql`, `)}
  `);
}

/**
 * template_items.position 全量重算（見設計簡報 §7，逐字語意照做）：每個
 * source_list_id 各自從 1 開始重新編號，priority 由高到低排序、同分時以
 * source_item_id 遞增決勝（決定性 tie-breaker，確保重算結果可重現）。
 * 只重算 is_active=true 的列；inactive 的列維持舊值，不受影響。
 */
async function recomputePositions(tx: SyncRunTx): Promise<void> {
  await tx.execute(sql`
    UPDATE template_items AS ti
    SET position = ranked.rn
    FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY source_list_id
        ORDER BY priority DESC, source_item_id ASC
      ) AS rn
      FROM template_items
      WHERE is_active = true
    ) AS ranked
    WHERE ti.id = ranked.id
  `);
}

/**
 * 交易內：鎖住 sync_runs 該列並比對 fence（phase 必須是 swapping）。
 */
async function assertSwappingFence(tx: SyncRunTx, fence: SyncRunFence): Promise<void> {
  const [locked] = await tx
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.id, fence.runId))
    .for("update")
    .limit(1);

  if (
    !locked ||
    locked.phase !== SYNC_RUN_PHASE.SWAPPING ||
    locked.ownerToken !== fence.ownerToken ||
    locked.leaseVersion !== fence.leaseVersion
  ) {
    throw new FenceLostError({
      runId: fence.runId,
      expectedPhase: SYNC_RUN_PHASE.SWAPPING,
      ownerToken: fence.ownerToken,
      leaseVersion: fence.leaseVersion,
      operation: "merger.swap",
    });
  }
}

/**
 * 刪除某個 run 在三張 staging 表的所有列。swap 成功 commit 後呼叫（best-effort
 * 立即清理），也供 pruner.ts 的 retention 清理共用（見 pruner.ts）。
 */
export async function deleteStagingRows(runId: number): Promise<void> {
  for (const entry of templateCatalogManifest) {
    const tableName = getTableName(entry.stagingTable);
    await db.execute(sql`
      DELETE FROM ${sql.identifier(tableName)} WHERE sync_run_id = ${runId}
    `);
  }
}

/**
 * Phase 2：把 stagedFence 對應的 run 從 staging 原子切換進三張目標表。
 *
 * 流程：
 *   1. `claimForSwap`（自帶交易）：staged → swapping，換發新 fence。
 *   2. 單一 merge 交易：鎖 run 列驗 fence → mark 三表 → merge 三表 →
 *      recomputePositions → `completeInsideTransaction`（swapping → done，
 *      必須在同一交易內）。
 *   3. 交易成功：best-effort 清 staging（失敗只 warn，殘留交給 pruner）。
 *   4. 交易失敗：rollback 後 `returnSwapToStaged`（run 退回 staged，
 *      owner_token/lease_version 保留原樣，staging 完整保留），重拋原錯誤。
 *
 * @param options.failureInjector 測試專用：在每個關鍵點呼叫一次，可注入拋錯
 *   模擬交易中途崩潰（見設計簡報 §12 merger 測試矩陣）。
 */
export async function swap(
  stagedFence: SyncRunFence,
  options: SwapOptions = {},
): Promise<SwapSummary> {
  const failureInjector = options.failureInjector ?? (() => {});
  const swappingFence = await claimForSwap(stagedFence);
  const startedAt = Date.now();

  try {
    await db.transaction(async (tx) => {
      await assertSwappingFence(tx, swappingFence);

      for (const entry of templateCatalogManifest) {
        await markTableInactive(tx, entry);
        failureInjector(`after_mark:${entry.name}`);
      }

      for (const entry of templateCatalogManifest) {
        await mergeTableFromStaging(tx, entry, swappingFence.runId);
        failureInjector(`after_merge:${entry.name}`);
      }

      await recomputePositions(tx);
      failureInjector("after_positions");

      const swapSeconds = (Date.now() - startedAt) / 1000;
      await completeInsideTransaction(tx, swappingFence, { swapSeconds });
    });
  } catch (error) {
    // merge 交易已經 rollback：目標表回到 swap 前的狀態，run 仍是 swapping
    // （資料庫視角），必須手動退回 staged 才能讓下一次 dispatch 重播。
    await returnSwapToStaged(swappingFence, error);
    throw error;
  }

  try {
    await deleteStagingRows(swappingFence.runId);
  } catch (error) {
    // best-effort：staging 清理失敗不影響本次 swap 的成功結果，殘留交給
    // pruner.ts 的 retention 清理兜底。
    console.warn(
      JSON.stringify({
        event: "staging_sync_delete_staging_rows_failed",
        runId: swappingFence.runId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return {
    runId: swappingFence.runId,
    swapSeconds: (Date.now() - startedAt) / 1000,
  };
}
