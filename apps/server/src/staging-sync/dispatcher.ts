import { db, syncRuns } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";

import { type ResultCode, SYNC_TYPE_TEMPLATE_CATALOG } from "./constants";
import type { SwapOptions } from "./merger";
import { swap } from "./merger";
import { acquireSyncLock } from "./mutex";
import { runPhaseOne } from "./orchestrator";

// dispatcher：整支 staging-sync 範例的**唯一入口**。B5 的 admin 路由與 CLI
// 都只會呼叫這一個函式；本檔負責把「取鎖 → Phase 1 → Phase 2 → 釋放鎖」串成
// 一次完整、可重複呼叫的同步流程，並組出一份消毒過的結果摘要。
//
// 錯誤映射（呼叫端據此對應行為／HTTP 狀態碼，見設計簡報 §9）：
//   - LockConflictError（鎖忙碌）／LockError（取鎖失敗）：直接讓它們往上拋，
//     dispatcher 本身不吞、不轉譯——HTTP 409/503 的映射是呼叫端（admin 路由）
//     的責任。
//   - Phase 1／Phase 2 過程中的任何錯誤（SourceFetchError、swap 失敗……）：
//     對應的 run 狀態已經由 orchestrator／merger 持久化（fetch_failed 或退回
//     staged），這裡同樣直接重拋，不重複處理。

export interface RunTemplateCatalogSyncOptions {
  // 測試專用：注入 merger.swap 的 failureInjector，模擬 Phase 2 交易中途崩潰
  swapFailureInjector?: SwapOptions["failureInjector"];
  // 測試專用：注入假 sleep，透傳給 orchestrator/page-fetcher 略過真實等待時間
  sleep?: (ms: number) => Promise<void>;
}

// 呼叫端（B5 admin 路由／CLI）看到的同步結果摘要。刻意逐欄位列舉、不整列
// spread sync_runs 的查詢結果——確保 owner_token 這種內部 fencing 憑證絕對
// 不會外洩到 HTTP 回應或 CLI 輸出（見設計簡報 §9「不含 owner_token」）。
export interface SyncRunSummary {
  runId: number;
  resultCode: ResultCode;
  // 本次結果是否來自「殘留 run 的重播」（recoverActiveRun 命中 staged／
  // recovered_swapping_to_staged），而非本次重新抓取的全新一輪
  replayed: boolean;
  pageCount: number | null;
  sourceCount: number | null;
  stagedCounts: Record<string, number> | null;
  fetchSeconds: number | null;
  swapSeconds: number | null;
}

/**
 * 依 runId 從 sync_runs 撈最終列，組成消毒過的摘要。呼叫時機是整輪流程
 * （no_data 收尾，或 Phase 1+Phase 2 都成功）已經走到終態之後，故直接信任
 * 資料庫當下的值即可，不需要呼叫端另外傳入。
 */
async function buildSummary(runId: number, replayed: boolean): Promise<SyncRunSummary> {
  const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, runId));
  if (!run) {
    throw new Error(`sync_runs id=${runId} 不存在，無法組出結果摘要（不應發生）`);
  }

  return {
    runId: run.id,
    resultCode: run.resultCode as ResultCode,
    replayed,
    pageCount: run.pageCount,
    sourceCount: run.sourceCount,
    stagedCounts: run.stagedCounts as Record<string, number> | null,
    fetchSeconds: run.fetchSeconds !== null ? Number(run.fetchSeconds) : null,
    swapSeconds: run.swapSeconds !== null ? Number(run.swapSeconds) : null,
  };
}

/**
 * 執行一次「範本目錄」全量同步：取得 advisory lock → Phase 1（orchestrator）
 * → no_data 則直接收尾；否則 Phase 2（merger.swap）→ 組摘要 → 釋放鎖。
 *
 * @throws {LockConflictError} 同 sync_type 目前已有其他流程持有鎖（HTTP 409）
 * @throws {LockError} 取鎖過程發生非預期錯誤（HTTP 503）
 * @throws 其餘 Phase 1／Phase 2 過程中的錯誤（run 狀態已持久化，直接重拋）
 */
export async function runTemplateCatalogSync(
  options: RunTemplateCatalogSyncOptions = {},
): Promise<SyncRunSummary> {
  const lock = await acquireSyncLock(SYNC_TYPE_TEMPLATE_CATALOG);

  try {
    const phaseOneResult = await runPhaseOne(lock, { sleep: options.sleep });

    if (phaseOneResult.kind === "no_data") {
      return await buildSummary(phaseOneResult.runId, false);
    }

    await swap(phaseOneResult.fence, { failureInjector: options.swapFailureInjector });

    return await buildSummary(phaseOneResult.fence.runId, phaseOneResult.replayed);
  } finally {
    await lock.release();
  }
}
