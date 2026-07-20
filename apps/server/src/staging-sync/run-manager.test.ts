import { randomUUID } from "node:crypto";

import { db, syncRuns } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { SYNC_RUN_PHASE, SYNC_TYPE_TEMPLATE_CATALOG, type SyncRunPhase } from "./constants";
import { ActiveSyncRunError, FenceLostError } from "./errors";
import type { SyncRunFence } from "./fence";
import { resetDb } from "../test/helpers";
import {
  abandon,
  claimForSwap,
  completeInsideTransaction,
  failPhaseOne,
  markNoData,
  markStaged,
  recoverActiveRun,
  returnSwapToStaged,
  startFetching,
} from "./run-manager";

beforeEach(async () => {
  await resetDb();
});

/**
 * 直接寫入一列 sync_runs（略過 startFetching 的 insert 限制），供測試佈置初始
 * 狀態用（比照 outbox/repository.test.ts 的 insertOutboxRow）。
 */
async function insertSyncRun(overrides: Partial<typeof syncRuns.$inferInsert> = {}) {
  const [row] = await db
    .insert(syncRuns)
    .values({
      syncType: SYNC_TYPE_TEMPLATE_CATALOG,
      phase: SYNC_RUN_PHASE.FETCHING,
      ownerToken: randomUUID(),
      leaseVersion: 1,
      ...overrides,
    })
    .returning();
  if (!row) {
    throw new Error("建立測試 sync_runs 失敗");
  }
  return row;
}

function fenceOf(row: typeof syncRuns.$inferSelect): SyncRunFence {
  if (!row.ownerToken) {
    throw new Error("測試資料異常：ownerToken 為 null");
  }
  return {
    runId: row.id,
    phase: row.phase as SyncRunPhase,
    ownerToken: row.ownerToken,
    leaseVersion: row.leaseVersion,
  };
}

async function findRun(id: number) {
  const [row] = await db.select().from(syncRuns).where(eq(syncRuns.id, id));
  return row;
}

describe("startFetching", () => {
  it("建立新 run：phase=fetching、lease_version=1，回傳對應的 fence", async () => {
    const ownerToken = randomUUID();

    const fence = await startFetching(SYNC_TYPE_TEMPLATE_CATALOG, ownerToken, 999);

    expect(fence.phase).toBe(SYNC_RUN_PHASE.FETCHING);
    expect(fence.ownerToken).toBe(ownerToken);
    expect(fence.leaseVersion).toBe(1);

    const persisted = await findRun(fence.runId);
    expect(persisted?.phase).toBe(SYNC_RUN_PHASE.FETCHING);
    expect(persisted?.ownerToken).toBe(ownerToken);
    expect(persisted?.leaseVersion).toBe(1);
    expect(persisted?.lockBackendPid).toBe(999);
  });

  it.each([SYNC_RUN_PHASE.FETCHING, SYNC_RUN_PHASE.STAGED, SYNC_RUN_PHASE.SWAPPING])(
    "已有進行中（%s）run 時拋 ActiveSyncRunError",
    async (activePhase) => {
      await insertSyncRun({ phase: activePhase });

      await expect(startFetching(SYNC_TYPE_TEMPLATE_CATALOG, randomUUID(), 1)).rejects.toThrow(
        ActiveSyncRunError,
      );
    },
  );

  it("只有 terminal run 存在時不受影響，仍可開新 run", async () => {
    await insertSyncRun({ phase: SYNC_RUN_PHASE.DONE, ownerToken: null });

    await expect(startFetching(SYNC_TYPE_TEMPLATE_CATALOG, randomUUID(), 1)).resolves.not.toThrow();
  });

  it("不同 sync_type 各自獨立，不受彼此影響", async () => {
    await insertSyncRun({ syncType: "other_type", phase: SYNC_RUN_PHASE.FETCHING });

    await expect(startFetching(SYNC_TYPE_TEMPLATE_CATALOG, randomUUID(), 1)).resolves.not.toThrow();
  });
});

