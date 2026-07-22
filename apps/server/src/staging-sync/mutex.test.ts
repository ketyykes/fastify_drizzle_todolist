// mutex.ts 的 advisory lock 是純 PostgreSQL session 層機制，不需要任何資料表，
// 因此本檔不呼叫 resetDb()，直接對真實測試庫的連線池操作。
import { pool } from "@fastify_drizzle_todolist/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LockConflictError, LockError } from "./errors";
import { acquireSyncLock } from "./mutex";

describe("acquireSyncLock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("兩個併發取同一把鎖，只有一個成功，另一個拋 LockConflictError", async () => {
    const first = await acquireSyncLock("mutex_test_concurrent");

    await expect(acquireSyncLock("mutex_test_concurrent")).rejects.toThrow(LockConflictError);

    await first.release();
  });

  it("release 之後可以重新取得同一把鎖", async () => {
    const first = await acquireSyncLock("mutex_test_reacquire");
    await first.release();

    const second = await acquireSyncLock("mutex_test_reacquire");
    // 沒有拋錯即代表成功重新取得
    await second.release();
  });

  it("不同 syncType 互不影響，可同時各自取得", async () => {
    const a = await acquireSyncLock("mutex_test_a");
    const b = await acquireSyncLock("mutex_test_b");

    await a.release();
    await b.release();
  });

  it("鎖釘住同一條連線：backendPid 與該連線自己查到的 pg_backend_pid() 一致", async () => {
    const lock = await acquireSyncLock("mutex_test_same_session");

    const result = await lock.client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");

    expect(result.rows[0]?.pid).toBe(lock.backendPid);

    await lock.release();
  });

  it("取鎖查詢過程發生非預期錯誤時拋 LockError，並銷毀/歸還借出的連線", async () => {
    const fakeClient = {
      query: vi.fn().mockRejectedValue(new Error("模擬連線錯誤")),
      release: vi.fn(),
    };
    vi.spyOn(pool, "connect").mockResolvedValueOnce(fakeClient as never);

    await expect(acquireSyncLock("mutex_test_query_error")).rejects.toThrow(LockError);
    expect(fakeClient.release).toHaveBeenCalledTimes(1);
  });

  it("pool.connect 本身失敗（連線池故障）時，也要轉譯成 LockError 而非讓原始錯誤外洩", async () => {
    vi.spyOn(pool, "connect").mockRejectedValueOnce(new Error("模擬連線池耗盡"));

    await expect(acquireSyncLock("mutex_test_connect_error")).rejects.toThrow(LockError);
  });

  it("release 時 pg_advisory_unlock 回傳 false 會記錄 structured warning，但仍歸還連線", async () => {
    const fakeClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // pg_try_advisory_lock
        .mockResolvedValueOnce({ rows: [{ pid: 12345 }] }) // pg_backend_pid
        .mockResolvedValueOnce({ rows: [{ unlocked: false }] }), // pg_advisory_unlock
      release: vi.fn(),
    };
    vi.spyOn(pool, "connect").mockResolvedValueOnce(fakeClient as never);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const lock = await acquireSyncLock("mutex_test_unlock_false");
    await lock.release();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [warningPayload] = warnSpy.mock.calls[0] ?? [];
    expect(typeof warningPayload).toBe("string");
    expect(warningPayload as string).toContain("staging_sync_unlock_returned_false");
    expect(fakeClient.release).toHaveBeenCalledTimes(1);
  });

  it("release 可安全地重複呼叫（第二次以後為 no-op，不會重複下 unlock 查詢）", async () => {
    const lock = await acquireSyncLock("mutex_test_double_release");

    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
