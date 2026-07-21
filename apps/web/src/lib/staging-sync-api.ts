import { httpClient } from "./http-client";

// staging-sync 教學範例：與後端 sync_runs 狀態機／mock 範本庫 API 對應的型別
// 與封裝，走 `httpClient`（沿用專案既有 axios instance + JWT interceptor 慣例）。
//
// 契約依據：docs/staging-sync/design.md §9（admin 路由）／§8（mock 來源路由）。

// sync_runs.phase：狀態機的合法值
export type SyncRunPhase =
  "fetching" | "staged" | "swapping" | "done" | "fetch_failed" | "abandoned";

// sync_runs.result_code：只有走到終態（done/fetch_failed/abandoned）才會有值
export type ResultCode = "success" | "no_data" | "fetch_failed" | "swap_failed" | "abandoned";

// mock 範本庫（template catalog provider）的五種行為模式
export type MockSourceMode = "success" | "fail" | "fail_page_2" | "flaky_page_2" | "empty";

// GET /staging-sync/runs 單筆列表項目：sync_runs 全欄位扣除 owner_token
// （fencing 憑證，依契約絕不外洩到前端，見 design.md §9「不含 owner_token」）。
export interface SyncRunListItem {
  id: number;
  syncType: string;
  phase: SyncRunPhase;
  leaseVersion: number;
  lockBackendPid: number | null;
  heartbeatAt: string | null;
  lastOffset: number | null;
  pageCount: number | null;
  sourceCount: number | null;
  stagedCounts: Record<string, number> | null;
  peakMemoryBytes: number | null;
  // 後端 numeric 欄位常以字串序列化以避免精度遺失；顯示前一律用 Number() 轉換，
  // 故此處保守接受 number 或 string。
  fetchSeconds: number | string | null;
  swapSeconds: number | string | null;
  swapAttempts: number;
  resultCode: ResultCode | null;
  lastErrorPhase: string | null;
  errorMessage: string | null;
  abandonedBy: string | null;
  abandonedReason: string | null;
  abandonedAt: string | null;
  startedAt: string;
  stagedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// POST /staging-sync/trigger 200 回應：dispatcher 的結果摘要（消毒過，不含 token）
export interface TriggerSyncResult {
  runId: number;
  resultCode: ResultCode;
  // 本次結果是否來自「殘留 run 的重播」（recoverActiveRun 命中 staged），
  // 而非本次重新抓取的全新一輪
  replayed: boolean;
  pageCount: number | null;
  sourceCount: number | null;
  stagedCounts: Record<string, number> | null;
  fetchSeconds: number | null;
  swapSeconds: number | null;
}

export interface TemplateCatalogItem {
  sourceItemId: number;
  title: string;
  priority: number;
  position: number;
  tags: string[];
}

export interface TemplateCatalogList {
  sourceListId: number;
  title: string;
  description: string | null;
  items: TemplateCatalogItem[];
}

// GET /staging-sync/catalog：目前生效中（is_active=true）的範本目錄，
// items 已依 position 排序
export interface TemplateCatalog {
  lists: TemplateCatalogList[];
}

export interface MockSourceModeState {
  mode: MockSourceMode;
}

/**
 * 觸發一次「範本目錄」全量同步（dispatcher 的 runTemplateCatalogSync）。
 * 200＝完成（含 no_data）；409＝鎖衝突或 active run 衝突；503＝鎖層錯誤；
 * 502＝Phase 1／Phase 2 過程本身失敗（fetch_failed／swap_failed）。
 * 非 2xx 一律讓 axios 拋錯，呼叫端用 `getErrorMessage()` 取得訊息。
 */
export async function triggerStagingSync(): Promise<TriggerSyncResult> {
  const { data } = await httpClient.post<TriggerSyncResult>("/staging-sync/trigger");
  return data;
}

/**
 * 讀取最近 N 筆同步執行紀錄（不含 owner_token），依 id 新到舊排序。
 */
export async function fetchStagingSyncRuns(limit = 20): Promise<SyncRunListItem[]> {
  const { data } = await httpClient.get<SyncRunListItem[]>("/staging-sync/runs", {
    params: { limit },
  });
  return data;
}

/**
 * 人工放棄一個仍停在 staged 的執行。僅 staged 可放棄，非 staged 回 422。
 */
export async function abandonStagingSyncRun(
  runId: number,
  reason: string,
): Promise<SyncRunListItem> {
  const { data } = await httpClient.post<SyncRunListItem>(`/staging-sync/runs/${runId}/abandon`, {
    reason,
  });
  return data;
}

/**
 * 讀取目前生效中的範本目錄（is_active=true 的 lists／items／tags，
 * items 依 position 排序）。
 */
export async function fetchStagingSyncCatalog(): Promise<TemplateCatalog> {
  const { data } = await httpClient.get<TemplateCatalog>("/staging-sync/catalog");
  return data;
}

/**
 * 切換 mock 範本庫的行為模式。
 *
 * 注意：mock-source 目前沒有「讀取目前模式」的 GET 端點（不像 mock-external
 * 有 `/mock-external/notifications` 可查目前模式），所以前端只能在「切換」
 * 或「reset」之後才知道目前模式，初始狀態一律視為未知（null）。
 */
export async function setMockSourceMode(mode: MockSourceMode): Promise<MockSourceModeState> {
  const { data } = await httpClient.put<MockSourceModeState>("/mock-source/mode", { mode });
  return data;
}

/**
 * 重置 mock 範本庫狀態（模式回 success、flaky_page_2 重試計數器歸零）。
 */
export async function resetMockSource(): Promise<{ ok: boolean }> {
  const { data } = await httpClient.post<{ ok: boolean }>("/mock-source/reset");
  return data;
}