describe("markStaged", () => {
  const metrics = {
    lastOffset: 100,
    pageCount: 3,
    sourceCount: 120,
    stagedCounts: { lists: 100, items: 200, tags: 50 },
    peakMemoryBytes: 12_345_678,
    fetchSeconds: 1.2345,
  };

  it("合法轉移：fetching → staged，寫入統計數字，owner/lease 不變", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.FETCHING });
    const fence = fenceOf(row);

    const newFence = await markStaged(fence, metrics);

    expect(newFence).toEqual({ ...fence, phase: SYNC_RUN_PHASE.STAGED });

    const persisted = await findRun(row.id);
    expect(persisted?.phase).toBe(SYNC_RUN_PHASE.STAGED);
    expect(persisted?.lastOffset).toBe(100);
    expect(persisted?.pageCount).toBe(3);
    expect(persisted?.sourceCount).toBe(120);
    expect(persisted?.stagedCounts).toEqual({ lists: 100, items: 200, tags: 50 });
    expect(persisted?.peakMemoryBytes).toBe(12_345_678);
    expect(persisted?.fetchSeconds).toBe("1.2345");
    expect(persisted?.stagedAt).not.toBeNull();
  });

  it("stale fence（lease_version 不符）拋 FenceLostError，且不修改資料", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.FETCHING, leaseVersion: 1 });
    const staleFence = { ...fenceOf(row), leaseVersion: 999 };

    await expect(markStaged(staleFence, metrics)).rejects.toThrow(FenceLostError);

    const persisted = await findRun(row.id);
    expect(persisted?.phase).toBe(SYNC_RUN_PHASE.FETCHING);
  });

  it("stale fence（owner_token 不符）拋 FenceLostError", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.FETCHING });
    const staleFence = { ...fenceOf(row), ownerToken: randomUUID() };

    await expect(markStaged(staleFence, metrics)).rejects.toThrow(FenceLostError);
  });

  it("stale fence（phase 已不是 fetching）拋 FenceLostError", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.STAGED });
    const fence = fenceOf(row);

    await expect(markStaged(fence, metrics)).rejects.toThrow(FenceLostError);
  });
});

describe("markNoData", () => {
  it("合法轉移：fetching → done，result_code=no_data，owner_token 清 null", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.FETCHING });
    const fence = fenceOf(row);

    await markNoData(fence);

    const persisted = await findRun(row.id);
    expect(persisted?.phase).toBe(SYNC_RUN_PHASE.DONE);
    expect(persisted?.resultCode).toBe("no_data");
    expect(persisted?.ownerToken).toBeNull();
    expect(persisted?.finishedAt).not.toBeNull();
  });

  it("stale fence 拋 FenceLostError", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.STAGED });
    const fence = fenceOf(row);

    await expect(markNoData(fence)).rejects.toThrow(FenceLostError);
  });
});

describe("failPhaseOne", () => {
  it("合法轉移：fetching → fetch_failed，錯誤訊息消毒為「類別名: 前300字」", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.FETCHING });
    const fence = fenceOf(row);
    class BoomError extends Error {}
    const longMessage = "x".repeat(400);

    await failPhaseOne(fence, "fetch", new BoomError(longMessage));

    const persisted = await findRun(row.id);
    expect(persisted?.phase).toBe(SYNC_RUN_PHASE.FETCH_FAILED);
    expect(persisted?.resultCode).toBe("fetch_failed");
    expect(persisted?.lastErrorPhase).toBe("fetch");
    expect(persisted?.errorMessage).toBe(`BoomError: ${longMessage.slice(0, 300)}`);
    expect(persisted?.errorMessage?.length).toBeLessThanOrEqual("BoomError: ".length + 300);
    expect(persisted?.ownerToken).toBeNull();
    expect(persisted?.finishedAt).not.toBeNull();
  });

  it("stale fence 拋 FenceLostError", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.FETCH_FAILED, ownerToken: null });
    const fence: SyncRunFence = {
      runId: row.id,
      phase: SYNC_RUN_PHASE.FETCHING,
      ownerToken: randomUUID(),
      leaseVersion: row.leaseVersion,
    };

    await expect(failPhaseOne(fence, "fetch", new Error("boom"))).rejects.toThrow(FenceLostError);
  });
});

