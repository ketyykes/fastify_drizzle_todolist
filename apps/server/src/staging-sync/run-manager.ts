import { randomUUID } from "node:crypto";

import { db, syncRuns } from "@fastify_drizzle_todolist/db";
import { and, eq, inArray } from "drizzle-orm";

import { RESULT_CODE, SYNC_RUN_PHASE, type SyncRunPhase } from "./constants";
import { ActiveSyncRunError, FenceLostError } from "./errors";
import type { SyncRunFence } from "./fence";

// sync_runs 狀態機 repository：本檔是唯一能寫 sync_runs.phase 的地方。
// 狀態機全貌（見設計簡報 §5、schema 檔頭註解）：
//   fetching → staged → swapping → done
//                 └──────────────→ abandoned（人工放棄，僅限 staged）
//   fetching → fetch_failed（Phase 1 失敗，或殘留孤兒被判死）
//   swapping 失敗（或殘留孤兒）會退回 staged
//
// 每一次狀態轉移都是一個「fenced update」：
//   WHERE id = runId AND phase = expectedPhase
//     AND owner_token = ownerToken AND lease_version = leaseVersion
// 驗 rowCount === 1，不符就拋 FenceLostError（見 fencedUpdate 私有 helper）。
// 這是 fencing 機制的核心：憑證對不上代表「別人已經動過這個 run」，絕不能
// 沿用舊憑證繼續寫下去（見 fence.ts 的說明）。

export type SyncRunRow = typeof syncRuns.$inferSelect;

// db.transaction 回呼參數的型別，供 completeInsideTransaction 要求呼叫端傳入
// 自己的交易物件（比照 outbox/repository.ts 的 OutboxTx）。
export type SyncRunTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type SyncRunExecutor = typeof db | SyncRunTx;

/**
 * 取出 Postgres 錯誤碼（如 unique violation 為 23505）。
 * drizzle 會把底層 pg 的 DatabaseError 包成 DrizzleQueryError，真正帶 `code`
 * 的錯誤在 `error.cause`，因此需要往下解包一層。
 */
function pgErrorCode(error: unknown): string | undefined {
  const target =
    error && typeof error === "object" && "cause" in error
      ? (error as { cause?: unknown }).cause
      : error;
  if (target && typeof target === "object" && "code" in target) {
    return (target as { code?: string }).code;
  }
  return undefined;
}

/**
 * 消毒錯誤訊息：只保留「錯誤類別名: 訊息前 300 字」。
 * 禁止把完整 response body、payload、token 存進 sync_runs.error_message
 * （見設計簡報 §6）。
 */
function sanitizeErrorMessage(error: unknown): string {
  const className = error instanceof Error ? error.constructor.name : typeof error;
  const rawMessage = error instanceof Error ? error.message : String(error);
  return `${className}: ${rawMessage.slice(0, 300)}`;
}

/**
 * 所有 fenced update 共用的私有 helper：帶 fence 條件的 UPDATE，
 * 驗 rowCount === 1，不符就拋 FenceLostError。
 */
async function fencedUpdate(
  executor: SyncRunExecutor,
  params: {
    fence: SyncRunFence;
    expectedPhase: SyncRunPhase;
    operation: string;
    values: Partial<typeof syncRuns.$inferInsert>;
  },
): Promise<void> {
  const updated = await executor
    .update(syncRuns)
    .set(params.values)
    .where(
      and(
        eq(syncRuns.id, params.fence.runId),
        eq(syncRuns.phase, params.expectedPhase),
        eq(syncRuns.ownerToken, params.fence.ownerToken),
        eq(syncRuns.leaseVersion, params.fence.leaseVersion),
      ),
    )
    .returning({ id: syncRuns.id });

  if (updated.length !== 1) {
    throw new FenceLostError({
      runId: params.fence.runId,
      expectedPhase: params.expectedPhase,
      ownerToken: params.fence.ownerToken,
      leaseVersion: params.fence.leaseVersion,
      operation: params.operation,
    });
  }
}

/**
 * 開啟一輪新的同步（Phase 1 起點）：insert 一列 phase='fetching'、
 * lease_version=1。撞上 partial unique index（23505）代表已有進行中的 run，
 * 轉譯成 ActiveSyncRunError。
 */
