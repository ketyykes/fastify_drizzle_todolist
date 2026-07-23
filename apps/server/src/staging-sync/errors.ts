// staging-sync 專用錯誤類別。每個錯誤都帶上足以定位問題的 context 欄位，
// 呼叫端（dispatcher / admin 路由）依錯誤型別轉譯成對應的行為或 HTTP 狀態碼。

/**
 * 同一 sync_type 已有進行中（fetching/staged/swapping）的 run，拒絕重複啟動。
 *
 * 由 sync_runs 的 partial unique index（uq_sync_runs_active）insert 撞
 * 23505（unique violation）轉譯而來——這是「持久 invariant」最後防線：
 * 即使繞過 advisory lock，資料庫層仍擋得住第二個同時進行中的 run。
 */
export class ActiveSyncRunError extends Error {
  readonly syncType: string;

  constructor(syncType: string) {
    super(`sync_type=${syncType} 已有進行中的同步，拒絕重複啟動`);
    this.name = "ActiveSyncRunError";
    this.syncType = syncType;
  }
}

/**
 * advisory lock 目前被其他流程持有（pg_try_advisory_lock 回傳 false）。
 * 屬於正常的併發保護結果，不是系統錯誤；呼叫端通常對應 HTTP 409。
 */
export class LockConflictError extends Error {
  readonly syncType: string;

  constructor(syncType: string) {
    super(`sync_type=${syncType} 的 advisory lock 目前被其他流程持有`);
    this.name = "LockConflictError";
    this.syncType = syncType;
  }
}

/**
 * 取得／釋放 advisory lock 過程中發生非預期錯誤（例如連線層錯誤），
 * 與「鎖被別人持有」的 LockConflictError 有意區分；呼叫端通常對應 HTTP 503。
 */
export class LockError extends Error {
  readonly syncType: string;

  constructor(syncType: string, cause: unknown) {
    super(`取得 sync_type=${syncType} 的 advisory lock 時發生非預期錯誤`, { cause });
    this.name = "LockError";
    this.syncType = syncType;
  }
}

/**
 * fenced update 的 WHERE 條件（id AND phase AND owner_token AND lease_version）
 * 沒有命中任何列：代表這份 fencing 憑證已經過期，或已被其他流程搶先轉移狀態。
 * 呼叫端不應該重試同一份憑證，而是重新查詢目前的真實狀態。
 */
export class FenceLostError extends Error {
  readonly runId: number;
  readonly expectedPhase: string;
  readonly ownerToken: string | null;
  readonly leaseVersion: number;
  readonly operation: string;

  constructor(context: {
    runId: number;
    expectedPhase: string;
    ownerToken: string | null;
    leaseVersion: number;
    operation: string;
  }) {
    super(
      `fenced update 失敗（operation=${context.operation}, runId=${context.runId}, ` +
        `expectedPhase=${context.expectedPhase}, leaseVersion=${context.leaseVersion}）：` +
        `憑證已過期或已被其他流程搶先轉移狀態`,
    );
    this.name = "FenceLostError";
    this.runId = context.runId;
    this.expectedPhase = context.expectedPhase;
    this.ownerToken = context.ownerToken;
    this.leaseVersion = context.leaseVersion;
    this.operation = context.operation;
  }
}

/**
 * 抓取來源分頁失敗且重試耗盡（或 4xx 不重試，直接視為耗盡）。
 */
export class SourceFetchError extends Error {
  readonly pageIndex: number;
  readonly status?: number;

  constructor(context: { pageIndex: number; status?: number; message: string }) {
    super(
      `第 ${context.pageIndex} 頁抓取失敗（status=${context.status ?? "n/a"}）：${context.message}`,
    );
    this.name = "SourceFetchError";
    this.pageIndex = context.pageIndex;
    this.status = context.status;
  }
}
