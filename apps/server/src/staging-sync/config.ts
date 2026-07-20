import { env } from "@fastify_drizzle_todolist/env/server";

export interface StagingSyncRetentionConfig {
  // done 的 run，其 staging 列保留天數（超過即可清理；run 本身另有更長的保留期）
  doneStagingDays: number;
  // fetch_failed／abandoned 的 run，其 staging 列保留天數（供除錯用，保留較久）
  failedStagingDays: number;
  // terminal（done/fetch_failed/abandoned）run 本身（sync_runs 列）的保留天數
  terminalRunDays: number;
}

export interface StagingSyncConfig {
  // mock 範本目錄來源端點
  sourceUrl: string;
  // 每頁筆數（封頂記憶體的關鍵參數：只要每頁大小固定，逐頁處理的記憶體用量就不會
  // 隨來源總筆數成長）
  pageSize: number;
  // 單頁抓取失敗時的最大重試次數（不含第一次嘗試）；只重試網路錯誤／5xx
  fetchRetries: number;
  // 重試間隔（毫秒）
  fetchRetryDelayMs: number;
  // 單次 HTTP 請求逾時（毫秒）
  fetchTimeoutMs: number;
  // 清理（pruner）用的保留期設定
  retention: StagingSyncRetentionConfig;
}

// 測試覆寫用；非 null 時優先於 env
let testOverride: StagingSyncConfig | null = null;

/**
 * 讀取 staging-sync 設定。測試以 setStagingSyncConfigForTest 覆寫時優先回傳覆寫值。
 */
export function getStagingSyncConfig(): StagingSyncConfig {
  if (testOverride) {
    return testOverride;
  }
  return {
    sourceUrl: env.STAGING_SYNC_SOURCE_URL,
    pageSize: env.STAGING_SYNC_PAGE_SIZE,
    fetchRetries: 3,
    fetchRetryDelayMs: 1000,
    fetchTimeoutMs: env.STAGING_SYNC_FETCH_TIMEOUT_MS,
    retention: {
      doneStagingDays: 1,
      failedStagingDays: 7,
      terminalRunDays: 90,
    },
  };
}

/**
 * 測試專用：覆寫 staging-sync 設定（例如把 sourceUrl 指到 ephemeral port 的
 * mock-source，或縮短 retention 天數方便測試）。傳入 null 清除覆寫，還原成讀 env。
 */
export function setStagingSyncConfigForTest(config: StagingSyncConfig | null): void {
  testOverride = config;
}
