import { randomUUID } from "node:crypto";

import {
  db,
  templateItemTagsStaging,
  templateItemsStaging,
  templateListsStaging,
} from "@fastify_drizzle_todolist/db";
import { getTableName, sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import { getStagingSyncConfig } from "./config";
import { SYNC_TYPE_TEMPLATE_CATALOG } from "./constants";
import type { SyncRunFence } from "./fence";
import type { SyncLock } from "./mutex";
import { streamCatalogPages } from "./page-fetcher";
import { transformPage } from "./page-transformer";
import {
  failPhaseOne,
  markNoData,
  markStaged,
  recoverActiveRun,
  startFetching,
} from "./run-manager";
import { writePage } from "./staging-writer";

// orchestrator：Phase 1（逐頁抓取 → staging）的協調者。整個模組只有一個對外
// 入口 runPhaseOne()，把 page-fetcher／page-transformer／staging-writer／
// run-manager 串成完整的 Phase 1 流程。
//
// 呼叫前提：呼叫端（dispatcher.ts）此刻已經持有 SYNC_TYPE_TEMPLATE_CATALOG 的
// advisory lock（見 mutex.ts）——這是 recoverActiveRun 能安全判死殘留 run 的前提
// （見 run-manager.ts 的 recoverActiveRun 說明）。
//
// 核心紀律（呼應設計簡報「分批的是記憶體，不是 commit」）：for-await 逐頁處理，
// 每頁處理完就讓 page／buffers 參照離開作用域被回收，絕不把多頁資料累積在
// 同一個變數裡；checkpoint（lastOffset/pageCount/sourceCount/peakMemoryBytes）
// 由本函式逐頁累算成「絕對值」，交給 writePage 原樣寫入。

export type PhaseOneResult =
  | { kind: "no_data"; runId: number }
  | { kind: "staged"; fence: SyncRunFence; replayed: boolean };

export interface RunPhaseOneOptions {
  // 測試專用：注入假 sleep，略過 page-fetcher 重試時的真實等待時間
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 對單一 staging 表下 `COUNT(*) WHERE sync_run_id = $runId`，回傳整數筆數。
 * 用 raw SQL（而非 drizzle 的 count() helper）是為了與 staging-writer.ts／
 * merger.ts 一致的「manifest 動態組欄位」風格保持同調，且明確 `::int` 轉型，
 * 避免 pg driver 把 bigint 型別的 COUNT(*) 回傳成字串。
 */
async function countStagingTableRows(table: AnyPgTable, runId: number): Promise<number> {
  const tableName = getTableName(table);
  const result = await db.execute<{ n: number }>(
    sql`SELECT COUNT(*)::int AS n FROM ${sql.identifier(tableName)} WHERE sync_run_id = ${runId}`,
  );
  return result.rows[0]?.n ?? 0;
}

/**
 * 統計本輪三張 staging 表各自的筆數，鍵名固定為 lists/items/tags（對應
 * sync_runs.staged_counts 的形狀，見 packages/db 的 staging-sync.ts 註解）。
 */
async function countStagedRows(runId: number): Promise<Record<string, number>> {
  return {
    lists: await countStagingTableRows(templateListsStaging, runId),
    items: await countStagingTableRows(templateItemsStaging, runId),
    tags: await countStagingTableRows(templateItemTagsStaging, runId),
  };
}

/**
 * Phase 1：逐頁抓取來源、轉換、寫入 staging，最終把 run 推進到 staged（或
 * sourceCount=0 時直接收尾成 no_data）。
 *
 * 流程：
 *   1. `recoverActiveRun`：處理殘留的 active run（見設計簡報 §5）。
 *      - kind='staged' 或 'recovered_swapping_to_staged'：資料已經完整落地
 *        staging，直接回傳 `{ kind: 'staged', replayed: true }`，**不發任何
 *        HTTP**，交給呼叫端直接進 Phase 2 重播（見設計簡報 §13 教學重點 6）。
 *      - kind='recovered_fetching_to_fetch_failed'：前一輪已判死，繼續往下
 *        開新的一輪。
 *      - kind='none'：沒有殘留，繼續往下開新的一輪。
 *   2. `startFetching` 取得新的 fence。
 *   3. for-await 逐頁：fetch → transform → writePage，checkpoint 逐頁累算。
 *   4. sourceCount===0 → `markNoData`；否則統計 stagedCounts → `markStaged`。
 *
 * 錯誤處理：`startFetching` 之前發生的錯誤（例如 recoverActiveRun 本身失敗、
 * ActiveSyncRunError）直接讓它往上拋，此時還沒有 fence 可以記錄失敗狀態。
 * `startFetching` 之後、迴圈內任何一步失敗，一律呼叫 `failPhaseOne` 記錄
 * `last_error_phase`（用迴圈內追蹤的 currentSubPhase 粗粒度標記究竟是
 * 'fetch'／'transform'／'stage_write' 哪一步失敗）後再重新拋出。
 */
export async function runPhaseOne(
  lock: SyncLock,
  options: RunPhaseOneOptions = {},
): Promise<PhaseOneResult> {
  const recovery = await recoverActiveRun(SYNC_TYPE_TEMPLATE_CATALOG);

  if (recovery.kind === "staged" || recovery.kind === "recovered_swapping_to_staged") {
    return { kind: "staged", fence: recovery.fence, replayed: true };
  }
  // recovery.kind 為 'recovered_fetching_to_fetch_failed' 或 'none'：
  // 前者代表前一輪已經被判死收尾，兩種情況都繼續往下開一輪全新的同步。

  const fence = await startFetching(SYNC_TYPE_TEMPLATE_CATALOG, randomUUID(), lock.backendPid);

  let lastOffset = 0;
  let pageCount = 0;
  let sourceCount = 0;
  let peakMemoryBytes = process.memoryUsage().heapUsed;
  const startedAt = Date.now();

  // 粗粒度追蹤目前執行到 Phase 1 的哪一個子步驟，供失敗時的 last_error_phase
  // 使用。'fetch' 涵蓋「呼叫 streamCatalogPages 取得下一頁」（含其內建重試），
  // 每次成功處理完一頁、準備抓下一頁前會重設回 'fetch'。
  let currentSubPhase: "fetch" | "transform" | "stage_write" = "fetch";

  try {
    for await (const page of streamCatalogPages(getStagingSyncConfig(), {
      sleep: options.sleep,
    })) {
      currentSubPhase = "transform";
      const buffers = transformPage(page.pageIndex, page.rows);

      pageCount += 1;
      sourceCount += page.rows.length;
      lastOffset = page.offset;
      peakMemoryBytes = Math.max(peakMemoryBytes, process.memoryUsage().heapUsed);

      currentSubPhase = "stage_write";
      await writePage(
        fence,
        {
          lastOffset,
          pageCount,
          sourceCount,
          heartbeatAt: new Date(),
          peakMemoryBytes,
        },
        buffers,
      );

      // 本頁處理完畢：不再持有 page／buffers 的任何額外參照（迴圈變數本身
      // 隨下一輪迭代被取代），準備抓下一頁。
      currentSubPhase = "fetch";
    }
  } catch (error) {
    try {
      await failPhaseOne(fence, currentSubPhase, error);
    } catch (recordError) {
      // 記錄失敗狀態本身失敗，根因與 merger.swap 相同：fence 已經被別的流程
      // 搶走——例如另一個持有 advisory lock 的 worker 呼叫 recoverActiveRun，
      // 已經把這個殘留 run 判死收尾（owner_token/lease_version 都已換新），
      // 這裡的 fenced update 自然 0 列命中而拋出 FenceLostError。真正持有
      // 新 fence 的那一方已經正確處理，不該讓這個次要錯誤蓋掉呼叫端原本就該
      // 看到的原始錯誤，這裡只記一筆結構化 log 供事後追查，最後仍必須讓
      // 原始 error 浮上去。
      console.warn(
        JSON.stringify({
          event: "staging_sync_phase_one_failure_record_failed",
          runId: fence.runId,
          error: recordError instanceof Error ? recordError.constructor.name : String(recordError),
        }),
      );
    }
    throw error;
  }

  if (sourceCount === 0) {
    await markNoData(fence);
    return { kind: "no_data", runId: fence.runId };
  }

  const stagedCounts = await countStagedRows(fence.runId);
  const fetchSeconds = (Date.now() - startedAt) / 1000;

  const stagedFence = await markStaged(fence, {
    lastOffset,
    pageCount,
    sourceCount,
    stagedCounts,
    peakMemoryBytes,
    fetchSeconds,
  });

  return { kind: "staged", fence: stagedFence, replayed: false };
}
