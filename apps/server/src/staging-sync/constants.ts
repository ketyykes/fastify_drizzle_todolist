// staging-sync 範例的共用常數：phase／result code 字面量集中於此，避免各檔案手動
// 輸入字串造成打錯字風險（比照 apps/server/src/outbox/constants.ts 的做法）。

// sync_runs.phase 狀態機的合法值，對應 packages/db 的 sync_run_phase enum：
//   fetching → staged → swapping → done
//                 └──────────────→ abandoned（人工放棄，僅限 staged）
//   fetching → fetch_failed（Phase 1 失敗）
//   swapping 失敗會退回 staged（見 run-manager.ts 的 returnSwapToStaged）
export const SYNC_RUN_PHASE = {
  FETCHING: "fetching",
  STAGED: "staged",
  SWAPPING: "swapping",
  DONE: "done",
  FETCH_FAILED: "fetch_failed",
  ABANDONED: "abandoned",
} as const;

export type SyncRunPhase = (typeof SYNC_RUN_PHASE)[keyof typeof SYNC_RUN_PHASE];

// sync_runs.result_code 的合法值；只有走到終態（done/fetch_failed/abandoned）才會有值。
export const RESULT_CODE = {
  SUCCESS: "success",
  NO_DATA: "no_data",
  FETCH_FAILED: "fetch_failed",
  SWAP_FAILED: "swap_failed",
  ABANDONED: "abandoned",
} as const;

export type ResultCode = (typeof RESULT_CODE)[keyof typeof RESULT_CODE];

// 本範例目前只示範一種同步類型；sync_type 欄位刻意設計成字串（而非寫死在 schema），
// 是為了讓 sync_runs / advisory lock / partial unique index 這套機制未來能擴充給
// 其他來源重複使用。
export const SYNC_TYPE_TEMPLATE_CATALOG = "template_catalog";

// staging 表分批 chunk insert 的單批筆數上限（見 staging-writer.ts）。
export const STAGING_CHUNK_SIZE = 500;
