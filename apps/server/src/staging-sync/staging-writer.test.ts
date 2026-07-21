import { randomUUID } from "node:crypto";

import {
  db,
  syncRuns,
  templateItemTagsStaging,
  templateItemsStaging,
  templateListsStaging,
} from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { STAGING_CHUNK_SIZE, SYNC_RUN_PHASE, SYNC_TYPE_TEMPLATE_CATALOG } from "./constants";
import { FenceLostError } from "./errors";
import type { SyncRunFence } from "./fence";
import { markNoData, markStaged, startFetching } from "./run-manager";
import { resetDb } from "../test/helpers";
import { writePage, type WritePageCheckpoint } from "./staging-writer";
import type { PageBuffers } from "./types";

beforeEach(async () => {
  await resetDb();
});

function emptyBuffers(): PageBuffers {
  return { lists: [], items: [], tags: [] };
}

function checkpoint(overrides: Partial<WritePageCheckpoint> = {}): WritePageCheckpoint {
  return {
    lastOffset: 0,
    pageCount: 1,
    sourceCount: 0,
    heartbeatAt: new Date(),
    peakMemoryBytes: 1_000,
    ...overrides,
  };
}

async function newFence(syncType = SYNC_TYPE_TEMPLATE_CATALOG): Promise<SyncRunFence> {
  return startFetching(syncType, randomUUID(), 1);
}

