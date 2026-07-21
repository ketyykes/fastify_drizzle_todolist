import { db, syncRuns } from "@fastify_drizzle_todolist/db";
import { and, inArray, lt } from "drizzle-orm";

import { getStagingSyncConfig } from "./config";
import { SYNC_RUN_PHASE, type SyncRunPhase } from "./constants";
import { deleteStagingRows } from "./merger";

// pruner：staging-sync 的 retention 清理排程。三道門檻各自獨立生效（見
// config.ts 的 StagingSyncRetentionConfig）：
//   1. phase='done' 且 finished_at 超過 doneStagingDays  → 清該 run 的 staging 列
//   2. phase IN ('fetch_failed','abandoned') 且 finished_at 超過 failedStagingDays
//      → 清該 run 的 staging 列（abandon() 會同時寫入 abandoned_at 與
//      finished_at，兩者同值，故只需檢查 finished_at 即可涵蓋兩種寫法）
//   3. 終態（done/fetch_failed/abandoned）且 finished_at 超過 terminalRunDays
//      → 連 sync_runs 列本身都刪除（保留期最長，做為最終資料清理）
//
// **永不碰 active phase**（fetching/staged/swapping）：三道查詢一律只挑
// phase IN (done, fetch_failed, abandoned) 的列，active run 不會被任何一步觸及，
// 即使誤植了很舊的 finished_at 也一樣（查詢本身就先用 phase 過濾掉）。
//
// 冪等：每次呼叫都是「查詢當下仍符合門檻的列」，清過的 run 下次查詢自然不會
// 再被選中（staging 已空、或 sync_runs 列已被刪除），重跑不會出錯也不會重複計數。

export interface PruneSummary {
  // 因超過 doneStagingDays 而被清空 staging 列的 run 數
  doneStagingRunsCleaned: number;
  // 因超過 failedStagingDays 而被清空 staging 列的 run 數
  failedStagingRunsCleaned: number;
  // 因超過 terminalRunDays 而被整列刪除的 sync_runs 數
  runsDeleted: number;
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * 查出「指定 phase 集合、finished_at 早於 cutoff」的 run id 清單。
 * 特別說明：active phase（finished_at 恆為 null）的列，`lt(finishedAt, cutoff)`
 * 在 SQL 上對 NULL 比較會得到 NULL（視同不符合條件），天生就不會被選到——
 * 這裡額外限定 phase 只挑終態，是為了讓「永不碰 active phase」的意圖在程式碼
 * 上清楚可見，不只是依賴 NULL 比較的副作用。
 */
async function selectTerminalRunIdsPastCutoff(
  phases: readonly SyncRunPhase[],
  cutoff: Date,
): Promise<number[]> {
  const rows = await db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(and(inArray(syncRuns.phase, phases), lt(syncRuns.finishedAt, cutoff)));
  return rows.map((row) => row.id);
}

/**
 * 執行一次 retention 清理，回傳各項清理筆數。
 *
 * @param now 供測試注入的「當下時間」，預設為呼叫當下的實際時間。
 */
export async function pruneStagingSyncRuns(now: Date = new Date()): Promise<PruneSummary> {
  const config = getStagingSyncConfig();

  const doneCutoff = daysAgo(now, config.retention.doneStagingDays);
  const failedCutoff = daysAgo(now, config.retention.failedStagingDays);
  const terminalCutoff = daysAgo(now, config.retention.terminalRunDays);

  // 1. done 且超過 doneStagingDays：清 staging
  const doneRunIds = await selectTerminalRunIdsPastCutoff([SYNC_RUN_PHASE.DONE], doneCutoff);
  for (const runId of doneRunIds) {
    await deleteStagingRows(runId);
  }

  // 2. fetch_failed/abandoned 且超過 failedStagingDays：清 staging
  const failedRunIds = await selectTerminalRunIdsPastCutoff(
    [SYNC_RUN_PHASE.FETCH_FAILED, SYNC_RUN_PHASE.ABANDONED],
    failedCutoff,
  );
  for (const runId of failedRunIds) {
    await deleteStagingRows(runId);
  }

  // 3. 終態且超過 terminalRunDays：連 sync_runs 列本身都刪除。
  // 保險先清一次 staging（即使前兩步條件更嚴格、理論上此刻早已清過）：
  // staging 表未對 sync_runs 設 FK／CASCADE，若 retention 設定被誤設成
  // terminalRunDays 小於 done/failedStagingDays，直接刪 sync_runs 列可能會
  // 留下孤兒 staging 列，這裡不論設定為何都先確保乾淨再刪。
  const terminalRunIds = await selectTerminalRunIdsPastCutoff(
    [SYNC_RUN_PHASE.DONE, SYNC_RUN_PHASE.FETCH_FAILED, SYNC_RUN_PHASE.ABANDONED],
    terminalCutoff,
  );
  for (const runId of terminalRunIds) {
    await deleteStagingRows(runId);
  }
  let runsDeleted = 0;
  if (terminalRunIds.length > 0) {
    const deleted = await db
      .delete(syncRuns)
      .where(inArray(syncRuns.id, terminalRunIds))
      .returning({ id: syncRuns.id });
    runsDeleted = deleted.length;
  }

  return {
    doneStagingRunsCleaned: doneRunIds.length,
    failedStagingRunsCleaned: failedRunIds.length,
    runsDeleted,
  };
}
