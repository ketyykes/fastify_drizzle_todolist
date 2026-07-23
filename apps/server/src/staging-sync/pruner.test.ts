import { db, syncRuns, templateListsStaging } from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getStagingSyncConfig } from "./config";
import { SYNC_RUN_PHASE, SYNC_TYPE_TEMPLATE_CATALOG } from "./constants";
import { pruneStagingSyncRuns } from "./pruner";
import { resetDb } from "../test/helpers";

beforeEach(async () => {
  await resetDb();
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** 直接寫入一列 sync_runs，供測試佈置任意 phase／finished_at 組合。 */
async function insertSyncRun(overrides: Partial<typeof syncRuns.$inferInsert> = {}) {
  const [row] = await db
    .insert(syncRuns)
    .values({
      syncType: SYNC_TYPE_TEMPLATE_CATALOG,
      phase: SYNC_RUN_PHASE.DONE,
      ownerToken: null,
      leaseVersion: 1,
      finishedAt: new Date(),
      ...overrides,
    })
    .returning();
  if (!row) {
    throw new Error("建立測試 sync_runs 失敗");
  }
  return row;
}

async function insertStagingRow(runId: number): Promise<void> {
  await db
    .insert(templateListsStaging)
    .values({ syncRunId: runId, sourceListId: runId, title: "測試用暫存列", description: null });
}

async function countStaging(runId: number): Promise<number> {
  const rows = await db
    .select()
    .from(templateListsStaging)
    .where(eq(templateListsStaging.syncRunId, runId));
  return rows.length;
}

async function findRun(id: number) {
  const [row] = await db.select().from(syncRuns).where(eq(syncRuns.id, id));
  return row;
}

describe("pruneStagingSyncRuns", () => {
  it("done 且 finished_at 超過 doneStagingDays：清空 staging，但保留 sync_runs 列", async () => {
    const config = getStagingSyncConfig();
    const now = new Date();
    const finishedAt = new Date(
      now.getTime() - (config.retention.doneStagingDays * DAY_MS + DAY_MS),
    );
    const run = await insertSyncRun({ phase: SYNC_RUN_PHASE.DONE, finishedAt });
    await insertStagingRow(run.id);

    const summary = await pruneStagingSyncRuns(now);

    expect(summary.doneStagingRunsCleaned).toBe(1);
    expect(await countStaging(run.id)).toBe(0);
    expect(await findRun(run.id)).not.toBeUndefined();
  });

  it("done 但 finished_at 未超過 doneStagingDays：不動", async () => {
    const config = getStagingSyncConfig();
    const now = new Date();
    const finishedAt = new Date(now.getTime() - (config.retention.doneStagingDays * DAY_MS) / 2);
    const run = await insertSyncRun({ phase: SYNC_RUN_PHASE.DONE, finishedAt });
    await insertStagingRow(run.id);

    const summary = await pruneStagingSyncRuns(now);

    expect(summary.doneStagingRunsCleaned).toBe(0);
    expect(await countStaging(run.id)).toBe(1);
  });

  it("fetch_failed 且 finished_at 超過 failedStagingDays：清空 staging", async () => {
    const config = getStagingSyncConfig();
    const now = new Date();
    const finishedAt = new Date(
      now.getTime() - (config.retention.failedStagingDays * DAY_MS + DAY_MS),
    );
    const run = await insertSyncRun({ phase: SYNC_RUN_PHASE.FETCH_FAILED, finishedAt });
    await insertStagingRow(run.id);

    const summary = await pruneStagingSyncRuns(now);

    expect(summary.failedStagingRunsCleaned).toBe(1);
    expect(await countStaging(run.id)).toBe(0);
  });

  it("abandoned 且 finished_at 超過 failedStagingDays：清空 staging", async () => {
    const config = getStagingSyncConfig();
    const now = new Date();
    const finishedAt = new Date(
      now.getTime() - (config.retention.failedStagingDays * DAY_MS + DAY_MS),
    );
    const run = await insertSyncRun({
      phase: SYNC_RUN_PHASE.ABANDONED,
      finishedAt,
      abandonedAt: finishedAt,
      abandonedBy: "operator@example.com",
      abandonedReason: "測試用",
    });
    await insertStagingRow(run.id);

    const summary = await pruneStagingSyncRuns(now);

    expect(summary.failedStagingRunsCleaned).toBe(1);
    expect(await countStaging(run.id)).toBe(0);
  });

  it("fetch_failed/abandoned 但 finished_at 未超過 failedStagingDays：不動", async () => {
    const config = getStagingSyncConfig();
    const now = new Date();
    const finishedAt = new Date(now.getTime() - (config.retention.failedStagingDays * DAY_MS) / 2);
    const run = await insertSyncRun({ phase: SYNC_RUN_PHASE.FETCH_FAILED, finishedAt });
    await insertStagingRow(run.id);

    const summary = await pruneStagingSyncRuns(now);

    expect(summary.failedStagingRunsCleaned).toBe(0);
    expect(await countStaging(run.id)).toBe(1);
  });

  it("終態且 finished_at 超過 terminalRunDays：連 sync_runs 列本身都刪除，staging 不留孤兒", async () => {
    const config = getStagingSyncConfig();
    const now = new Date();
    const finishedAt = new Date(
      now.getTime() - (config.retention.terminalRunDays * DAY_MS + DAY_MS),
    );
    const run = await insertSyncRun({ phase: SYNC_RUN_PHASE.DONE, finishedAt });
    await insertStagingRow(run.id);

    const summary = await pruneStagingSyncRuns(now);

    expect(summary.runsDeleted).toBe(1);
    expect(await findRun(run.id)).toBeUndefined();
    expect(await countStaging(run.id)).toBe(0);
  });

  it("終態但 finished_at 未超過 terminalRunDays：sync_runs 列保留", async () => {
    const config = getStagingSyncConfig();
    const now = new Date();
    const finishedAt = new Date(now.getTime() - (config.retention.terminalRunDays * DAY_MS) / 2);
    const run = await insertSyncRun({ phase: SYNC_RUN_PHASE.DONE, finishedAt });

    const summary = await pruneStagingSyncRuns(now);

    expect(summary.runsDeleted).toBe(0);
    expect(await findRun(run.id)).not.toBeUndefined();
  });

  it.each([SYNC_RUN_PHASE.FETCHING, SYNC_RUN_PHASE.STAGED, SYNC_RUN_PHASE.SWAPPING])(
    "永不碰 active phase（%s）：即使 finished_at 被誤植成很舊的時間，staging／sync_runs 都不受影響",
    async (activePhase) => {
      const now = new Date();
      // 刻意植入不合理的舊 finished_at（active run 正常情況下 finished_at 恆為
      // null），驗證清理邏輯是先用 phase 過濾掉，而不是單純依賴 finished_at 為
      // null 的副作用。
      const veryOld = new Date(now.getTime() - 365 * DAY_MS);
      const run = await insertSyncRun({
        phase: activePhase,
        ownerToken: "11111111-1111-1111-1111-111111111111",
        finishedAt: veryOld,
      });
      await insertStagingRow(run.id);

      const summary = await pruneStagingSyncRuns(now);

      expect(summary.doneStagingRunsCleaned).toBe(0);
      expect(summary.failedStagingRunsCleaned).toBe(0);
      expect(summary.runsDeleted).toBe(0);
      expect(await countStaging(run.id)).toBe(1);
      expect(await findRun(run.id)).not.toBeUndefined();
    },
  );

  it("重跑冪等：連續呼叫兩次，第二次不報錯，且最終狀態與第一次呼叫後一致", async () => {
    const config = getStagingSyncConfig();
    const now = new Date();
    const terminalFinishedAt = new Date(
      now.getTime() - (config.retention.terminalRunDays * DAY_MS + DAY_MS),
    );
    const doneFinishedAt = new Date(
      now.getTime() - (config.retention.doneStagingDays * DAY_MS + DAY_MS),
    );

    const terminalRun = await insertSyncRun({
      phase: SYNC_RUN_PHASE.DONE,
      finishedAt: terminalFinishedAt,
    });
    await insertStagingRow(terminalRun.id);
    const doneRun = await insertSyncRun({ phase: SYNC_RUN_PHASE.DONE, finishedAt: doneFinishedAt });
    await insertStagingRow(doneRun.id);

    const first = await pruneStagingSyncRuns(now);
    expect(first.runsDeleted).toBe(1);
    // terminalRun／doneRun 皆超過 doneStagingDays（terminalRunDays 比 doneStagingDays
    // 長，超過終態門檻的 run 必然也超過 done 門檻），兩者都會被算進 done 清理數。
    expect(first.doneStagingRunsCleaned).toBe(2);

    // 第二次呼叫：terminalRun 那一列 sync_runs 已被刪除，不會再出現在任何查詢裡；
    // doneRun 仍是「done 且超過 doneStagingDays」，本來就會持續符合這條規則直到它
    // 自己也超過 terminalRunDays 被刪除——這裡重跑會再清一次（staging 早已是空的，
    // 清一次空表是安全的 no-op），不報錯、不產生任何負面影響，即是冪等的意涵。
    const second = await pruneStagingSyncRuns(now);
    expect(second.runsDeleted).toBe(0);
    expect(second.doneStagingRunsCleaned).toBe(1);
    expect(second.failedStagingRunsCleaned).toBe(0);

    // 兩次呼叫後的最終資料狀態應該完全一致（這才是「冪等」真正要驗證的事）
    expect(await findRun(terminalRun.id)).toBeUndefined();
    expect(await findRun(doneRun.id)).not.toBeUndefined();
    expect(await countStaging(doneRun.id)).toBe(0);
  });
});