export async function startFetching(
  syncType: string,
  ownerToken: string,
  lockBackendPid: number,
): Promise<SyncRunFence> {
  try {
    const [inserted] = await db
      .insert(syncRuns)
      .values({
        syncType,
        phase: SYNC_RUN_PHASE.FETCHING,
        ownerToken,
        leaseVersion: 1,
        lockBackendPid,
      })
      .returning({ id: syncRuns.id });

    if (!inserted) {
      throw new Error("建立 sync_runs 失敗：insert 未回傳任何列");
    }

    return {
      runId: inserted.id,
      phase: SYNC_RUN_PHASE.FETCHING,
      ownerToken,
      leaseVersion: 1,
    };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new ActiveSyncRunError(syncType);
    }
    throw error;
  }
}

export interface StagedMetrics {
  lastOffset: number;
  pageCount: number;
  sourceCount: number;
  stagedCounts: Record<string, number>;
  peakMemoryBytes: number;
  fetchSeconds: number;
}

/**
 * Phase 1 成功結束：fetching → staged，寫入抓取階段的統計數字。
 * owner_token / lease_version 維持不變（同一輪憑證繼續帶到 Phase 2 的
 * claimForSwap）。
 */
export async function markStaged(
  fence: SyncRunFence,
  metrics: StagedMetrics,
): Promise<SyncRunFence> {
  await fencedUpdate(db, {
    fence,
    expectedPhase: SYNC_RUN_PHASE.FETCHING,
    operation: "markStaged",
    values: {
      phase: SYNC_RUN_PHASE.STAGED,
      stagedAt: new Date(),
      lastOffset: metrics.lastOffset,
      pageCount: metrics.pageCount,
      sourceCount: metrics.sourceCount,
      stagedCounts: metrics.stagedCounts,
      peakMemoryBytes: metrics.peakMemoryBytes,
      fetchSeconds: metrics.fetchSeconds.toFixed(4),
    },
  });
  return { ...fence, phase: SYNC_RUN_PHASE.STAGED };
}

/**
 * Phase 1 抓到 0 筆來源資料：視為正常完成但沒有東西可切換，直接收尾成終態
 * done／result_code=no_data，不需要進 Phase 2 swap。owner_token 清 null
 * （終態不再需要 fencing 憑證）。
 */
export async function markNoData(fence: SyncRunFence): Promise<void> {
  await fencedUpdate(db, {
    fence,
    expectedPhase: SYNC_RUN_PHASE.FETCHING,
    operation: "markNoData",
    values: {
      phase: SYNC_RUN_PHASE.DONE,
      resultCode: RESULT_CODE.NO_DATA,
      finishedAt: new Date(),
      ownerToken: null,
    },
  });
}

/**
 * Phase 1 失敗：fetching → fetch_failed。errorMessage 會被消毒（見
 * sanitizeErrorMessage）。owner_token 清 null（終態不再需要 fencing 憑證）。
 */
export async function failPhaseOne(
  fence: SyncRunFence,
  errorPhase: string,
  error: unknown,
): Promise<void> {
  await fencedUpdate(db, {
    fence,
    expectedPhase: SYNC_RUN_PHASE.FETCHING,
    operation: "failPhaseOne",
    values: {
      phase: SYNC_RUN_PHASE.FETCH_FAILED,
      resultCode: RESULT_CODE.FETCH_FAILED,
      lastErrorPhase: errorPhase,
      errorMessage: sanitizeErrorMessage(error),
      finishedAt: new Date(),
      ownerToken: null,
    },
  });
}

/**
 * Phase 2 起點：staged → swapping。交易內 `SELECT ... FOR UPDATE` 鎖住該列、
 * 比對 fence，再 CAS 更新：換發新的 owner_token（crypto.randomUUID）、
 * lease_version+1、swap_attempts+1。回傳新的 fence，供後續
 * completeInsideTransaction／returnSwapToStaged 使用。
 */
