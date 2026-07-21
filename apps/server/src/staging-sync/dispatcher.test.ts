// dispatcher 整合測試：涵蓋設計簡報 §12「dispatcher」列——全流程（Phase 1 +
// Phase 2）串接起來後的端對端行為。比照 page-fetcher.test.ts／merger.test.ts
// 的做法：ephemeral port 起一個測試 app 提供 mock-source，setStagingSyncConfigForTest
// 覆寫設定；resetDb 清資料表、POST /mock-source/reset 清 mock 狀態。
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import {
  db,
  syncRuns,
  templateItemTags,
  templateItems,
  templateItemTagsStaging,
  templateItemsStaging,
  templateLists,
  templateListsStaging,
} from "@fastify_drizzle_todolist/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getStagingSyncConfig,
  setStagingSyncConfigForTest,
  type StagingSyncConfig,
} from "./config";
import { RESULT_CODE, SYNC_RUN_PHASE, SYNC_TYPE_TEMPLATE_CATALOG } from "./constants";
import { runTemplateCatalogSync } from "./dispatcher";
import { LockConflictError } from "./errors";
import type { SourceListRow } from "./types";
import { createTestApp, resetDb } from "../test/helpers";

const app = createTestApp();

let baseSourceUrl: string;

beforeAll(async () => {
  await app.listen({ port: 0 });
  const address = app.server.address() as AddressInfo;
  baseSourceUrl = `http://127.0.0.1:${address.port}/mock-source/template-catalog`;
  setStagingSyncConfigForTest({
    sourceUrl: baseSourceUrl,
    pageSize: 3,
    fetchRetries: 3,
    fetchRetryDelayMs: 1000,
    fetchTimeoutMs: 3000,
    retention: { doneStagingDays: 1, failedStagingDays: 7, terminalRunDays: 90 },
  });
});

