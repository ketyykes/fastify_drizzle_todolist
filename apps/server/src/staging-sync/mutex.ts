import { pool } from "@fastify_drizzle_todolist/db";

import { LockConflictError, LockError } from "./errors";

// 本模組實際只會用到 pg PoolClient 的 query／release 兩個方法，因此自行宣告
// 一個「只涵蓋所需方法」的最小結構型別，取代直接引用 "pg" 的型別——apps/server
// 沒有宣告 "pg" 這個相依套件（pnpm 嚴格模式下只有 packages/db 能 import 它）。
//
// 這裡刻意不用 `Awaited<ReturnType<typeof pool.connect>>` 推導：`pool.connect`
// 是多載函式（無參數版回傳 `Promise<PoolClient>`；callback 版回傳 `void`），
// 型別查詢（而非實際呼叫）只會取到「最後一個」多載（此處恰好是 callback 版），
// 且即使繞過這點，composite 專案的宣告檔（.d.ts）產出也會因為「推導出的型別
// 無法在不引用 pg 的情況下命名」而報錯（TS2883）。改用下面這個完全自包含、
// 可命名的介面，在借出連線時以型別標註做結構相容性檢查即可。
export interface StagingSyncPoolClient {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    queryText: string,
    values?: unknown[],
  ): Promise<{ rows: TRow[] }>;
  release(err?: Error | boolean): void;
}

export interface SyncLock {
  // 持鎖的專用連線（session）。後續整輪同步的所有操作都必須沿用這條連線，
  // 直到呼叫 release() 為止——advisory lock 綁定在 session 上，換一條連線
  // 等於沒鎖（見下方 acquireSyncLock 的說明）。
  client: StagingSyncPoolClient;
  // 持鎖連線的 pg_backend_pid，寫進 sync_runs.lock_backend_pid 供觀測／除錯用
  // （例如對照 pg_stat_activity 排查卡鎖）。
  backendPid: number;
  // 釋放鎖並把 client 歸還連線池。務必在 finally 呼叫；可重複呼叫（第二次以後
  // 為 no-op）。
  release: () => Promise<void>;
}

/**
 * 取得 sync_type 專屬的 PostgreSQL session advisory lock。
 *
 * 為什麼需要「專用 client」：`pg_try_advisory_lock` / `pg_advisory_unlock`
 * 是綁在單一資料庫連線（session）上的——鎖是連線的屬性，不是資料庫的全域狀態。
 * 一般透過 `db`（drizzle 的 pool 介面）下查詢，每次可能從連線池借用不同的底層
 * 連線，無法保證「上鎖」與「後續操作」發生在同一個 session。因此這裡改用
 * `pool.connect()` 額外借出一條專用連線，並把它整個交給呼叫端，直到明確呼叫
 * `release()` 才歸還——這段期間內絕不能讓這條連線被挪去做別的事。
 *
 * 用兩個 `hashtext()` 組成一組 64 bit advisory lock key：第一段是固定的
 * 命名空間字串 `'staging_sync'`，第二段用 `syncType` 字串，讓不同 sync_type
 * 可以各自獨立上鎖、互不影響。
 *
 * @throws {LockConflictError} 鎖目前被其他流程持有（pg_try_advisory_lock 回傳 false）
 * @throws {LockError} 取鎖過程中發生非預期錯誤（例如連線層錯誤）
 */
export async function acquireSyncLock(syncType: string): Promise<SyncLock> {
  // pool.connect() 本身也可能失敗（連線池耗盡、資料庫不可達……）。這裡刻意把它
  // 一併包進 try：契約上「取鎖過程中發生的任何錯誤」都應轉譯成 LockError，讓
  // 呼叫端（dispatcher/route）統一映射成 503——若讓這裡的原始錯誤直接外洩，
  // 上層會落入「其餘錯誤」分支被誤判成 502（SourceFetchError／swap 失敗等
  // 才該有的狀態碼），混淆「取鎖失敗」與「同步流程本身失敗」兩種完全不同的情境。
  let client: StagingSyncPoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw new LockError(syncType, error);
  }
  let acquired = false;

  try {
    try {
      const lockResult = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('staging_sync'), hashtext($1)) AS acquired",
        [syncType],
      );
      acquired = lockResult.rows[0]?.acquired ?? false;
    } catch (error) {
      throw new LockError(syncType, error);
    }

    if (!acquired) {
      throw new LockConflictError(syncType);
    }

    const pidResult = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const backendPid = pidResult.rows[0]?.pid;
    if (backendPid === undefined) {
      throw new Error("無法取得 pg_backend_pid()：查詢未回傳任何列");
    }

    let released = false;
    const release = async (): Promise<void> => {
      if (released) {
        return;
      }
      released = true;
      try {
        const unlockResult = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtext('staging_sync'), hashtext($1)) AS unlocked",
          [syncType],
        );
        const unlocked = unlockResult.rows[0]?.unlocked ?? false;
        if (!unlocked) {
          // 結構化 warning：unlock 回 false 代表這條連線其實沒有持有這把鎖
          // （理論上不該發生——本連線是唯一的持有者——但仍記錄以便追查）。
          console.warn(
            JSON.stringify({
              event: "staging_sync_unlock_returned_false",
              syncType,
              backendPid,
            }),
          );
        }
      } finally {
        client.release();
      }
    };

    return { client, backendPid, release };
  } catch (error) {
    // 走到這裡代表「回傳 release() 給呼叫端」之前就失敗了：
    // - acquired 仍是 false（鎖忙碌／查詢失敗）：連線本身沒有持有任何鎖，安全歸還連線池。
    // - acquired 已是 true（例如緊接著查 backend pid 失敗）：鎖已經拿到但沒人會呼叫
    //   release()，若把連線原樣還給池子，鎖會隨著這條連線被下一次 pool.connect()
    //   借走而卡住。因此改用 client.release(err) 直接銷毀這條連線，讓 pool 開一條
    //   新的取代，避免鎖洩漏。
    if (acquired) {
      client.release(error instanceof Error ? error : new Error(String(error)));
    } else {
      client.release();
    }
    if (error instanceof LockConflictError || error instanceof LockError) {
      throw error;
    }
    throw new LockError(syncType, error);
  }
}