export async function claimForSwap(stagedFence: SyncRunFence): Promise<SyncRunFence> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.id, stagedFence.runId))
      .for("update")
      .limit(1);

    if (
      !locked ||
      locked.phase !== SYNC_RUN_PHASE.STAGED ||
      locked.ownerToken !== stagedFence.ownerToken ||
      locked.leaseVersion !== stagedFence.leaseVersion
    ) {
      throw new FenceLostError({
        runId: stagedFence.runId,
        expectedPhase: SYNC_RUN_PHASE.STAGED,
        ownerToken: stagedFence.ownerToken,
        leaseVersion: stagedFence.leaseVersion,
        operation: "claimForSwap",
      });
    }

    const newOwnerToken = randomUUID();
    const newLeaseVersion = stagedFence.leaseVersion + 1;

    await fencedUpdate(tx, {
      fence: stagedFence,
      expectedPhase: SYNC_RUN_PHASE.STAGED,
      operation: "claimForSwap",
      values: {
        phase: SYNC_RUN_PHASE.SWAPPING,
        ownerToken: newOwnerToken,
        leaseVersion: newLeaseVersion,
        swapAttempts: locked.swapAttempts + 1,
      },
    });

    return {
      runId: stagedFence.runId,
      phase: SYNC_RUN_PHASE.SWAPPING,
      ownerToken: newOwnerToken,
      leaseVersion: newLeaseVersion,
    };
  });
}

export interface CompleteSummary {
  swapSeconds: number;
}

/**
 * Phase 2 成功結束：swapping → done。**必須傳入呼叫端（merger）自己的交易
 * 物件 tx**，讓「mark-and-sweep 寫入目標表」與「sync_runs 轉 done」在同一個
 * 交易內原子提交——這正是本範例的核心：分批的是記憶體（staging 逐頁寫入），
 * 不是最終切換的 commit（swap 永遠是單一交易）。
 */
export async function completeInsideTransaction(
  tx: SyncRunTx,
  fence: SyncRunFence,
  summary: CompleteSummary,
): Promise<void> {
  await fencedUpdate(tx, {
    fence,
    expectedPhase: SYNC_RUN_PHASE.SWAPPING,
    operation: "completeInsideTransaction",
    values: {
      phase: SYNC_RUN_PHASE.DONE,
      resultCode: RESULT_CODE.SUCCESS,
      finishedAt: new Date(),
      swapSeconds: summary.swapSeconds.toFixed(4),
      ownerToken: null,
    },
  });
}

/**
 * Phase 2 失敗（merge 交易 rollback 後呼叫）：swapping → staged。
 * 刻意保留 owner_token／lease_version 不變——staging 資料完整保留，下一次
 * dispatch 的 recoverActiveRun 可以直接把同一份 fence 交回去重播 swap，
 * **不必重新 fetch**（見設計簡報 §13 教學重點 6）。
 */
export async function returnSwapToStaged(fence: SyncRunFence, error: unknown): Promise<void> {
  await fencedUpdate(db, {
    fence,
    expectedPhase: SYNC_RUN_PHASE.SWAPPING,
    operation: "returnSwapToStaged",
    values: {
      phase: SYNC_RUN_PHASE.STAGED,
      resultCode: RESULT_CODE.SWAP_FAILED,
      lastErrorPhase: "swap",
      errorMessage: sanitizeErrorMessage(error),
    },
  });
}

// recoverActiveRun 的三種「找到殘留 active run」結果，外加「沒有殘留」的
// none：discriminated union 讓呼叫端（orchestrator/dispatcher）依 kind
// 分流處理，不必自己重新判斷 phase 語意。
export type ActiveRunRecovery =
  | { kind: "none" }
  | { kind: "staged"; fence: SyncRunFence }
  | { kind: "recovered_swapping_to_staged"; fence: SyncRunFence }
  | { kind: "recovered_fetching_to_fetch_failed"; runId: number };

/**
 * 查詢並復原「殘留的 active run」（phase 仍是 fetching/staged/swapping）。
 * **呼叫時機的前提**：呼叫端此刻已經持有 syncType 的全域 advisory lock——
 * 這代表任何仍卡在 fetching 或 swapping 的殘留列，都不可能是「活著、仍在跑」
 * 的同一輪（活著的話它會持有鎖，我們就取不到鎖），一定是前一個 worker
 * 異常終止（crash）、session 斷線讓鎖自動釋放後留下的孤兒。
 *
 * - phase='staged'：資料已經完整落地在 staging，原樣回傳 fence，
 *   呼叫端可以直接進 Phase 2（swap）重播。
 * - phase='fetching'：Phase 1 進行到一半就死掉，staging 資料不完整、不可信，
 *   fenced 轉 fetch_failed，回傳後呼叫端應該重新 startFetching。
 * - phase='swapping'：claimForSwap 已經把 phase 轉成 swapping，但接下來的
 *   merge 交易沒有 commit（若已 commit 早就是 done 了）——資料庫層面等同
 *   「不曾發生過」，fenced 退回 staged 且 lease_version+1，安全重播 swap。
 */