afterAll(async () => {
  setStagingSyncConfigForTest(null);
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  await app.inject({ method: "POST", url: "/mock-source/reset" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// 測試專用假 sleep：不論成功／失敗流程都注入，讓 page-fetcher 內建重試的
// 等待時間歸零，測試不因為 fetchRetryDelayMs 而變慢。
const fakeSleep = async (): Promise<void> => {};

/** 以目前 setStagingSyncConfigForTest 的設定為底，套用逐測試的覆寫值。 */
function buildConfig(overrides: Partial<StagingSyncConfig> = {}): StagingSyncConfig {
  return { ...getStagingSyncConfig(), ...overrides };
}

async function setMockSourceMode(mode: string): Promise<void> {
  await app.inject({ method: "PUT", url: "/mock-source/mode", payload: { mode } });
}

/** 包一層可計數的 fetch spy：呼叫次數可斷言，但行為原樣透傳給真實 fetch。 */
function spyOnFetch() {
  const originalFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation((...args) => originalFetch(...args));
}

/**
 * 直接向 mock-source 要「一整頁」拿到全部資料，做為驗證用的基準真相
 * （ground truth）。mock-source 資料集是決定性生成的純函式，不論用什麼分頁
 * 參數取得，內容都與 orchestrator 實際逐頁抓到的完全一致。
 */
async function fetchGroundTruth(total: number): Promise<SourceListRow[]> {
  const url = new URL(baseSourceUrl);
  url.searchParams.set("limit", String(total));
  url.searchParams.set("offset", "0");
  url.searchParams.set("total", String(total));
  const response = await fetch(url);
  const body = (await response.json()) as { rows: SourceListRow[]; count: number };
  return body.rows;
}

function computeExpectedCounts(rows: SourceListRow[]) {
  let items = 0;
  let tags = 0;
  for (const row of rows) {
    items += row.items.length;
    for (const item of row.items) {
      tags += item.tags.length;
    }
  }
  return { lists: rows.length, items, tags };
}

/** 依設計簡報 §7 的規則（partition 依 source_list_id、priority DESC、source_item_id ASC）算出每個項目「應有」的 position。 */
function computeExpectedPositions(rows: SourceListRow[]): Map<number, number> {
  const positions = new Map<number, number>();
  for (const row of rows) {
    const sorted = [...row.items].sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.sourceItemId - b.sourceItemId;
    });
    sorted.forEach((item, index) => {
      positions.set(item.sourceItemId, index + 1);
    });
  }
  return positions;
}

async function countStagingRowsTotal(): Promise<number> {
  const lists = await db.select().from(templateListsStaging);
  const items = await db.select().from(templateItemsStaging);
  const tags = await db.select().from(templateItemTagsStaging);
  return lists.length + items.length + tags.length;
}

describe("runTemplateCatalogSync - happy path", () => {
  it("全流程成功：摘要 success、run 收尾 done、三張目標表列數/is_active/position 皆正確、staging 已清空", async () => {
    const total = 6;
    setStagingSyncConfigForTest(buildConfig({ sourceUrl: `${baseSourceUrl}?total=${total}` }));
    const groundTruth = await fetchGroundTruth(total);
    const expectedCounts = computeExpectedCounts(groundTruth);
    const expectedPositions = computeExpectedPositions(groundTruth);

    const summary = await runTemplateCatalogSync({ sleep: fakeSleep });

    expect(summary.resultCode).toBe(RESULT_CODE.SUCCESS);
    expect(summary.replayed).toBe(false);
    expect(summary.pageCount).toBeGreaterThan(0);
    expect(summary.sourceCount).toBe(expectedCounts.lists);
    expect(summary.stagedCounts).toEqual(expectedCounts);
    expect(summary.fetchSeconds).not.toBeNull();
    expect(summary.swapSeconds).not.toBeNull();

    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, summary.runId));
    expect(run?.phase).toBe(SYNC_RUN_PHASE.DONE);
    expect(run?.resultCode).toBe(RESULT_CODE.SUCCESS);
    expect(run?.ownerToken).toBeNull();

    const allRuns = await db.select().from(syncRuns);
    expect(allRuns).toHaveLength(1);

    const listRows = await db.select().from(templateLists);
    const itemRows = await db.select().from(templateItems);
    const tagRows = await db.select().from(templateItemTags);

    expect(listRows).toHaveLength(expectedCounts.lists);
    expect(listRows.every((row) => row.isActive)).toBe(true);
    expect(itemRows).toHaveLength(expectedCounts.items);
    expect(itemRows.every((row) => row.isActive)).toBe(true);
    expect(tagRows).toHaveLength(expectedCounts.tags);
    expect(tagRows.every((row) => row.isActive)).toBe(true);

    for (const item of itemRows) {
      expect(item.position).toBe(expectedPositions.get(item.sourceItemId));
    }

    expect(await countStagingRowsTotal()).toBe(0);
  });

  it("連跑兩次：第二次仍成功（全量刷新冪等），目標表列數不變、無殘留重複", async () => {
    const total = 6;
    setStagingSyncConfigForTest(buildConfig({ sourceUrl: `${baseSourceUrl}?total=${total}` }));
    const groundTruth = await fetchGroundTruth(total);
    const expectedCounts = computeExpectedCounts(groundTruth);

    const first = await runTemplateCatalogSync({ sleep: fakeSleep });
    const second = await runTemplateCatalogSync({ sleep: fakeSleep });

    expect(first.resultCode).toBe(RESULT_CODE.SUCCESS);
    expect(second.resultCode).toBe(RESULT_CODE.SUCCESS);
    expect(second.runId).not.toBe(first.runId);

    const listRows = await db.select().from(templateLists);
    const itemRows = await db.select().from(templateItems);
    const tagRows = await db.select().from(templateItemTags);

    // 全量刷新冪等：同一批來源資料跑兩次，目標表列數與第一次完全相同，
    // 不會因為第二輪 merge 而重複膨脹。
    expect(listRows).toHaveLength(expectedCounts.lists);
    expect(itemRows).toHaveLength(expectedCounts.items);
    expect(tagRows).toHaveLength(expectedCounts.tags);
    expect(listRows.every((row) => row.isActive)).toBe(true);

    const allRuns = await db.select().from(syncRuns);
    expect(allRuns).toHaveLength(2);
    expect(allRuns.every((row) => row.phase === SYNC_RUN_PHASE.DONE)).toBe(true);
  });
});

describe("runTemplateCatalogSync - no_data 契約", () => {
  it("mode=empty：摘要 no_data、run 收尾 done/no_data、目標表零變更", async () => {
    await setMockSourceMode("empty");

    const summary = await runTemplateCatalogSync({ sleep: fakeSleep });

    expect(summary.resultCode).toBe(RESULT_CODE.NO_DATA);
    expect(summary.replayed).toBe(false);

    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, summary.runId));
    expect(run?.phase).toBe(SYNC_RUN_PHASE.DONE);
    expect(run?.resultCode).toBe(RESULT_CODE.NO_DATA);

    expect(await db.select().from(templateLists)).toHaveLength(0);
    expect(await db.select().from(templateItems)).toHaveLength(0);
    expect(await db.select().from(templateItemTags)).toHaveLength(0);
    expect(await countStagingRowsTotal()).toBe(0);
  });
});

