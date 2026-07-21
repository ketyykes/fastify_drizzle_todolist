import { randomUUID } from "node:crypto";

import {
  db,
  syncRuns,
  templateItemTags,
  templateItemTagsStaging,
  templateItems,
  templateItemsStaging,
  templateLists,
  templateListsStaging,
} from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { SYNC_RUN_PHASE, SYNC_TYPE_TEMPLATE_CATALOG } from "./constants";
import { FenceLostError } from "./errors";
import type { SyncRunFence } from "./fence";
import { swap } from "./merger";
import { claimForSwap, markStaged, recoverActiveRun, startFetching } from "./run-manager";
import { resetDb } from "../test/helpers";

beforeEach(async () => {
  await resetDb();
});

/** 建立一個 phase='staged' 的 run，回傳其 fence（供測試直接呼叫 swap()）。 */
async function createStagedFence(): Promise<SyncRunFence> {
  const fetchingFence = await startFetching(SYNC_TYPE_TEMPLATE_CATALOG, randomUUID(), 1);
  return markStaged(fetchingFence, {
    lastOffset: 0,
    pageCount: 1,
    sourceCount: 0,
    stagedCounts: { lists: 0, items: 0, tags: 0 },
    peakMemoryBytes: 0,
    fetchSeconds: 0,
  });
}

/** 三張目標表現況快照（依 id 排序），供 rollback 前後逐列比對。 */
async function snapshotAllTargets() {
  return {
    lists: await db.select().from(templateLists).orderBy(templateLists.id),
    items: await db.select().from(templateItems).orderBy(templateItems.id),
    tags: await db.select().from(templateItemTags).orderBy(templateItemTags.id),
  };
}

/** 某個 run 在三張 staging 表尚存的列數總和。 */
async function countStagingRows(runId: number): Promise<number> {
  const lists = await db
    .select()
    .from(templateListsStaging)
    .where(eq(templateListsStaging.syncRunId, runId));
  const items = await db
    .select()
    .from(templateItemsStaging)
    .where(eq(templateItemsStaging.syncRunId, runId));
  const tags = await db
    .select()
    .from(templateItemTagsStaging)
    .where(eq(templateItemTagsStaging.syncRunId, runId));
  return lists.length + items.length + tags.length;
}

/** 每張目標表各塞一筆「上一輪殘留」的舊資料，供 mark 階段有東西可標記。 */
async function seedOldTargetRows(): Promise<void> {
  await db
    .insert(templateLists)
    .values({ sourceListId: 1, title: "舊清單", description: "舊描述", isActive: true });
  await db.insert(templateItems).values({
    sourceItemId: 10,
    sourceListId: 1,
    title: "舊項目",
    priority: 1,
    position: 1,
    isActive: true,
  });
  await db.insert(templateItemTags).values({ sourceItemId: 10, tag: "舊標籤", isActive: true });
}

/** 每張 staging 表各塞一筆本輪新資料，供 merge 階段有東西可合併。 */
async function seedStagingRows(runId: number): Promise<void> {
  await db
    .insert(templateListsStaging)
    .values({ syncRunId: runId, sourceListId: 1, title: "新清單", description: "新描述" });
  await db.insert(templateItemsStaging).values({
    syncRunId: runId,
    sourceItemId: 10,
    sourceListId: 1,
    title: "新項目",
    priority: 2,
  });
  await db
    .insert(templateItemTagsStaging)
    .values({ syncRunId: runId, sourceItemId: 10, tag: "新標籤" });
}