describe("claimForSwap", () => {
  it("合法轉移：staged → swapping，換發新 owner_token、lease_version+1、swap_attempts+1", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.STAGED, swapAttempts: 0 });
    const fence = fenceOf(row);

    const newFence = await claimForSwap(fence);

    expect(newFence.runId).toBe(row.id);
    expect(newFence.phase).toBe(SYNC_RUN_PHASE.SWAPPING);
    expect(newFence.ownerToken).not.toBe(fence.ownerToken);
    expect(newFence.leaseVersion).toBe(fence.leaseVersion + 1);

    const persisted = await findRun(row.id);
    expect(persisted?.phase).toBe(SYNC_RUN_PHASE.SWAPPING);
    expect(persisted?.ownerToken).toBe(newFence.ownerToken);
    expect(persisted?.leaseVersion).toBe(newFence.leaseVersion);
    expect(persisted?.swapAttempts).toBe(1);
  });

  it("stale fence（phase 不是 staged）拋 FenceLostError，且不修改資料", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.FETCHING });
    const fence = fenceOf(row);

    await expect(claimForSwap(fence)).rejects.toThrow(FenceLostError);

    const persisted = await findRun(row.id);
    expect(persisted?.phase).toBe(SYNC_RUN_PHASE.FETCHING);
  });

  it("stale fence（lease_version 不符）拋 FenceLostError", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.STAGED, leaseVersion: 3 });
    const staleFence = { ...fenceOf(row), leaseVersion: 1 };

    await expect(claimForSwap(staleFence)).rejects.toThrow(FenceLostError);
  });
});

describe("completeInsideTransaction", () => {
  it("合法轉移（於呼叫端交易內）：swapping → done，寫入 swap_seconds，owner_token 清 null", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.SWAPPING });
    const fence = fenceOf(row);

    await db.transaction(async (tx) => {
      await completeInsideTransaction(tx, fence, { swapSeconds: 0.5 });
    });

    const persisted = await findRun(row.id);
    expect(persisted?.phase).toBe(SYNC_RUN_PHASE.DONE);
    expect(persisted?.resultCode).toBe("success");
    expect(persisted?.swapSeconds).toBe("0.5000");
    expect(persisted?.ownerToken).toBeNull();
    expect(persisted?.finishedAt).not.toBeNull();
  });

  it("stale fence 拋 FenceLostError，交易 rollback、資料不變", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.STAGED });
    const fence = { ...fenceOf(row), phase: SYNC_RUN_PHASE.SWAPPING } as SyncRunFence;

    await expect(
      db.transaction(async (tx) => {
        await completeInsideTransaction(tx, fence, { swapSeconds: 0.1 });
      }),
    ).rejects.toThrow(FenceLostError);

    const persisted = await findRun(row.id);
    expect(persisted?.phase).toBe(SYNC_RUN_PHASE.STAGED);
  });
});

describe("returnSwapToStaged", () => {
  it("合法轉移：swapping → staged，result_code=swap_failed，owner_token/lease_version 保留不變", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.SWAPPING, leaseVersion: 2 });
    const fence = fenceOf(row);

    await returnSwapToStaged(fence, new Error("mark-and-sweep 交易失敗"));

    const persisted = await findRun(row.id);
    expect(persisted?.phase).toBe(SYNC_RUN_PHASE.STAGED);
    expect(persisted?.resultCode).toBe("swap_failed");
    expect(persisted?.errorMessage).toContain("mark-and-sweep 交易失敗");
    // 保留原憑證，讓下次 dispatch 能直接重播，不必重新 fetch
    expect(persisted?.ownerToken).toBe(fence.ownerToken);
    expect(persisted?.leaseVersion).toBe(fence.leaseVersion);
  });

  it("stale fence 拋 FenceLostError", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.STAGED });
    const fence = { ...fenceOf(row), phase: SYNC_RUN_PHASE.SWAPPING } as SyncRunFence;

    await expect(returnSwapToStaged(fence, new Error("boom"))).rejects.toThrow(FenceLostError);
  });
});