describe("runTemplateCatalogSync - fetch 失敗", () => {
  it("mode=fail：拋出錯誤、run 收尾 fetch_failed、目標表零變更", async () => {
    await setMockSourceMode("fail");

    await expect(runTemplateCatalogSync({ sleep: fakeSleep })).rejects.toThrow();

    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.syncType, SYNC_TYPE_TEMPLATE_CATALOG));
    expect(run?.phase).toBe(SYNC_RUN_PHASE.FETCH_FAILED);
    expect(run?.resultCode).toBe(RESULT_CODE.FETCH_FAILED);
    expect(run?.lastErrorPhase).toBe("fetch");
    expect(run?.ownerToken).toBeNull();

    expect(await db.select().from(templateLists)).toHaveLength(0);
    expect(await db.select().from(templateItems)).toHaveLength(0);
    expect(await db.select().from(templateItemTags)).toHaveLength(0);
  });
});

describe("runTemplateCatalogSync - swap 失敗重播免重抓", () => {
  it("swap 失敗後 run 回 staged；下次 dispatch 直接重播成功，且完全不發 HTTP", async () => {
    const total = 6;
    setStagingSyncConfigForTest(buildConfig({ sourceUrl: `${baseSourceUrl}?total=${total}` }));

    // 基線：先正常跑一次
    const baseline = await runTemplateCatalogSync({ sleep: fakeSleep });
    expect(baseline.resultCode).toBe(RESULT_CODE.SUCCESS);

    // 第二輪：正常 fetch，但讓 swap 交易中途注入失敗
    await expect(
      runTemplateCatalogSync({
        sleep: fakeSleep,
        swapFailureInjector: (hook) => {
          if (hook === "after_merge:template_lists") {
            throw new Error("模擬 swap 交易中途崩潰");
          }
        },
      }),
    ).rejects.toThrow("模擬 swap 交易中途崩潰");

    const [stagedRun] = await db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.phase, SYNC_RUN_PHASE.STAGED));
    expect(stagedRun).toBeDefined();
    if (!stagedRun) {
      throw new Error("測試前提錯誤：應該有一列 staged run");
    }

    // 切到 fail 模式：任何 HTTP 呼叫都會失敗，用來證明「重播不重新抓取」
    await setMockSourceMode("fail");
    const fetchSpy = spyOnFetch();

    const replayed = await runTemplateCatalogSync({ sleep: fakeSleep });

    expect(replayed.resultCode).toBe(RESULT_CODE.SUCCESS);
    expect(replayed.replayed).toBe(true);
    expect(replayed.runId).toBe(stagedRun.id);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("runTemplateCatalogSync - 併發", () => {
  it("兩個併發 dispatch 只有一個成功，另一個因鎖忙碌被拒絕", async () => {
    setStagingSyncConfigForTest(buildConfig({ sourceUrl: `${baseSourceUrl}?total=6` }));

    const results = await Promise.allSettled([
      runTemplateCatalogSync({ sleep: fakeSleep }),
      runTemplateCatalogSync({ sleep: fakeSleep }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof runTemplateCatalogSync>>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(LockConflictError);
    expect(fulfilled[0]?.value.resultCode).toBe(RESULT_CODE.SUCCESS);
  });
});

describe("runTemplateCatalogSync - 殘留孤兒 run", () => {
  it("殘留 phase=fetching 的孤兒 run：dispatch 判死該列為 fetch_failed，並開新的一輪成功完成", async () => {
    setStagingSyncConfigForTest(buildConfig({ sourceUrl: `${baseSourceUrl}?total=6` }));

    const [orphan] = await db
      .insert(syncRuns)
      .values({
        syncType: SYNC_TYPE_TEMPLATE_CATALOG,
        phase: SYNC_RUN_PHASE.FETCHING,
        ownerToken: randomUUID(),
        leaseVersion: 1,
        lockBackendPid: 999_999,
      })
      .returning();
    if (!orphan) {
      throw new Error("測試前提錯誤：orphan sync_runs 建立失敗");
    }

    const summary = await runTemplateCatalogSync({ sleep: fakeSleep });

    expect(summary.resultCode).toBe(RESULT_CODE.SUCCESS);
    expect(summary.runId).not.toBe(orphan.id);

    const [orphanAfter] = await db.select().from(syncRuns).where(eq(syncRuns.id, orphan.id));
    expect(orphanAfter?.phase).toBe(SYNC_RUN_PHASE.FETCH_FAILED);
    expect(orphanAfter?.resultCode).toBe(RESULT_CODE.FETCH_FAILED);

    const [newRun] = await db.select().from(syncRuns).where(eq(syncRuns.id, summary.runId));
    expect(newRun?.phase).toBe(SYNC_RUN_PHASE.DONE);
  });
});