describe("swap - mark-and-sweep 語意", () => {
  it("template_lists：staging 沒有的舊列變 inactive 但仍存在；有的復活且 payload 被覆蓋", async () => {
    const stagedFence = await createStagedFence();
    await db.insert(templateLists).values([
      { sourceListId: 1, title: "舊清單1", description: "舊描述1", isActive: true },
      { sourceListId: 2, title: "舊清單2", description: "舊描述2", isActive: true },
    ]);
    await db.insert(templateListsStaging).values({
      syncRunId: stagedFence.runId,
      sourceListId: 1,
      title: "新清單1",
      description: "新描述1",
    });

    await swap(stagedFence);

    const rows = await db.select().from(templateLists).orderBy(templateLists.sourceListId);
    expect(rows).toHaveLength(2);
    const list1 = rows.find((row) => row.sourceListId === 1);
    const list2 = rows.find((row) => row.sourceListId === 2);
    expect(list1?.isActive).toBe(true);
    expect(list1?.title).toBe("新清單1");
    expect(list1?.description).toBe("新描述1");
    // 沒被 staging 命中的舊列：is_active 變 false，但仍然存在（不是刪除），payload 維持舊值
    expect(list2?.isActive).toBe(false);
    expect(list2?.title).toBe("舊清單2");
    expect(list2?.description).toBe("舊描述2");
  });

  it("template_items：既有業務鍵更新、全新業務鍵直接 insert", async () => {
    const stagedFence = await createStagedFence();
    await db.insert(templateItems).values({
      sourceItemId: 10,
      sourceListId: 1,
      title: "舊項目",
      priority: 1,
      position: 1,
      isActive: true,
    });
    await db.insert(templateItemsStaging).values([
      {
        syncRunId: stagedFence.runId,
        sourceItemId: 10,
        sourceListId: 1,
        title: "新項目",
        priority: 9,
      },
      {
        syncRunId: stagedFence.runId,
        sourceItemId: 20,
        sourceListId: 1,
        title: "全新項目",
        priority: 5,
      },
    ]);

    await swap(stagedFence);

    const rows = await db.select().from(templateItems).orderBy(templateItems.sourceItemId);
    expect(rows).toHaveLength(2);
    const item10 = rows.find((row) => row.sourceItemId === 10);
    const item20 = rows.find((row) => row.sourceItemId === 20);
    expect(item10?.isActive).toBe(true);
    expect(item10?.title).toBe("新項目");
    expect(item10?.priority).toBe(9);
    expect(item20?.isActive).toBe(true);
    expect(item20?.title).toBe("全新項目");
  });

  it("template_item_tags：複合鍵 merge 正確（沒有額外 payload，只設 is_active）", async () => {
    const stagedFence = await createStagedFence();
    await db.insert(templateItemTags).values([
      { sourceItemId: 10, tag: "A", isActive: true },
      { sourceItemId: 10, tag: "B", isActive: true },
    ]);
    await db.insert(templateItemTagsStaging).values({
      syncRunId: stagedFence.runId,
      sourceItemId: 10,
      tag: "A",
    });

    await swap(stagedFence);

    const rows = await db.select().from(templateItemTags).orderBy(templateItemTags.tag);
    const tagA = rows.find((row) => row.tag === "A");
    const tagB = rows.find((row) => row.tag === "B");
    expect(tagA?.isActive).toBe(true);
    expect(tagB?.isActive).toBe(false);
  });

  it("swap 成功後：run 轉 done、swapSeconds 有值、owner_token 清 null，staging 已清空", async () => {
    const stagedFence = await createStagedFence();
    await db
      .insert(templateListsStaging)
      .values({ syncRunId: stagedFence.runId, sourceListId: 1, title: "A", description: null });

    const summary = await swap(stagedFence);

    expect(summary.runId).toBe(stagedFence.runId);
    expect(summary.swapSeconds).toBeGreaterThanOrEqual(0);

    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, stagedFence.runId));
    expect(run?.phase).toBe(SYNC_RUN_PHASE.DONE);
    expect(run?.resultCode).toBe("success");
    expect(run?.swapSeconds).not.toBeNull();
    expect(run?.ownerToken).toBeNull();

    expect(await countStagingRows(stagedFence.runId)).toBe(0);
  });
});

describe("swap - position 重算", () => {
  it("多清單各自從 1 開始編號；priority 同分時以 source_item_id 決勝；singleton 也是 1；inactive 不參與", async () => {
    const stagedFence = await createStagedFence();

    // 上一輪殘留、本輪 staging 沒有它 -> mark 後 inactive，position 應維持舊值不被重算
    await db.insert(templateItems).values({
      sourceItemId: 500_000,
      sourceListId: 9_999,
      title: "舊項目（本輪應變 inactive）",
      priority: 1,
      position: 42,
      isActive: true,
    });

    await db.insert(templateItemsStaging).values([
      // 清單 1000：兩筆同分（priority=5）+ 一筆較低分（priority=3）
      {
        syncRunId: stagedFence.runId,
        sourceItemId: 100_001,
        sourceListId: 1000,
        title: "A",
        priority: 5,
      },
      {
        syncRunId: stagedFence.runId,
        sourceItemId: 100_002,
        sourceListId: 1000,
        title: "B",
        priority: 5,
      },
      {
        syncRunId: stagedFence.runId,
        sourceItemId: 100_003,
        sourceListId: 1000,
        title: "C",
        priority: 3,
      },
      // 清單 2000：singleton
      {
        syncRunId: stagedFence.runId,
        sourceItemId: 200_001,
        sourceListId: 2000,
        title: "Solo",
        priority: 0,
      },
    ]);

    await swap(stagedFence);

    const rows = await db.select().from(templateItems);
    const byItemId = new Map(rows.map((row) => [row.sourceItemId, row]));

    // 同分（priority=5）時，source_item_id 較小者排前面
    expect(byItemId.get(100_001)?.position).toBe(1);
    expect(byItemId.get(100_002)?.position).toBe(2);
    expect(byItemId.get(100_003)?.position).toBe(3);

    // 另一個清單的 partition 各自獨立從 1 開始，不受清單 1000 影響
    expect(byItemId.get(200_001)?.position).toBe(1);

    // inactive（本輪沒被 staging 命中）的舊列不參與重算，position 維持舊值
    const orphan = byItemId.get(500_000);
    expect(orphan?.isActive).toBe(false);
    expect(orphan?.position).toBe(42);
  });
});