describe("writePage", () => {
  it("fence 正常時：寫入 staging 三表並推進 checkpoint（絕對值，不累加）", async () => {
    const fence = await newFence();
    const buffers: PageBuffers = {
      lists: [
        { sourcePage: 0, sourceRow: 0, sourceListId: 1000, title: "清單A", description: "描述A" },
      ],
      items: [
        {
          sourcePage: 0,
          sourceRow: 0,
          sourceItemId: 100_000,
          sourceListId: 1000,
          title: "項目A",
          priority: 5,
        },
      ],
      tags: [{ sourcePage: 0, sourceRow: 0, sourceItemId: 100_000, tag: "tagA" }],
    };

    await writePage(fence, checkpoint({ lastOffset: 50, pageCount: 1, sourceCount: 1 }), buffers);

    const [listRow] = await db
      .select()
      .from(templateListsStaging)
      .where(eq(templateListsStaging.sourceListId, 1000));
    expect(listRow?.syncRunId).toBe(fence.runId);
    expect(listRow?.title).toBe("清單A");
    expect(listRow?.description).toBe("描述A");

    const [itemRow] = await db
      .select()
      .from(templateItemsStaging)
      .where(eq(templateItemsStaging.sourceItemId, 100_000));
    expect(itemRow?.priority).toBe(5);
    expect(itemRow?.sourceListId).toBe(1000);

    const [tagRow] = await db
      .select()
      .from(templateItemTagsStaging)
      .where(eq(templateItemTagsStaging.sourceItemId, 100_000));
    expect(tagRow?.tag).toBe("tagA");

    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, fence.runId));
    expect(run?.lastOffset).toBe(50);
    expect(run?.pageCount).toBe(1);
    expect(run?.sourceCount).toBe(1);
    expect(run?.peakMemoryBytes).toBe(1_000);
    expect(run?.heartbeatAt).not.toBeNull();
    // 未進 markStaged，phase 仍是 fetching；owner/lease 不因 writePage 而變動
    expect(run?.phase).toBe(SYNC_RUN_PHASE.FETCHING);
    expect(run?.ownerToken).toBe(fence.ownerToken);
    expect(run?.leaseVersion).toBe(fence.leaseVersion);
  });

  it("空 buffers（三表皆空）仍完整走過 fence 驗證與 checkpoint 更新", async () => {
    const fence = await newFence();

    await writePage(
      fence,
      checkpoint({ lastOffset: 10, pageCount: 1, sourceCount: 0 }),
      emptyBuffers(),
    );

    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, fence.runId));
    expect(run?.lastOffset).toBe(10);
    expect(run?.pageCount).toBe(1);
    expect(run?.heartbeatAt).not.toBeNull();
  });

  const buffersForStaleFenceCase: PageBuffers = {
    lists: [{ sourcePage: 0, sourceRow: 0, sourceListId: 1000, title: "清單A", description: null }],
    items: [],
    tags: [],
  };

  it.each([
    [
      "ownerToken 不符",
      (fence: SyncRunFence): SyncRunFence => ({ ...fence, ownerToken: randomUUID() }),
    ],
    [
      "leaseVersion 不符",
      (fence: SyncRunFence): SyncRunFence => ({ ...fence, leaseVersion: fence.leaseVersion + 1 }),
    ],
  ])(
    "stale fence（%s）拒絕寫入且拋 FenceLostError，staging 零寫入（交易回滾）",
    async (_label, mutate) => {
      const fence = await newFence();
      const staleFence = mutate(fence);

      await expect(writePage(staleFence, checkpoint(), buffersForStaleFenceCase)).rejects.toThrow(
        FenceLostError,
      );

      const listRows = await db.select().from(templateListsStaging);
      expect(listRows).toHaveLength(0);

      const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, fence.runId));
      expect(run?.lastOffset).toBeNull();
      expect(run?.phase).toBe(SYNC_RUN_PHASE.FETCHING);
    },
  );

  it("stale fence（真實 phase 已不是 fetching）拒絕寫入且拋 FenceLostError，staging 零寫入", async () => {
    const fence = await newFence();
    // 真正把這個 run 轉成 staged（owner_token/lease_version 保持不變，
    // 才能模擬「呼叫端還拿著上一輪 fence 想繼續寫 Phase 1」的情境）
    await markStaged(fence, {
      lastOffset: 0,
      pageCount: 0,
      sourceCount: 0,
      stagedCounts: { lists: 0, items: 0, tags: 0 },
      peakMemoryBytes: 0,
      fetchSeconds: 0,
    });

    await expect(writePage(fence, checkpoint(), buffersForStaleFenceCase)).rejects.toThrow(
      FenceLostError,
    );

    const listRows = await db.select().from(templateListsStaging);
    expect(listRows).toHaveLength(0);

    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, fence.runId));
    expect(run?.phase).toBe(SYNC_RUN_PHASE.STAGED);
  });

  it("同一 run 兩次 writePage 對同一業務鍵 upsert：last-row-wins（模擬 overlap 分頁重疊）", async () => {
    const fence = await newFence();
    const firstBuffers: PageBuffers = {
      lists: [
        { sourcePage: 0, sourceRow: 0, sourceListId: 1000, title: "舊標題", description: "舊描述" },
      ],
      items: [],
      tags: [],
    };
    const secondBuffers: PageBuffers = {
      lists: [
        { sourcePage: 1, sourceRow: 0, sourceListId: 1000, title: "新標題", description: "新描述" },
      ],
      items: [],
      tags: [],
    };

    await writePage(fence, checkpoint({ lastOffset: 0, pageCount: 1 }), firstBuffers);
    await writePage(fence, checkpoint({ lastOffset: 50, pageCount: 2 }), secondBuffers);

    const listRows = await db
      .select()
      .from(templateListsStaging)
      .where(eq(templateListsStaging.sourceListId, 1000));
    expect(listRows).toHaveLength(1);
    expect(listRows[0]?.title).toBe("新標題");
    expect(listRows[0]?.description).toBe("新描述");
    expect(listRows[0]?.sourcePage).toBe(1);
  });

  it("兩個 run 對同一業務鍵互不干擾（各自保留獨立一列）", async () => {
    const fenceA = await newFence();
    await writePage(fenceA, checkpoint(), {
      lists: [
        {
          sourcePage: 0,
          sourceRow: 0,
          sourceListId: 1000,
          title: "run A 的標題",
          description: null,
        },
      ],
      items: [],
      tags: [],
    });
    // 讓 run A 離開 fetching（釋放 active-run 名額），run B 才能開始
    await markNoData(fenceA);

    const fenceB = await newFence();
    await writePage(fenceB, checkpoint(), {
      lists: [
        {
          sourcePage: 0,
          sourceRow: 0,
          sourceListId: 1000,
          title: "run B 的標題",
          description: null,
        },
      ],
      items: [],
      tags: [],
    });

    const rows = await db
      .select()
      .from(templateListsStaging)
      .where(eq(templateListsStaging.sourceListId, 1000));
    expect(rows).toHaveLength(2);
    const byRunId = new Map(rows.map((row) => [row.syncRunId, row]));
    expect(byRunId.get(fenceA.runId)?.title).toBe("run A 的標題");
    expect(byRunId.get(fenceB.runId)?.title).toBe("run B 的標題");
  });

  it(`超過 STAGING_CHUNK_SIZE（${STAGING_CHUNK_SIZE}）列時仍分塊全數寫入`, async () => {
    const fence = await newFence();
    const total = STAGING_CHUNK_SIZE + 250;
    const items = Array.from({ length: total }, (_, index) => ({
      sourcePage: 0,
      sourceRow: index,
      sourceItemId: 200_000 + index,
      sourceListId: 1000,
      title: `項目${index}`,
      priority: index % 10,
    }));

    await writePage(fence, checkpoint({ sourceCount: total }), { lists: [], items, tags: [] });

    const rows = await db.select().from(templateItemsStaging);
    expect(rows).toHaveLength(total);
  });
});