describe("recoverActiveRun", () => {
  it("沒有殘留的 active run 時回傳 { kind: 'none' }", async () => {
    const result = await recoverActiveRun(SYNC_TYPE_TEMPLATE_CATALOG);
    expect(result).toEqual({ kind: "none" });
  });

  it("只有 terminal run 時仍視為沒有殘留", async () => {
    await insertSyncRun({ phase: SYNC_RUN_PHASE.DONE, ownerToken: null });

    const result = await recoverActiveRun(SYNC_TYPE_TEMPLATE_CATALOG);

    expect(result).toEqual({ kind: "none" });
  });

  it("phase='staged'：原樣回傳 fence，資料不變", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.STAGED });

    const result = await recoverActiveRun(SYNC_TYPE_TEMPLATE_CATALOG);

    expect(result).toEqual({ kind: "staged", fence: fenceOf(row) });
    const persisted = await findRun(row.id);
    expect(persisted?.phase).toBe(SYNC_RUN_PHASE.STAGED);
  });

  it("phase='fetching'：判死轉 fetch_failed，回傳 recovered_fetching_to_fetch_failed", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.FETCHING });

    const result = await recoverActiveRun(SYNC_TYPE_TEMPLATE_CATALOG);

    expect(result).toEqual({ kind: "recovered_fetching_to_fetch_failed", runId: row.id });
    const persisted = await findRun(row.id);
    expect(persisted?.phase).toBe(SYNC_RUN_PHASE.FETCH_FAILED);
    expect(persisted?.resultCode).toBe("fetch_failed");
    expect(persisted?.ownerToken).toBeNull();
  });

  it("phase='swapping'：退回 staged 且 lease_version+1，回傳 recovered_swapping_to_staged", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.SWAPPING, leaseVersion: 2 });

    const result = await recoverActiveRun(SYNC_TYPE_TEMPLATE_CATALOG);

    expect(result).toEqual({
      kind: "recovered_swapping_to_staged",
      fence: {
        runId: row.id,
        phase: SYNC_RUN_PHASE.STAGED,
        ownerToken: row.ownerToken,
        leaseVersion: 3,
      },
    });
    const persisted = await findRun(row.id);
    expect(persisted?.phase).toBe(SYNC_RUN_PHASE.STAGED);
    expect(persisted?.leaseVersion).toBe(3);
    expect(persisted?.resultCode).toBe("swap_failed");
  });
});

describe("abandon", () => {
  it("phase='staged' 時可放棄，寫入 abandoned_by/reason/at", async () => {
    const row = await insertSyncRun({ phase: SYNC_RUN_PHASE.STAGED });

    const result = await abandon(row.id, "人工判斷資料有誤", "operator@example.com");

    expect(result?.phase).toBe(SYNC_RUN_PHASE.ABANDONED);
    expect(result?.resultCode).toBe("abandoned");
    expect(result?.abandonedBy).toBe("operator@example.com");
    expect(result?.abandonedReason).toBe("人工判斷資料有誤");
    expect(result?.abandonedAt).not.toBeNull();
    expect(result?.ownerToken).toBeNull();
  });

  it.each([SYNC_RUN_PHASE.FETCHING, SYNC_RUN_PHASE.SWAPPING, SYNC_RUN_PHASE.DONE])(
    "phase=%s（非 staged）時回傳 null，且不修改資料",
    async (phase) => {
      const row = await insertSyncRun({
        phase,
        ownerToken: phase === SYNC_RUN_PHASE.DONE ? null : randomUUID(),
      });

      const result = await abandon(row.id, "reason", "operator@example.com");

      expect(result).toBeNull();
      const persisted = await findRun(row.id);
      expect(persisted?.phase).toBe(phase);
    },
  );

  it("run 不存在時回傳 null", async () => {
    const result = await abandon(999_999, "reason", "operator@example.com");
    expect(result).toBeNull();
  });
});