export async function recoverActiveRun(syncType: string): Promise<ActiveRunRecovery> {
  const [active] = await db
    .select()
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.syncType, syncType),
        inArray(syncRuns.phase, [
          SYNC_RUN_PHASE.FETCHING,
          SYNC_RUN_PHASE.STAGED,
          SYNC_RUN_PHASE.SWAPPING,
        ]),
      ),
    )
    .limit(1);

  if (!active) {
    return { kind: "none" };
  }

  if (!active.ownerToken) {
    throw new Error(
      `sync_runs id=${active.id} phase=${active.phase} 但 owner_token 為 null，資料異常`,
    );
  }

  if (active.phase === SYNC_RUN_PHASE.STAGED) {
    return {
      kind: "staged",
      fence: {
        runId: active.id,
        phase: SYNC_RUN_PHASE.STAGED,
        ownerToken: active.ownerToken,
        leaseVersion: active.leaseVersion,
      },
    };
  }

  if (active.phase === SYNC_RUN_PHASE.FETCHING) {
    const staleFence: SyncRunFence = {
      runId: active.id,
      phase: SYNC_RUN_PHASE.FETCHING,
      ownerToken: active.ownerToken,
      leaseVersion: active.leaseVersion,
    };
    await fencedUpdate(db, {
      fence: staleFence,
      expectedPhase: SYNC_RUN_PHASE.FETCHING,
      operation: "recoverActiveRun(fetching->fetch_failed)",
      values: {
        phase: SYNC_RUN_PHASE.FETCH_FAILED,
        resultCode: RESULT_CODE.FETCH_FAILED,
        lastErrorPhase: "fetch",
        errorMessage: "Error: 前一輪 fetching 因 worker 異常終止而殘留，取得全域鎖後判死",
        finishedAt: new Date(),
        ownerToken: null,
      },
    });
    return { kind: "recovered_fetching_to_fetch_failed", runId: active.id };
  }

  // 剩下唯一可能：phase === 'swapping'
  const staleSwapFence: SyncRunFence = {
    runId: active.id,
    phase: SYNC_RUN_PHASE.SWAPPING,
    ownerToken: active.ownerToken,
    leaseVersion: active.leaseVersion,
  };
  const newLeaseVersion = active.leaseVersion + 1;
  await fencedUpdate(db, {
    fence: staleSwapFence,
    expectedPhase: SYNC_RUN_PHASE.SWAPPING,
    operation: "recoverActiveRun(swapping->staged)",
    values: {
      phase: SYNC_RUN_PHASE.STAGED,
      leaseVersion: newLeaseVersion,
      resultCode: RESULT_CODE.SWAP_FAILED,
      lastErrorPhase: "swap",
      errorMessage: "Error: 前一輪 swapping 因 worker 異常終止而殘留，取得全域鎖後退回 staged",
    },
  });
  return {
    kind: "recovered_swapping_to_staged",
    fence: {
      runId: active.id,
      phase: SYNC_RUN_PHASE.STAGED,
      ownerToken: active.ownerToken,
      leaseVersion: newLeaseVersion,
    },
  };
}

/**
 * 人工放棄一個 staged run（僅限 phase='staged'；已進入 swapping 或已是終態都
 * 不允許放棄）。
 *
 * 刻意不用 fence／不拋 FenceLostError：這是操作者（admin 路由）主動發起的
 * 動作，不是某一輪同步流程內部的狀態轉移，呼叫端手上通常只有 runId，沒有
 * fence 憑證。
 *
 * @returns 放棄成功則回傳更新後的列；run 不存在或不是 staged 狀態則回傳
 *   null（呼叫端例如 admin 路由可據此回應 422）——「run 不是 staged」是可
 *   預期的呼叫端輸入錯誤，不是系統例外，刻意不用拋錯表達。
 */
export async function abandon(
  runId: number,
  reason: string,
  operator: string,
): Promise<SyncRunRow | null> {
  const now = new Date();
  const updated = await db
    .update(syncRuns)
    .set({
      phase: SYNC_RUN_PHASE.ABANDONED,
      resultCode: RESULT_CODE.ABANDONED,
      abandonedBy: operator,
      abandonedReason: reason,
      abandonedAt: now,
      finishedAt: now,
      ownerToken: null,
    })
    .where(and(eq(syncRuns.id, runId), eq(syncRuns.phase, SYNC_RUN_PHASE.STAGED)))
    .returning();

  return updated[0] ?? null;
}