describe("swap - fence 保護", () => {
  it("stale fence（已被搶先 claim）：swap 直接拒絕，不動任何資料", async () => {
    const stagedFence = await createStagedFence();
    await seedOldTargetRows();
    await seedStagingRows(stagedFence.runId);
    const beforeSnapshot = await snapshotAllTargets();

    // 模擬「已經被搶先 claim」：真的呼叫一次 claimForSwap，讓 DB 真實狀態變成
    // swapping、owner/lease 換新——手上這份 stagedFence 就變成 stale 憑證。
    await claimForSwap(stagedFence);

    await expect(swap(stagedFence)).rejects.toThrow(FenceLostError);

    expect(await snapshotAllTargets()).toEqual(beforeSnapshot);

    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, stagedFence.runId));
    // 真正持有新 fence 的那一方仍在 swapping，不該被這次失敗的嘗試動到
    expect(run?.phase).toBe(SYNC_RUN_PHASE.SWAPPING);
  });
});

describe("swap - failureInjector（模擬 merge 交易中途崩潰）", () => {
  it.each([
    "after_mark:template_lists",
    "after_mark:template_items",
    "after_mark:template_item_tags",
    "after_merge:template_lists",
    "after_merge:template_items",
    "after_merge:template_item_tags",
    "after_positions",
  ])(
    "在 %s 注入拋錯：目標表完全回滾、run 退回 staged、staging 完整保留，重播一次即成功",
    async (hook) => {
      const stagedFence = await createStagedFence();
      await seedOldTargetRows();
      await seedStagingRows(stagedFence.runId);

      const beforeSnapshot = await snapshotAllTargets();
      const stagingCountBefore = await countStagingRows(stagedFence.runId);

      await expect(
        swap(stagedFence, {
          failureInjector: (calledHook) => {
            if (calledHook === hook) {
              throw new Error(`注入測試失敗：${calledHook}`);
            }
          },
        }),
      ).rejects.toThrow(`注入測試失敗：${hook}`);

      // 目標表完全回滾，與 swap 前逐列相同
      expect(await snapshotAllTargets()).toEqual(beforeSnapshot);

      const [runAfterFailure] = await db
        .select()
        .from(syncRuns)
        .where(eq(syncRuns.id, stagedFence.runId));
      expect(runAfterFailure?.phase).toBe(SYNC_RUN_PHASE.STAGED);
      expect(runAfterFailure?.resultCode).toBe("swap_failed");

      // staging 完整保留，不受影響
      expect(await countStagingRows(stagedFence.runId)).toBe(stagingCountBefore);

      // 重播：不必重新 fetch，直接用 recoverActiveRun 拿目前有效的 fence 再 swap 一次
      const recovery = await recoverActiveRun(SYNC_TYPE_TEMPLATE_CATALOG);
      expect(recovery.kind).toBe("staged");
      if (recovery.kind !== "staged") {
        throw new Error("測試前提錯誤：recoverActiveRun 應回傳 staged");
      }

      const summary = await swap(recovery.fence);
      expect(summary.runId).toBe(stagedFence.runId);

      const [finishedRun] = await db
        .select()
        .from(syncRuns)
        .where(eq(syncRuns.id, stagedFence.runId));
      expect(finishedRun?.phase).toBe(SYNC_RUN_PHASE.DONE);
      expect(finishedRun?.resultCode).toBe("success");

      // done 後 staging 已清空
      expect(await countStagingRows(stagedFence.runId)).toBe(0);
    },
  );
});
